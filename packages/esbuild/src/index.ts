/**
 * This file contains an esbuild loader for wyw-in-js.
 * It uses the transform.ts function to generate class names from source code,
 * returns transformed code without template literals and attaches generated source maps
 */

import { readFileSync } from 'fs';
import { dirname, isAbsolute, join, parse, posix } from 'path';

import type { Plugin, TransformOptions, Loader } from 'esbuild';
import { transformSync as esbuildTransformSync } from 'esbuild';
import {
  transformSync as oxcTransformSync,
  type TransformOptions as OxcTransformOptions,
} from 'oxc-transform';

import type {
  ParallelTransformsOption,
  PluginOptions,
  Preprocessor,
  IFileReporterOptions,
} from '@wyw-in-js/transform';
import {
  createParallelTransforms,
  disposeEvalBroker,
  slugify,
  transform,
  TransformCacheCollection,
  createFileReporter,
  loadWywOptions,
} from '@wyw-in-js/transform';
import {
  asyncResolverFactory,
  mergeOxcResolverAlias,
  toNativeResolverAlias,
} from '@wyw-in-js/shared';

type EsbuildPluginOptions = {
  debug?: IFileReporterOptions | false | null | undefined;
  esbuildOptions?: TransformOptions;
  filter?: RegExp | string;
  keepComments?: boolean | RegExp;
  oxcTransform?: boolean;
  /**
   * Run transforms in worker threads: `true` uses up to four workers, a number
   * sets the count. Function options must be defined in a wyw-in-js config file.
   */
  parallel?: ParallelTransformsOption;
  prefixer?: boolean;
  preprocessor?: Preprocessor;
  sourceMap?: boolean;
  transformLibraries?: boolean;
} & Partial<PluginOptions>;

const supportedFilterFlags = new Set(['i', 'm', 's']);

const nodeModulesRegex = /^(?:.*[\\/])?node_modules(?:[\\/].*)?$/;

