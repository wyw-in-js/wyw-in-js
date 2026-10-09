/**
 * This file contains a Webpack loader for WYW-in-JS.
 * It uses the transform.ts function to generate class names from source code,
 * returns transformed code without template literals and attaches generated source maps
 */

import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import type { RawSourceMap } from 'source-map';
import type { Compiler, RawLoaderDefinitionFunction, Stats } from 'webpack';

import {
  logger,
  mergeOxcResolverAlias,
  toNativeResolverAlias,
} from '@wyw-in-js/shared';
import type {
  ParallelTransforms,
  ParallelTransformsOption,
  PluginOptions,
  Preprocessor,
  Result,
  TransformWorkerScope,
} from '@wyw-in-js/transform';
import {
  createParallelTransforms,
  disposeEvalBroker,
  transform,
  TransformCacheCollection,
} from '@wyw-in-js/transform';

import { sharedState } from './WYWinJSDebugPlugin';
import type { ICache } from './cache';
import {
  clearCacheProviderRegistry,
  encodeOutputCssPayload,
  getCacheInstance,
  registerCacheProvider,
  toCacheKey,
  toWebpackRequestPath,
} from './cache';

export { WYWinJSDebugPlugin } from './WYWinJSDebugPlugin';

const outputCssLoader = toWebpackRequestPath(
  fileURLToPath(new URL('./outputCssLoader.js', import.meta.url))
);

const stripQueryAndHash = (request: string) => {
  const queryIdx = request.indexOf('?');
  const hashIdx = request.indexOf('#');

  if (queryIdx === -1) {
    return hashIdx === -1 ? request : request.slice(0, hashIdx);
  }
  if (hashIdx === -1) return request.slice(0, queryIdx);

  return request.slice(0, Math.min(queryIdx, hashIdx));
};

const hashText = (text: string): string =>
  crypto.createHash('sha256').update(text).digest('hex');

export type LoaderOptions = {
  cacheProvider?: string | ICache;
  cssImport?: 'require' | 'import';
  extension?: string;
  keepComments?: boolean | RegExp;
  /**
   * Run transforms in worker threads shared by all modules of a compiler:
   * `true` uses up to four workers, a number sets the count. Function options
   * must be defined in a wyw-in-js config file.
   */
  parallel?: ParallelTransformsOption;
  prefixer?: boolean;
  preprocessor?: Preprocessor;
  sourceMap?: boolean;
} & Partial<PluginOptions>;
type Loader = RawLoaderDefinitionFunction<LoaderOptions>;

type Resolver = (
  what: string,
  importer: string,
  stack?: string[]
) => Promise<string>;

type WarningEmitter = (message: string) => void;

type DoneHook = {
  tap: (name: string, handler: (stats: Stats) => void) => void;
};

type VoidHook = {
  tap: (name: string, handler: () => void) => void;
};

type FailedHook = {
  tap: (name: string, handler: (error: Error) => void) => void;
};

type CompilerHooks = {
  done?: DoneHook;
  failed?: FailedHook;
  shutdown?: VoidHook;
  watchClose?: VoidHook;
};

type CompilerLike = Compiler & {
  hooks: CompilerHooks;
};

type LoaderContextWithCompiler = {
  _compiler?: CompilerLike;
};

const hasCompilerHooks = (
  compiler: CompilerLike | undefined
): compiler is CompilerLike => {
  const hooks = compiler?.hooks;
  return Boolean(
    hooks &&
      [hooks.done, hooks.failed, hooks.shutdown, hooks.watchClose].some(
        (hook) => typeof hook?.tap === 'function'
      )
  );
};

type ResolverScope = {
  asyncResolve: Resolver;
  cache: TransformCacheCollection;
  dispose: () => void;
  emitWarning: (resourcePath: string, message: string) => void;
  key: string;
  replaceResolver: (resourcePath: string, resolver: Resolver) => void;
  replaceWarningEmitter: (
    resourcePath: string,
    emitWarning: WarningEmitter
  ) => void;
};

type CompilerState = ResolverScope & {
  clearResolvers: () => void;
  hooksInstalled: boolean;
  /** Worker scopes this compiler created in the shared pool. */
  workerScopeKeys: Set<string>;
};

const COMPILER_SCOPE_NAME = 'WYWinJSResolverScope';
let compilerScopeId = 0;
const compilerStates = new WeakMap<CompilerLike, CompilerState>();

const getResolverKey = (importer: string, stack: string[]): string => {
  const root = stack.length ? stack[stack.length - 1] : importer;
  return stripQueryAndHash(root);
};

