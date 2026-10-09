import { readFileSync } from 'fs';
import path from 'path';

import { createFilter } from '@rollup/pluginutils';
import type { FilterPattern } from '@rollup/pluginutils';
import type { BunPlugin, JavaScriptLoader, PluginBuilder } from 'bun';
import { resolveSync, Transpiler } from 'bun';

import { asyncResolveFallback, stripQueryAndHash } from '@wyw-in-js/shared';
import type {
  IFileReporterOptions,
  ParallelTransformsOption,
  PluginOptions,
  Preprocessor,
} from '@wyw-in-js/transform';
import {
  createFileReporter,
  createParallelTransforms,
  slugify,
  transform,
  TransformCacheCollection,
} from '@wyw-in-js/transform';

export type BunPluginOptions = {
  debug?: IFileReporterOptions | false | null | undefined;
  exclude?: FilterPattern;
  filter?: RegExp | string;
  include?: FilterPattern;
  keepComments?: boolean | RegExp;
  nodeModules?: boolean;
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

const nodeModulesRegex = /^(?:.*[\\/])?node_modules(?:[\\/].*)?$/;

function getLoader(filename: string): JavaScriptLoader {
  const ext = path.extname(filename);
  switch (ext) {
    case '.jsx':
      return 'jsx';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    default:
      return 'js';
  }
}

export default function wywInJS({
  debug,
  include,
  exclude,
  filter = /\.[cm]?[jt]sx?$/,
  nodeModules = false,
  transformLibraries,
  sourceMap,
  keepComments,
  parallel,
  prefixer,
  preprocessor,
  ...rest
}: BunPluginOptions = {}): BunPlugin {
  const cache = new TransformCacheCollection();
  const filterFn = createFilter(include, exclude);
  const allowNodeModules = transformLibraries ?? nodeModules;

  return {
    name: 'wyw-in-js',
    setup(build: PluginBuilder) {
      const cssLookup = new Map<string, string>();
      const emittedWarnings = new Set<string>();

      const { emitter, onDone } = createFileReporter(debug ?? false);
      const parallelTransforms = createParallelTransforms({
        onFallback: (message) => {
          // eslint-disable-next-line no-console
          console.warn(`[wyw-in-js] ${message}`);
        },
        parallel,
        unsupported: debug ? 'the `debug` option is set' : null,
      });

      const transpilers = new Map<
        JavaScriptLoader,
        InstanceType<typeof Transpiler>
      >();
      const getTranspiler = (
        loader: JavaScriptLoader
      ): InstanceType<typeof Transpiler> => {
        const cached = transpilers.get(loader);
        if (cached) {
          return cached;
        }

        const created = new Transpiler({ loader, autoImportJSX: true });
        transpilers.set(loader, created);
        return created;
      };

      const asyncResolve = async (
        what: string,
        importer: string,
        stack: string[]
      ): Promise<string | null> => {
        const specifier = stripQueryAndHash(what);
        const suffix = what.slice(specifier.length);
        try {
          return (await asyncResolveFallback(specifier, importer, stack))
            .replace(/\\/g, path.posix.sep)
            .concat(suffix);
        } catch {
          return resolveSync(specifier, importer)
            .replace(/\\/g, path.posix.sep)
            .concat(suffix);
        }
      };

      const emitWarning = (message: string) => {
        const match = message.match(/\nconfig key: (.+)\n/);
        const key = match?.[1] ?? message;
        if (emittedWarnings.has(key)) {
          return;
        }

        emittedWarnings.add(key);
        // eslint-disable-next-line no-console
        console.warn(message);
      };

      // Workers load the transform pipeline while Bun reads the entries.
      parallelTransforms?.start();
      build.onEnd(async () => {
        onDone(process.cwd());
        await parallelTransforms?.dispose();
      });

      build.onResolve({ filter: /\.wyw\.css$/ }, (args) => ({
        namespace: 'wyw-in-js',
        path: args.path,
      }));

      build.onLoad({ filter: /.*/, namespace: 'wyw-in-js' }, async (args) => {
        const contents = cssLookup.get(args.path);
        if (typeof contents === 'undefined') {
          return undefined;
        }

        return {
          contents,
          loader: 'css',
        };
      });

      const filterRegexp =
        typeof filter === 'string' ? new RegExp(filter) : filter;

      build.onLoad({ filter: filterRegexp }, async (args) => {
        if (!filterFn(args.path)) {
          return undefined;
        }

        if (!allowNodeModules && nodeModulesRegex.test(args.path)) {
          return undefined;
        }

        const rawCode = readFileSync(args.path, 'utf8');
        const loader = getLoader(args.path);
        const transpiler = getTranspiler(loader);

        const code = transpiler.transformSync(rawCode);

        const transformServices = {
          options: {
            filename: args.path,
            pluginOptions: rest,
            prefixer,
            keepComments,
            preprocessor,
            root: process.cwd(),
          },
          cache,
          emitWarning,
          eventEmitter: emitter,
        };

        const workerScope = parallelTransforms?.scope('bun', () => ({
          asyncResolveKey: 'bun',
          keepComments,
          pluginOptions: rest,
          prefixer,
          preprocessor,
          root: process.cwd(),
        }));
        const result = workerScope
          ? await workerScope.transform({
              asyncResolve,
              code,
              emitWarning,
              filename: args.path,
            })
          : await transform(transformServices, code, asyncResolve);

        const { cssText } = result;

        if (typeof cssText === 'undefined') {
          return undefined;
        }

        if (cssText === '') {
          let contents = result.code;

          if (sourceMap && result.sourceMap) {
            const map = Buffer.from(JSON.stringify(result.sourceMap)).toString(
              'base64'
            );
            contents += `\n//# sourceMappingURL=data:application/json;base64,${map}`;
          }

          return {
            contents,
            loader,
          };
        }

        const slug = slugify(cssText);
        const cssFilename = `${args.path.replace(
          /\.[cm]?[jt]sx?$/,
          ''
        )}_${slug}.wyw.css`.replace(/\\/g, path.posix.sep);

        let nextCssText = cssText;
        let contents = `${result.code}\nimport ${JSON.stringify(
          cssFilename
        )};\n`;

        if (sourceMap && result.cssSourceMapText) {
          const map = Buffer.from(result.cssSourceMapText).toString('base64');
          nextCssText += `/*# sourceMappingURL=data:application/json;base64,${map}*/`;
        }

        if (sourceMap && result.sourceMap) {
          const map = Buffer.from(JSON.stringify(result.sourceMap)).toString(
            'base64'
          );
          contents += `//# sourceMappingURL=data:application/json;base64,${map}\n`;
        }

        cssLookup.set(cssFilename, nextCssText);

        return {
          contents,
          loader,
        };
      });
    },
  };
}
