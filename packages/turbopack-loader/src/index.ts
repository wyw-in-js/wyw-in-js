import fs from 'fs';
import path from 'path';

import type { LoaderContext, RawLoaderDefinitionFunction } from 'webpack';

import {
  logger,
  normalizeInputSourceMap,
  stripQueryAndHash,
  WYW_CSS_MODULE_EXTENSION,
  WYW_CSS_OUTPUT_QUERY,
} from '@wyw-in-js/shared';
import type {
  DependencyResolution,
  PluginOptions,
  Result,
} from '@wyw-in-js/transform';
import { transform, TransformCacheCollection } from '@wyw-in-js/transform';

import { makeCssModuleGlobalWithLineDeltas } from './css-modules';
import { writeFileIfChanged } from './file-utils';
import { insertImportStatement } from './insert-import';
import { remapSourceMapLines } from './source-map';

export type LoaderOptions = {
  cssOutputMode?: 'sidecar' | 'query';
  keepComments?: boolean;
  outputCss?: boolean;
  prefixer?: boolean;
  /**
   * Reuse transform and eval state across loader invocations which are known
   * to have identical transform and eval semantics. Every output-affecting
   * option, alias, condition, and compilation graph must match. Keys are kept
   * for the loader module's lifetime, so use a finite, stable set of values.
   */
  resolverScopeKey?: string;
  sourceMap?: boolean;
} & Partial<PluginOptions>;

type Loader = RawLoaderDefinitionFunction<LoaderOptions>;
type ResolveFn = ReturnType<LoaderContext<LoaderOptions>['getResolve']>;

type TransformScope = {
  asyncResolveKey: string;
  cache: TransformCacheCollection;
};

let resolverScopeId = 0;
const sharedResolverScopes = new Map<string, TransformScope>();

// Turbopack exposes a fresh resolver closure for every loader call, but no
// compiler/compilation identity. Keep the expensive child process alive at
// this module's lifetime while the transform package isolates each semantic
// resolver session inside that process.
const evalBrokerScope = {};

const createTransformScope = (): TransformScope => {
  resolverScopeId += 1;
  return {
    asyncResolveKey: `turbopack:${resolverScopeId}`,
    cache: new TransformCacheCollection(),
  };
};

const getTransformScope = (scopeKey: string | undefined) => {
  if (scopeKey === undefined) {
    return createTransformScope();
  }

  const cached = sharedResolverScopes.get(scopeKey);
  if (cached) {
    return cached;
  }

  const scope = createTransformScope();
  sharedResolverScopes.set(scopeKey, scope);
  return scope;
};

async function resolveWith(
  resolve: ResolveFn,
  context: string,
  request: string
): Promise<string | false> {
  type ResolveCallback = (
    ctx: string,
    req: string,
    cb: (err: Error | null, result?: string) => void
  ) => void;
  type ResolveAsync = (ctx: string, req: string) => Promise<string | false>;

  if (typeof resolve !== 'function') return false;

  if (resolve.length >= 3) {
    return new Promise((ok, fail) => {
      (resolve as unknown as ResolveCallback)(
        context,
        request,
        (err, result) => {
          if (err) fail(err);
          else ok(result ?? false);
        }
      );
    });
  }

  return (resolve as unknown as ResolveAsync)(context, request);
}