const createResolverScope = (): ResolverScope => {
  const resolvers = new Map<string, Resolver>();
  const warningEmitters = new Map<string, WarningEmitter>();
  compilerScopeId += 1;
  const key = `webpack:${compilerScopeId}`;

  return {
    asyncResolve: (
      what: string,
      importer: string,
      stack: string[] = [importer]
    ): Promise<string> => {
      const resolverKeys = [
        getResolverKey(importer, stack),
        stripQueryAndHash(importer),
      ].filter((candidate, idx, all) => all.indexOf(candidate) === idx);

      const selectedResolvers = resolverKeys
        .map((resolverKey) => resolvers.get(resolverKey))
        .filter((resolver): resolver is Resolver => Boolean(resolver));

      if (selectedResolvers.length === 0) {
        throw new Error('No resolver found');
      }

      // Root and importer resolver side effects both matter for dependency
      // tracking, so keep them aligned and verify they agree on the answer.
      return Promise.all(
        selectedResolvers.map((resolver) => resolver(what, importer, stack))
      ).then((results) => {
        const firstResult = results[0];
        if (results.some((result) => result !== firstResult)) {
          throw new Error('Resolvers returned different results');
        }

        return firstResult;
      });
    },
    cache: new TransformCacheCollection(),
    dispose: () => {
      resolvers.clear();
      warningEmitters.clear();
    },
    emitWarning: (resourcePath: string, message: string) => {
      warningEmitters.get(stripQueryAndHash(resourcePath))?.(message);
    },
    key,
    replaceResolver: (resourcePath: string, resolver: Resolver) => {
      resolvers.set(stripQueryAndHash(resourcePath), resolver);
    },
    replaceWarningEmitter: (
      resourcePath: string,
      emitWarning: WarningEmitter
    ) => {
      warningEmitters.set(stripQueryAndHash(resourcePath), emitWarning);
    },
  };
};

// Compilers of one process (e.g. the client and server builds of Next.js)
// share one worker pool; each compiler gets its own scopes in it.
let parallelTransforms: ParallelTransforms | null | undefined;
const parallelCompilers = new Set<CompilerLike>();

const getParallelTransforms = (
  compiler: CompilerLike,
  parallel: ParallelTransformsOption
): ParallelTransforms | null => {
  if (parallelTransforms === undefined) {
    const infrastructureLogger =
      compiler.getInfrastructureLogger?.('wyw-in-js');
    parallelTransforms = createParallelTransforms({
      onFallback: (message) => {
        if (infrastructureLogger) infrastructureLogger.warn(message);
        // eslint-disable-next-line no-console
        else console.warn(`[wyw-in-js] ${message}`);
      },
      parallel,
      unsupported: sharedState.emitter ? 'WYWinJSDebugPlugin is enabled' : null,
    });
  }

  parallelCompilers.add(compiler);
  return parallelTransforms;
};

const releaseParallelTransforms = (
  compiler: CompilerLike,
  state: CompilerState
) => {
  if (!parallelCompilers.delete(compiler)) return;
  state.workerScopeKeys.forEach((key) => parallelTransforms?.disposeScope(key));
  state.workerScopeKeys.clear();
  if (parallelCompilers.size === 0) {
    parallelTransforms?.dispose();
    parallelTransforms = undefined;
  }
};

const disposeCompilerState = (compiler: CompilerLike, state: CompilerState) => {
  state.clearResolvers();
  disposeEvalBroker(state.cache);
  releaseParallelTransforms(compiler, state);
  clearCacheProviderRegistry(compiler);
};

// Loader options become worker scopes; equal options share one scope.
const getScopeKey = (options: object): string =>
  JSON.stringify(options, (_, value) =>
    value instanceof RegExp ? `${value}` : value
  );

const getCompilerState = (compiler: CompilerLike): CompilerState => {
  const cached = compilerStates.get(compiler);
  if (cached) {
    return cached;
  }

  // Resolver identity must stay stable across files within one compiler or we
  // churn both the shared transform cache salt and the eval broker/runner.
  const scope = createResolverScope();
  const state: CompilerState = {
    ...scope,
    clearResolvers: scope.dispose,
    dispose: () => disposeCompilerState(compiler, state),
    hooksInstalled: false,
    workerScopeKeys: new Set(),
  };

  const installHooks = () => {
    if (state.hooksInstalled) return;
    state.hooksInstalled = true;

    compiler.hooks.done?.tap(COMPILER_SCOPE_NAME, () => {
      state.clearResolvers();
    });
    compiler.hooks.failed?.tap(COMPILER_SCOPE_NAME, () => {
      state.clearResolvers();
    });
    compiler.hooks.watchClose?.tap(COMPILER_SCOPE_NAME, () => {
      state.dispose();
      compilerStates.delete(compiler);
    });
    compiler.hooks.shutdown?.tap(COMPILER_SCOPE_NAME, () => {
      state.dispose();
      compilerStates.delete(compiler);
    });
  };

  installHooks();
  compilerStates.set(compiler, state);
  return state;
};

