/**
 * This file contains a Rollup loader for wyw-in-js.
 * It uses the transform.ts function to generate class names from source code,
 * returns transformed code without template literals and attaches generated source maps
 */

import { createFilter } from '@rollup/pluginutils';
import type { Plugin, PluginContext, ResolvedId } from 'rollup';

import {
  asyncResolverFactory,
  logger,
  slugify,
  syncResolve,
} from '@wyw-in-js/shared';
import type { PluginOptions, Preprocessor, Result } from '@wyw-in-js/transform';
import {
  disposeEvalBroker,
  getFileIdx,
  transform,
  TransformCacheCollection,
} from '@wyw-in-js/transform';

type RollupCssFilenameContext = {
  cssText: string;
  defaultFilename: string;
  id: string;
  slug: string;
};

type RollupPluginOptions = {
  cssFilename?: (context: RollupCssFilenameContext) => string;
  exclude?: string | string[];
  include?: string | string[];
  keepComments?: boolean | RegExp;
  prefixer?: boolean;
  preprocessor?: Preprocessor;
  serializeTransform?: boolean;
  sourceMap?: boolean;
} & Partial<PluginOptions>;

let rollupGraphScopeId = 0;
const rollupGraphScopeKeys = new WeakMap<PluginContext['resolve'], string>();

const getRollupGraphScopeKey = (ctx: PluginContext): string => {
  const cached = rollupGraphScopeKeys.get(ctx.resolve);
  if (cached) return cached;

  rollupGraphScopeId += 1;
  const key = `rollup:${rollupGraphScopeId}`;
  rollupGraphScopeKeys.set(ctx.resolve, key);
  return key;
};

export default function wywInJS({
  cssFilename,
  exclude,
  include,
  keepComments,
  prefixer,
  preprocessor,
  serializeTransform = true,
  sourceMap,
  ...rest
}: RollupPluginOptions = {}): Plugin {
  const filter = createFilter(include, exclude);
  const cssLookup: { [key: string]: string } = {};
  const cache = new TransformCacheCollection();
  const emptyConfig = {};
  const dependencyLoadDepth = new Map<string, number>();
  let transformQueue = Promise.resolve();

  type ResolveFn = PluginContext['resolve'];

  const boundResolveCache = new WeakMap<
    PluginContext,
    { boundResolve: ResolveFn; sourceResolve: ResolveFn }
  >();

  const getBoundResolve = (ctx: PluginContext): ResolveFn => {
    const cached = boundResolveCache.get(ctx);
    if (cached && cached.sourceResolve === ctx.resolve) {
      return cached.boundResolve;
    }

    const boundResolve: ResolveFn = ctx.resolve.bind(ctx);
    boundResolveCache.set(ctx, { sourceResolve: ctx.resolve, boundResolve });
    return boundResolve;
  };

  const normalizeId = (id: string) => id.split('?')[0].split('#')[0];

  const beginDependencyLoad = (id: string): void => {
    const normalized = normalizeId(id);
    dependencyLoadDepth.set(
      normalized,
      (dependencyLoadDepth.get(normalized) ?? 0) + 1
    );
  };

  const endDependencyLoad = (id: string): void => {
    const normalized = normalizeId(id);
    const depth = dependencyLoadDepth.get(normalized) ?? 0;
    if (depth <= 1) {
      dependencyLoadDepth.delete(normalized);
      return;
    }

    dependencyLoadDepth.set(normalized, depth - 1);
  };

  const isDependencyLoad = (id: string): boolean =>
    dependencyLoadDepth.has(normalizeId(id));

  const runSerialized = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (!serializeTransform) {
      return fn();
    }

    let release: () => void;
    const previous = transformQueue;
    transformQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await fn();
    } finally {
      release!();
    }
  };

  const createAsyncResolver = asyncResolverFactory(
    async (resolved: ResolvedId | null, what, importer, stack) => {
      if (resolved) {
        if (resolved.external) {
          // If module is marked as external, Rollup will not resolve it,
          // so we need to resolve it ourselves with default resolver
          return syncResolve(what, importer, stack);
        }

        // Vite adds param like `?v=667939b3` to cached modules
        const resolvedId = resolved.id.split('?')[0];

        if (resolvedId.startsWith('\0')) {
          // \0 is a special character in Rollup that tells Rollup to not include this in the bundle
          // https://rollupjs.org/guide/en/#outputexports
          return null;
        }

        return resolvedId;
      }

      throw new Error(`Could not resolve ${what}`);
    },
    (what, importer) => [what, importer]
  );

  const plugin: Plugin = {
    name: 'wyw-in-js',
    closeBundle() {
      disposeEvalBroker(cache);
    },
    load(id: string) {
      return cssLookup[id];
    },
    /* eslint-disable-next-line consistent-return */
    resolveId(importee: string) {
      if (importee in cssLookup) return importee;
    },
    async transform(
      code: string,
      id: string
    ): Promise<{ code: string; map: Result['sourceMap'] } | undefined> {
      const run = async () => {
        // Do not transform ignored and generated files
        if (!filter(id) || id in cssLookup) return;

        const log = logger.extend('rollup').extend(getFileIdx(id));
        const rollupGraphScopeKey = getRollupGraphScopeKey(this);

        log('init %s', id);

        const transformServices = {
          asyncResolveKey: rollupGraphScopeKey,
          loadDependencyCodeKey: rollupGraphScopeKey,
          options: {
            filename: id,
            pluginOptions: rest,
            prefixer,
            keepComments,
            preprocessor,
            root: process.cwd(),
          },
          cache,
          emitWarning: (message: string) => this.warn(message),
          loadDependencyCode: async (resolved: string) => {
            beginDependencyLoad(resolved);
            try {
              const loaded = await this.load({ id: resolved });
              const cached = cache.get('entrypoints', resolved);
              if (
                cached &&
                'initialCode' in cached &&
                typeof cached.initialCode === 'string'
              ) {
                return undefined;
              }

              return typeof loaded?.code === 'string' ? loaded.code : undefined;
            } finally {
              endDependencyLoad(resolved);
            }
          },
        };

        const result = await transform(
          transformServices,
          code,
          createAsyncResolver(getBoundResolve(this)),
          emptyConfig
        );

        if (!result.cssText) return;

        let { cssText } = result;

        const slug = slugify(cssText);
        const defaultFilename = `${id.replace(/\.[jt]sx?$/, '')}_${slug}.css`;
        const filename =
          cssFilename?.({ cssText, defaultFilename, id, slug }) ??
          defaultFilename;

        if (sourceMap && result.cssSourceMapText) {
          const map = Buffer.from(result.cssSourceMapText).toString('base64');
          cssText += `/*# sourceMappingURL=data:application/json;base64,${map}*/`;
        }

        cssLookup[filename] = cssText;

        result.code += `\nimport ${JSON.stringify(filename)};\n`;

        /* eslint-disable-next-line consistent-return */
        return { code: result.code, map: result.sourceMap };
      };

      if (isDependencyLoad(id)) {
        return run();
      }

      return runSerialized(run);
    },
  };

  return new Proxy<Plugin>(plugin, {
    get(target, prop) {
      return target[prop as keyof Plugin];
    },

    getOwnPropertyDescriptor(target, prop) {
      return Object.getOwnPropertyDescriptor(target, prop as keyof Plugin);
    },
  });
}