export default function wywInJS({
  debug,
  sourceMap,
  keepComments,
  oxcTransform,
  parallel,
  prefixer,
  preprocessor,
  esbuildOptions,
  filter = /\.(js|jsx|ts|tsx)$/,
  transformLibraries,
  ...rest
}: EsbuildPluginOptions = {}): Plugin {
  let options = esbuildOptions;
  const cache = new TransformCacheCollection();
  const shouldRunOxcTransform = oxcTransform ?? false;
  const resolvedWywOptions = shouldRunOxcTransform
    ? loadWywOptions(rest)
    : null;
  const createAsyncResolver = asyncResolverFactory(
    async (
      resolved: {
        errors: unknown[];
        path: string;
      },
      token: string
    ): Promise<string> => {
      if (resolved.errors.length > 0) {
        throw new Error(`Cannot resolve ${token}`);
      }

      return resolved.path.replace(/\\/g, posix.sep);
    },
    (what, importer) => [
      what,
      {
        resolveDir: isAbsolute(importer)
          ? dirname(importer)
          : join(process.cwd(), dirname(importer)),
        kind: 'import-statement',
      },
    ]
  );
  return {
    name: 'wyw-in-js',
    setup(build) {
      const cssLookup = new Map<string, string>();
      const cssResolveDirs = new Map<string, string>();
      const warnedFilters = new Set<string>();
      let warnedEmptyOxcOptions = false;
      const nativeResolverAlias = toNativeResolverAlias(
        build.initialOptions.alias
      );
      // One object per build: transform() memoizes options by identity.
      const pluginOptions = {
        ...rest,
        oxcOptions: mergeOxcResolverAlias(rest.oxcOptions, nativeResolverAlias),
      };

      const { emitter, onDone } = createFileReporter(debug ?? false);
      const parallelTransforms = createParallelTransforms({
        onFallback: (message) => {
          // eslint-disable-next-line no-console
          console.warn(`[wyw-in-js] ${message}`);
        },
        parallel,
        unsupported: debug ? 'the `debug` option is set' : null,
      });

      const warnOnUnsupportedFlags = (
        filterRegexp: RegExp,
        removedFlags: string,
        sanitizedFlags: string
      ) => {
        const key = `${filterRegexp.source}/${filterRegexp.flags}`;
        if (warnedFilters.has(key)) {
          return;
        }
        warnedFilters.add(key);
        const nextFlags = sanitizedFlags || 'none';
        // eslint-disable-next-line no-console
        console.warn(
          `[wyw-in-js] Ignoring unsupported RegExp flags "${removedFlags}" ` +
            `in esbuild filter /${filterRegexp.source}/${filterRegexp.flags}. ` +
            `Using flags "${nextFlags}".`
        );
      };

      const sanitizeFilter = (filterRegexp: RegExp): RegExp => {
        const { flags } = filterRegexp;
        const sanitizedFlags = flags
          .split('')
          .filter((flag) => supportedFilterFlags.has(flag))
          .join('');
        if (sanitizedFlags === flags) {
          return filterRegexp;
        }
        const removedFlags = flags
          .split('')
          .filter((flag) => !supportedFilterFlags.has(flag))
          .join('');
        warnOnUnsupportedFlags(filterRegexp, removedFlags, sanitizedFlags);
        return new RegExp(filterRegexp.source, sanitizedFlags);
      };

      const getOxcLang = (loader: Loader): OxcTransformOptions['lang'] => {
        if (loader === 'tsx') return 'tsx';
        if (loader === 'ts') return 'ts';
        if (loader === 'jsx') return 'jsx';
        return 'js';
      };

      const asyncResolve = createAsyncResolver(build.resolve);

      // esbuild before 0.18 has no onDispose: stop the workers after a build.
      const disposable = build as typeof build & {
        onDispose?: (callback: () => void) => void;
      };
      const canDispose = typeof disposable.onDispose === 'function';
      if (parallelTransforms) {
        // Workers load the transform pipeline while esbuild reads the entries.
        build.onStart(() => parallelTransforms.start());
      }
      build.onEnd(async () => {
        onDone(process.cwd());
        disposeEvalBroker(cache);
        if (canDispose) parallelTransforms?.disposeEvalBrokers();
        else await parallelTransforms?.dispose();
      });
      disposable.onDispose?.(() => {
        parallelTransforms?.dispose();
      });

      build.onResolve({ filter: /\.wyw\.css$/ }, (args) => {
        return {
          namespace: 'wyw-in-js',
          path: args.path,
        };
      });

      build.onLoad({ filter: /.*/, namespace: 'wyw-in-js' }, (args) => {
        return {
          contents: cssLookup.get(args.path),
          loader: 'css',
          resolveDir: cssResolveDirs.get(args.path),
        };
      });

      const filterRegexp =
        typeof filter === 'string'
          ? new RegExp(filter)
          : sanitizeFilter(filter);

      build.onLoad({ filter: filterRegexp }, async (args) => {
        const rawCode = readFileSync(args.path, 'utf8');
        const { ext, name: filename } = parse(args.path);
        const loader = ext.replace(/^\./, '') as Loader;

        if (!transformLibraries && nodeModulesRegex.test(args.path)) {
          return {
            loader,
            contents: rawCode,
          };
        }

        if (!options) {
          options = {};
          if ('jsx' in build.initialOptions) {
            options.jsx = build.initialOptions.jsx;
          }
          if ('jsxFactory' in build.initialOptions) {
            options.jsxFactory = build.initialOptions.jsxFactory;
          }
          if ('jsxFragment' in build.initialOptions) {
            options.jsxFragment = build.initialOptions.jsxFragment;
          }
          if ('jsxImportSource' in build.initialOptions) {
            options.jsxImportSource = build.initialOptions.jsxImportSource;
          }
          if ('jsxDev' in build.initialOptions) {
            options.jsxDev = build.initialOptions.jsxDev;
          }
          if ('jsxSideEffects' in build.initialOptions) {
            options.jsxSideEffects = build.initialOptions.jsxSideEffects;
          }
        }

        let codeForEsbuild = rawCode;
        if (shouldRunOxcTransform) {
          if (!resolvedWywOptions) {
            throw new Error(
              '[wyw-in-js] Internal error: oxcTransform is enabled but WyW options are not initialized'
            );
          }

          const transformOptions = resolvedWywOptions.oxcOptions.transform as
            | OxcTransformOptions
            | undefined;
          if (!transformOptions || !Object.keys(transformOptions).length) {
            if (!warnedEmptyOxcOptions) {
              warnedEmptyOxcOptions = true;
              // eslint-disable-next-line no-console
              console.warn(
                '[wyw-in-js] oxcTransform is enabled but oxcOptions.transform is empty; skipping Oxc transform.'
              );
            }
          } else {
            let oxcResult;
            try {
              oxcResult = oxcTransformSync(args.path, codeForEsbuild, {
                cwd: process.cwd(),
                lang: getOxcLang(loader),
                sourceType: 'module',
                sourcemap: sourceMap,
                ...transformOptions,
              });
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              throw new Error(
                `[wyw-in-js] Oxc transform failed for ${args.path}: ${message}`
              );
            }

            if (oxcResult.errors.length > 0) {
              const details = oxcResult.errors
                .map((error) =>
                  error.codeframe
                    ? `${error.message}\n${error.codeframe}`
                    : error.message
                )
                .join('\n');
              throw new Error(
                `[wyw-in-js] Oxc transform failed for ${args.path}: ${details}`
              );
            }

            codeForEsbuild = oxcResult.code;

            if (sourceMap && oxcResult.map) {
              const oxcMap = Buffer.from(
                JSON.stringify(oxcResult.map)
              ).toString('base64');
              codeForEsbuild += `/*# sourceMappingURL=data:application/json;base64,${oxcMap}*/`;
            }
          }
        }

        const transformed = esbuildTransformSync(codeForEsbuild, {
          ...options,
          sourcefile: args.path,
          sourcemap: sourceMap,
          loader,
        });
        let { code } = transformed;

        if (sourceMap) {
          const esbuildMap = Buffer.from(transformed.map).toString('base64');
          code += `/*# sourceMappingURL=data:application/json;base64,${esbuildMap}*/`;
        }

        const transformServices = {
          options: {
            filename: args.path,
            pluginOptions,
            prefixer,
            keepComments,
            preprocessor,
            root: process.cwd(),
          },
          cache,
          eventEmitter: emitter,
        };

        const workerScope = parallelTransforms?.scope('esbuild', () => ({
          asyncResolveKey: 'esbuild',
          keepComments,
          pluginOptions,
          prefixer,
          preprocessor,
          root: process.cwd(),
        }));
        const result = workerScope
          ? await workerScope.transform({
              asyncResolve,
              code,
              filename: args.path,
            })
          : await transform(transformServices, code, asyncResolve);
        const resolveDir = dirname(args.path);

        if (typeof result.cssText === 'undefined') {
          return {
            contents: code,
            loader,
            resolveDir,
          };
        }

        if (result.cssText === '') {
          let contents = result.code;

          if (sourceMap && result.sourceMap) {
            const wywMap = Buffer.from(
              JSON.stringify(result.sourceMap)
            ).toString('base64');
            contents += `/*# sourceMappingURL=data:application/json;base64,${wywMap}*/`;
          }

          return {
            contents,
            loader,
            resolveDir,
          };
        }

        let { cssText } = result;

        const slug = slugify(cssText);
        const cssFilename = `${filename}_${slug}.wyw.css`;

        let contents = `import ${JSON.stringify(cssFilename)}; ${result.code}`;

        if (sourceMap && result.cssSourceMapText) {
          const map = Buffer.from(result.cssSourceMapText).toString('base64');
          cssText += `/*# sourceMappingURL=data:application/json;base64,${map}*/`;
          const wywMap = Buffer.from(JSON.stringify(result.sourceMap)).toString(
            'base64'
          );
          contents += `/*# sourceMappingURL=data:application/json;base64,${wywMap}*/`;
        }

        cssLookup.set(cssFilename, cssText);
        cssResolveDirs.set(cssFilename, resolveDir);

        return {
          contents,
          loader,
          resolveDir,
        };
      });
    },
  };
}
