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

type RollupGraphState = {
  cache: TransformCacheCollection;
  cssLookup: Record<string, string>;
  dependencyLoadDepth: Map<string, number>;
  load: PluginContext['load'];
  loaderKey: string;
  queuedTransforms: Map<string, Set<QueuedTransform>>;
  resolve: PluginContext['resolve'];
  resolverKey: string;
  transformQueue: Promise<void>;
};

type QueuedTransform = {
  promote: () => void;
};

let rollupGraphScopeId = 0;
const cssCachePrefix = 'wyw-in-js:css:';

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
  let cacheKey = 'wyw-in-js:0';
  let isCacheKeyVisible = true;
  const filter = createFilter(include, exclude);
  const emptyConfig = {};
  const graphStates = new WeakMap<object, RollupGraphState>();
  const fallbackCssByGraph = new WeakMap<object, Record<string, string>>();
  let publicPlugin: Plugin;

  // Rollup shallow-copies PluginContext for hooks, but preserves its resolve
  // function within one graph/watch lifecycle. The cache facade is not a safe
  // identity: Rollup may replace it when duplicate plugin names disable cache.
  const getGraphIdentity = (ctx: PluginContext): object => ctx.resolve;

  const getFallbackCss = (ctx: PluginContext): Record<string, string> => {
    const graphIdentity = getGraphIdentity(ctx);
    const existing = fallbackCssByGraph.get(graphIdentity);
    if (existing) return existing;

    const created = Object.create(null) as Record<string, string>;
    fallbackCssByGraph.set(graphIdentity, created);
    return created;
  };

  const readRollupCache = (
    ctx: PluginContext,
    id: string
  ): string | undefined => {
    try {
      const cached = ctx.cache?.get(`${cssCachePrefix}${id}`);
      return typeof cached === 'string' ? cached : undefined;
    } catch {
      // Rollup disables custom cache access for duplicate plugin names. The
      // graph-local fallback keeps that supported configuration functional.
      return undefined;
    }
  };

  const hasRollupCache = (ctx: PluginContext, id: string): boolean => {
    try {
      return Boolean(ctx.cache?.has(`${cssCachePrefix}${id}`));
    } catch {
      return false;
    }
  };

  const writeRollupCache = (
    ctx: PluginContext,
    id: string,
    cssText: string
  ): void => {
    try {
      ctx.cache?.set(`${cssCachePrefix}${id}`, cssText);
    } catch {
      // See readRollupCache: the closure fallback is authoritative when the
      // Rollup cache is unavailable for this plugin instance.
    }
  };

  const createGraphState = (ctx: PluginContext): RollupGraphState => {
    rollupGraphScopeId += 1;

    return {
      cache: new TransformCacheCollection(),
      cssLookup: Object.create(null) as Record<string, string>,
      dependencyLoadDepth: new Map(),
      load: ctx.load,
      loaderKey: `rollup:${rollupGraphScopeId}:loader`,
      queuedTransforms: new Map(),
      resolve: ctx.resolve,
      resolverKey: `rollup:${rollupGraphScopeId}:resolver`,
      transformQueue: Promise.resolve(),
    };
  };

  const disposeGraphState = (ctx: PluginContext): void => {
    const graphIdentity = getGraphIdentity(ctx);
    const state = graphStates.get(graphIdentity);
    if (!state) return;

    disposeEvalBroker(state.cache);
    graphStates.delete(graphIdentity);
  };

  const startGraph = (ctx: PluginContext): RollupGraphState => {
    disposeGraphState(ctx);
    const state = createGraphState(ctx);
    graphStates.set(getGraphIdentity(ctx), state);
    return state;
  };

  const getGraphState = (ctx: PluginContext): RollupGraphState => {
    const state = graphStates.get(getGraphIdentity(ctx));
    if (state && state.resolve === ctx.resolve && state.load === ctx.load) {
      return state;
    }

    return startGraph(ctx);
  };

  const getCss = (ctx: PluginContext, id: string): string | undefined => {
    const local = graphStates.get(getGraphIdentity(ctx))?.cssLookup[id];
    if (local !== undefined) return local;

    return readRollupCache(ctx, id) ?? getFallbackCss(ctx)[id];
  };

  const hasCss = (ctx: PluginContext, id: string): boolean =>
    graphStates.get(getGraphIdentity(ctx))?.cssLookup[id] !== undefined ||
    hasRollupCache(ctx, id) ||
    getFallbackCss(ctx)[id] !== undefined;

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

  const beginDependencyLoad = (state: RollupGraphState, id: string): void => {
    const normalized = normalizeId(id);
    state.dependencyLoadDepth.set(
      normalized,
      (state.dependencyLoadDepth.get(normalized) ?? 0) + 1
    );

    state.queuedTransforms
      .get(normalized)
      ?.forEach((queuedTransform) => queuedTransform.promote());
  };

  const endDependencyLoad = (state: RollupGraphState, id: string): void => {
    const normalized = normalizeId(id);
    const depth = state.dependencyLoadDepth.get(normalized) ?? 0;
    if (depth <= 1) {
      state.dependencyLoadDepth.delete(normalized);
      return;
    }

    state.dependencyLoadDepth.set(normalized, depth - 1);
  };

  const isDependencyLoad = (state: RollupGraphState, id: string): boolean =>
    state.dependencyLoadDepth.has(normalizeId(id));

  const runSerialized = async <T>(
    state: RollupGraphState,
    id: string,
    fn: () => Promise<T>
  ): Promise<T> => {
    if (!serializeTransform) {
      return fn();
    }

    const previous = state.transformQueue;
    let promote!: () => void;
    const promoted = new Promise<void>((resolve) => {
      promote = resolve;
    });
    const queuedTransform = { promote };
    const normalized = normalizeId(id);
    const queuedTransforms = state.queuedTransforms.get(normalized);
    if (queuedTransforms) {
      queuedTransforms.add(queuedTransform);
    } else {
      state.queuedTransforms.set(normalized, new Set([queuedTransform]));
    }

    const result = (async () => {
      await Promise.race([previous, promoted]);
      return fn();
    })();

    // A queued transform may be promoted when the active transform asks Rollup
    // to load it. Keep its queue slot behind the active transform so unrelated
    // top-level transforms still wait for both to finish.
    // eslint-disable-next-line no-param-reassign
    state.transformQueue = Promise.all([
      previous,
      result.then(
        () => undefined,
        () => undefined
      ),
    ]).then(() => undefined);

    try {
      return await result;
    } finally {
      const currentQueuedTransforms = state.queuedTransforms.get(normalized);
      currentQueuedTransforms?.delete(queuedTransform);
      if (currentQueuedTransforms?.size === 0) {
        state.queuedTransforms.delete(normalized);
      }
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

  const setCacheKeyFromPlugins = (configuredPlugins: readonly unknown[]) => {
    const pluginIndex = configuredPlugins.indexOf(publicPlugin);
    let occurrence = 0;
    for (let index = 0; index < pluginIndex; index += 1) {
      const configuredPlugin = configuredPlugins[index];
      if (
        configuredPlugin &&
        typeof configuredPlugin === 'object' &&
        'name' in configuredPlugin &&
        configuredPlugin.name === 'wyw-in-js'
      ) {
        occurrence += 1;
      }
    }

    cacheKey = `wyw-in-js:${occurrence}`;
    isCacheKeyVisible = true;
  };

  const flattenConfiguredPlugins = (
    configuredPlugins: unknown,
    flattened: unknown[] = []
  ): unknown[] => {
    if (Array.isArray(configuredPlugins)) {
      configuredPlugins.forEach((configuredPlugin) => {
        flattenConfiguredPlugins(configuredPlugin, flattened);
      });
    } else if (configuredPlugins) {
      flattened.push(configuredPlugins);
    }

    return flattened;
  };

  const containsPromisedPlugin = (configuredPlugins: unknown): boolean => {
    if (Array.isArray(configuredPlugins)) {
      return configuredPlugins.some(containsPromisedPlugin);
    }

    return Boolean(
      configuredPlugins &&
        typeof configuredPlugins === 'object' &&
        'then' in configuredPlugins &&
        typeof configuredPlugins.then === 'function'
    );
  };

  const flattenPromisedPlugins = async (
    configuredPlugins: unknown
  ): Promise<unknown[]> => {
    const resolved = await configuredPlugins;
    if (!Array.isArray(resolved)) return resolved ? [resolved] : [];

    const nested = await Promise.all(resolved.map(flattenPromisedPlugins));
    return nested.flat();
  };

  const plugin: Plugin = {
    get cacheKey() {
      return isCacheKeyVisible ? cacheKey : undefined;
    },
    name: 'wyw-in-js',
    options(inputOptions) {
      // Rollup reads cacheKey after the options hook while creating plugin
      // contexts. Use this plugin's stable occurrence within the configured
      // plugin list so a fresh factory instance can receive the previous
      // graph's cache without merging duplicate wyw-in-js plugin instances.
      if (containsPromisedPlugin(inputOptions.plugins)) {
        return flattenPromisedPlugins(inputOptions.plugins).then(
          (configuredPlugins) => {
            setCacheKeyFromPlugins(configuredPlugins);
            return inputOptions;
          }
        );
      }

      setCacheKeyFromPlugins(flattenConfiguredPlugins(inputOptions.plugins));
      return undefined;
    },
    buildStart() {
      // Rollup 1.x interprets the mere presence of cacheKey during transform
      // as opting out of its automatic transform cache. The plugin context has
      // already captured the custom cache under this key by buildStart.
      if (this.meta.rollupVersion.startsWith('1.')) {
        isCacheKeyVisible = false;
      }

      startGraph(this);
    },
    buildEnd(error) {
      const state = graphStates.get(getGraphIdentity(this));
      if (!state) return;

      if (!error) {
        // Reading or writing this.cache from transform marks that module as
        // custom-cached in Rollup. Persist CSS from the base hook context so
        // normal Rollup transform caching remains enabled across watch builds.
        Object.entries(state.cssLookup).forEach(([id, cssText]) => {
          getFallbackCss(this)[id] = cssText;
          writeRollupCache(this, id, cssText);
        });
      }

      disposeEvalBroker(state.cache);
      if (error) graphStates.delete(getGraphIdentity(this));
    },
    closeBundle() {
      disposeGraphState(this);
    },
    closeWatcher() {
      fallbackCssByGraph.delete(getGraphIdentity(this));
      disposeGraphState(this);
    },
    load(id: string) {
      return getCss(this, id);
    },
    /* eslint-disable-next-line consistent-return */
    resolveId(importee: string) {
      if (hasCss(this, importee)) return importee;
    },
    async transform(
      code: string,
      id: string
    ): Promise<{ code: string; map: Result['sourceMap'] } | undefined> {
      const state = getGraphState(this);
      const run = async () => {
        // Do not transform ignored and generated files
        if (!filter(id) || id in state.cssLookup) return;

        const log = logger.extend('rollup').extend(getFileIdx(id));

        log('init %s', id);

        // `this.load` was added after the oldest Rollup version supported by
        // this package. Without it, leave dependency loading to the transform
        // defaults instead of installing a callback that fails when invoked.
        const loadDependencyCode =
          typeof this.load === 'function'
            ? async (resolved: string) => {
                beginDependencyLoad(state, resolved);
                try {
                  const loaded = await this.load({ id: resolved });
                  const cached = state.cache.get('entrypoints', resolved);
                  if (
                    cached &&
                    'initialCode' in cached &&
                    typeof cached.initialCode === 'string'
                  ) {
                    return undefined;
                  }

                  return typeof loaded?.code === 'string'
                    ? loaded.code
                    : undefined;
                } finally {
                  endDependencyLoad(state, resolved);
                }
              }
            : undefined;

        const transformServices = {
          asyncResolveKey: state.resolverKey,
          options: {
            filename: id,
            pluginOptions: rest,
            prefixer,
            keepComments,
            preprocessor,
            root: process.cwd(),
          },
          cache: state.cache,
          emitWarning: (message: string) => this.warn(message),
          ...(loadDependencyCode
            ? { loadDependencyCode, loadDependencyCodeKey: state.loaderKey }
            : {}),
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

        state.cssLookup[filename] = cssText;

        result.code += `\nimport ${JSON.stringify(filename)};\n`;

        /* eslint-disable-next-line consistent-return */
        return { code: result.code, map: result.sourceMap };
      };

      if (isDependencyLoad(state, id)) {
        return run();
      }

      return runSerialized(state, id, run);
    },
  };

  publicPlugin = new Proxy<Plugin>(plugin, {
    get(target, prop) {
      return target[prop as keyof Plugin];
    },

    getOwnPropertyDescriptor(target, prop) {
      return Object.getOwnPropertyDescriptor(target, prop as keyof Plugin);
    },
  });

  return publicPlugin;
}