const createInvocationScope = (): ResolverScope => {
  const scope = createResolverScope();
  return {
    ...scope,
    dispose: () => {
      scope.dispose();
      disposeEvalBroker(scope.cache);
    },
  };
};

const createWarningDispatcher =
  (scope: ResolverScope, resourcePath: string): WarningEmitter =>
  (message: string) =>
    scope.emitWarning(resourcePath, message);

const webpack5Loader: Loader = function webpack5LoaderPlugin(
  content,
  inputSourceMap
) {
  function convertSourceMap(
    value: typeof inputSourceMap,
    filename: string
  ): RawSourceMap | undefined {
    if (typeof value === 'string' || !value) {
      return undefined;
    }

    return {
      ...value,
      file: value.file ?? filename,
      mappings: value.mappings ?? '',
      names: value.names ?? [],
      sources: value.sources ?? [],
      version: value.version ?? 3,
    };
  }

  // tell Webpack this loader is async
  this.async();

  const resolveOptions = { dependencyType: 'esm' };

  const resolveModule: (
    context: string,
    request: string,
    callback: (err: unknown, result: unknown) => void
  ) => unknown = this.getResolve(resolveOptions);

  const isPromiseLike = (value: unknown): value is Promise<unknown> =>
    typeof (value as { then?: unknown } | null)?.then === 'function';

  const resolveModuleAsync = (context: string, request: string) =>
    new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (err: unknown, result: unknown) => {
        if (settled) return;
        settled = true;

        if (err) {
          reject(err);
          return;
        }

        if (typeof result === 'string') {
          resolve(result);
          return;
        }

        reject(new Error(`Cannot resolve ${request}`));
      };

      try {
        const maybePromise = resolveModule(context, request, finish);
        if (isPromiseLike(maybePromise)) {
          maybePromise.then(
            (result) => finish(null, result),
            (err) => finish(err, null)
          );
        }
      } catch (err) {
        finish(err, null);
      }
    });

  const { resourcePath } = this;
  const { _compiler: loaderCompiler } = this as LoaderContextWithCompiler;
  const compiler = hasCompilerHooks(loaderCompiler)
    ? loaderCompiler
    : undefined;
  const compilerScope = compiler ? getCompilerState(compiler) : null;
  const compilerState = compilerScope ?? createInvocationScope();

  // Do not let cached transform services capture the webpack loader context.
  // The per-resource callbacks below are short-lived and cleared with the
  // resolver scope when the compilation finishes.
  compilerState.replaceResolver(resourcePath, (what, importer) => {
    const importerPath = stripQueryAndHash(importer);
    const context = path.isAbsolute(importerPath)
      ? path.dirname(importerPath)
      : path.join(process.cwd(), path.dirname(importerPath));

    return resolveModuleAsync(context, what).then((result) => {
      const filePath = stripQueryAndHash(result);
      if (path.isAbsolute(filePath)) {
        this.addDependency(filePath);
      }

      return result;
    });
  });
  compilerState.replaceWarningEmitter(resourcePath, (message: string) => {
    const warning = new Error(message);
    // Remove the stack so webpack's ModuleWarning doesn't copy it into
    // `details`, which causes the message to render twice (once from
    // .message, once from .details containing "Error: <same message>").
    delete warning.stack;
    this.emitWarning(warning);
  });
  const {
    asyncResolve,
    cache: transformCache,
    key: asyncResolveKey,
  } = compilerState;
  const nativeResolverAlias = toNativeResolverAlias(
    loaderCompiler?.options?.resolve?.alias
  );

  logger('loader %s', this.resourcePath);

  const {
    sourceMap = undefined,
    preprocessor = undefined,
    keepComments = undefined,
    prefixer = undefined,
    extension = '.wyw-in-js.css',
    cssImport = 'require',
    cacheProvider,
    parallel,
    ...rest
  } = this.getOptions() || {};

  const outputFileName = this.resourcePath.replace(/\.[^.]+$/, extension);

  const pluginOptions = {
    ...rest,
    oxcOptions: mergeOxcResolverAlias(rest.oxcOptions, nativeResolverAlias),
  };
  const transformServices = {
    options: {
      filename: resourcePath,
      inputSourceMap: convertSourceMap(inputSourceMap, resourcePath),
      pluginOptions,
      prefixer,
      keepComments,
      preprocessor,
      root: process.cwd(),
    },
    asyncResolveKey,
    cache: transformCache,
    emitWarning: createWarningDispatcher(compilerState, resourcePath),
    eventEmitter: sharedState.emitter,
  };

  const scopeConfig = {
    asyncResolveKey,
    keepComments,
    pluginOptions,
    prefixer,
    preprocessor,
    root: process.cwd(),
  };
  let workerScope: TransformWorkerScope | null = null;
  if (compiler && compilerScope && parallel) {
    const key = getScopeKey(scopeConfig);
    workerScope =
      getParallelTransforms(compiler, parallel)?.scope(
        key,
        () => scopeConfig
      ) ?? null;
    if (workerScope) compilerScope.workerScopeKeys.add(key);
  }
  const transformed = workerScope
    ? Promise.resolve().then(() =>
        workerScope.transform({
          asyncResolve,
          code: content.toString(),
          emitWarning: transformServices.emitWarning,
          filename: resourcePath,
          inputSourceMap: transformServices.options.inputSourceMap,
        })
      )
    : transform(transformServices, content.toString(), asyncResolve);

  transformed
    .then(
      async (result: Result) => {
        try {
          if (result.cssText) {
            let { cssText } = result;

            if (sourceMap) {
              cssText += `/*# sourceMappingURL=data:application/json;base64,${Buffer.from(
                result.cssSourceMapText || ''
              ).toString('base64')}*/`;
            }

            await Promise.all(
              result.dependencies?.map((dep) =>
                asyncResolve(dep, resourcePath)
              ) ?? []
            );

            const cacheKey = toCacheKey(this.resourcePath);
            const cacheInstance = await getCacheInstance(
              cacheProvider,
              compiler
            );
            const currentLoader = this.loaders?.[this.loaderIndex];
            let cacheProviderToken =
              cacheProvider &&
              typeof cacheProvider === 'object' &&
              compiler &&
              currentLoader?.ident
                ? hashText(currentLoader.ident)
                : undefined;
            if (
              cacheProviderToken &&
              !registerCacheProvider(
                cacheInstance,
                cacheProviderToken,
                compiler
              )
            ) {
              // A reused ident cannot safely select between two provider
              // objects. Keep the first registration valid and make this
              // request self-contained instead.
              cacheProviderToken = undefined;
            }
            const dependencies = [...this.getDependencies()].sort();

            await cacheInstance.set(cacheKey, cssText);

            await cacheInstance.setDependencies?.(cacheKey, dependencies);

            const wywQuery = [
              `wyw=${encodeURIComponent(extension.replace(/^\./, ''))}`,
            ];

            const resourcePathWithQuery = `${toWebpackRequestPath(
              this.resourcePath
            )}?${wywQuery.join('&')}`;

            const outputLoaderQuery = new URLSearchParams();
            if (typeof cacheProvider === 'string') {
              outputLoaderQuery.set('cacheProvider', cacheProvider);
            }
            if (cacheProviderToken) {
              outputLoaderQuery.set('cacheProviderToken', cacheProviderToken);
            }
            outputLoaderQuery.set(
              'outputCssPayload',
              encodeOutputCssPayload({
                cssText: result.cssText,
                ...(sourceMap && result.cssSourceMapText
                  ? { cssSourceMapText: result.cssSourceMapText }
                  : {}),
              })
            );
            const outputLoaderOptions = outputLoaderQuery.toString();
            const outputLoaderRequest = outputLoaderOptions
              ? `${outputCssLoader}?${outputLoaderOptions}`
              : outputCssLoader;

            const request = `${toWebpackRequestPath(
              outputFileName
            )}!=!${outputLoaderRequest}!${resourcePathWithQuery}`;
            const stringifiedRequest = JSON.stringify(
              this.utils.contextify(this.context || this.rootContext, request)
            );

            const importCss =
              cssImport === 'import'
                ? `import ${stringifiedRequest};`
                : `require(${stringifiedRequest});`;

            this.callback(
              null,
              `${result.code}\n\n${importCss}`,
              result.sourceMap ?? undefined
            );

            return;
          }

          this.callback(null, result.code, result.sourceMap ?? undefined);
        } catch (err) {
          this.callback(err as Error);
        }
      },
      (err: Error) => {
        this.callback(err);
      }
    )
    .catch((err: Error) => this.callback(err))
    .finally(() => {
      if (!compiler) {
        compilerState.dispose();
      }
    });
};

export default webpack5Loader;