const turbopackLoader: Loader = function turbopackLoader(
  content,
  inputSourceMap
) {
  const callbackFromAsync =
    typeof this.async === 'function' ? this.async() : undefined;
  const callback =
    typeof callbackFromAsync === 'function' ? callbackFromAsync : this.callback;

  if (typeof callback !== 'function') {
    throw new Error('Async loader callback is not available');
  }

  logger('turbopack-loader %s', this.resourcePath);

  const {
    sourceMap,
    keepComments,
    outputCss,
    cssOutputMode = 'sidecar',
    prefixer,
    resolverScopeKey,
    configFile,
    ...rest
  } = this.getOptions() || {};

  if (
    resolverScopeKey !== undefined &&
    (typeof resolverScopeKey !== 'string' || resolverScopeKey.length === 0)
  ) {
    callback(new Error('resolverScopeKey must be a non-empty string'));
    return;
  }

  if (configFile) {
    const configPath = path.isAbsolute(configFile)
      ? configFile
      : path.join(process.cwd(), configFile);
    this.addDependency(configPath);
  }

  const cssFileName = `${path.basename(
    this.resourcePath,
    path.extname(this.resourcePath)
  )}${WYW_CSS_MODULE_EXTENSION}`;
  const cssFilePath = path.join(path.dirname(this.resourcePath), cssFileName);
  const cssImportPath = `./${cssFileName}`;

  const resolveModule = this.getResolve({ dependencyType: 'esm' });

  const asyncResolve = async (token: string, importer: string) => {
    const importerPath = stripQueryAndHash(importer);
    const context = path.isAbsolute(importerPath)
      ? path.dirname(importerPath)
      : path.join(process.cwd(), path.dirname(importerPath));

    const result = await resolveWith(resolveModule, context, token);

    if (!result) {
      throw new Error(`Cannot resolve ${token} from ${context}`);
    }

    const filePath = stripQueryAndHash(result);
    if (path.isAbsolute(filePath)) {
      this.addDependency(filePath);
    }

    return result;
  };

  const transformScope = getTransformScope(resolverScopeKey);

  const addResolvedDependency = async (
    dependency: string,
    dependencyResolutions: ReadonlyMap<string, string>
  ) => {
    const resolved = dependencyResolutions.get(dependency);
    if (resolved) {
      const filePath = stripQueryAndHash(resolved);
      if (path.isAbsolute(filePath)) {
        this.addDependency(filePath);
        return;
      }
    }

    await asyncResolve(dependency, this.resourcePath);
  };

  const transformServices = {
    options: {
      filename: this.resourcePath,
      inputSourceMap: normalizeInputSourceMap(
        inputSourceMap,
        this.resourcePath
      ),
      pluginOptions: { configFile, ...rest },
      prefixer,
      keepComments,
      root: process.cwd(),
    },
    asyncResolveKey: transformScope.asyncResolveKey,
    cache: transformScope.cache,
    evalBrokerScope,
    emitWarning: (message: string) => {
      if (typeof this.emitWarning === 'function') {
        const warning = new Error(message);
        delete warning.stack;
        this.emitWarning(warning);
      }
    },
  };

  transform(transformServices, content.toString(), asyncResolve)
    .then(async (result: Result) => {
      const rawCssText = result.cssText ?? '';

      if (rawCssText.trim()) {
        const { css, lineDeltas } =
          makeCssModuleGlobalWithLineDeltas(rawCssText);
        let cssText = css;
        const dependencyResolutions = new Map(
          (result.dependencyResolutions ?? []).map(
            ({ resolved, source }: DependencyResolution) => [source, resolved]
          )
        );

        const cssSourceMapText =
          sourceMap && result.cssSourceMapText
            ? await remapSourceMapLines(result.cssSourceMapText, lineDeltas)
            : undefined;

        await Promise.all(
          (result.dependencies ?? []).map((dep) =>
            addResolvedDependency(dep, dependencyResolutions)
          )
        );

        // Turbopack only picks up a CSS source map returned by the loader; it
        // does not read `sourceMappingURL` comments out of CSS.
        if (outputCss) {
          callback(null, cssText, cssSourceMapText);
          return;
        }

        if (cssSourceMapText !== undefined) {
          cssText += `\n/*# sourceMappingURL=data:application/json;base64,${Buffer.from(
            cssSourceMapText
          ).toString('base64')}*/\n`;
        }

        let importPath = cssImportPath;
        if (cssOutputMode === 'query') {
          importPath = `./${path.basename(
            this.resourcePath
          )}?${WYW_CSS_OUTPUT_QUERY}`;
        } else {
          writeFileIfChanged(cssFilePath, cssText);
        }

        const importStatement = `import ${JSON.stringify(importPath)};`;
        const finalCode = insertImportStatement(result.code, importStatement);

        callback(null, finalCode, result.sourceMap ?? undefined);
        return;
      }

      if (outputCss) {
        callback(null, '');
        return;
      }

      if (cssOutputMode !== 'query' && fs.existsSync(cssFilePath)) {
        writeFileIfChanged(cssFilePath, '');
      }

      callback(null, result.code, result.sourceMap ?? undefined);
    })
    .catch((err: Error) => callback(err));
};

export default turbopackLoader;
