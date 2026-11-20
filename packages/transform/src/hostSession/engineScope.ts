/**
 * The engine half of one host session: the pinned options with the facts of
 * the bundler, the evaluation cache key, the transform cache and the registry
 * share. The in-process engine and the worker of the pool run the same code.
 */
import { isFeatureEnabled, mergeOxcResolverAlias } from '@wyw-in-js/shared';
import type { OxcOptions, StrictOptions } from '@wyw-in-js/shared';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';
import { getEvalCacheKey } from '../transform/evalSession';
import {
  getWywConfigSource,
  loadWywOptions,
  reloadWywOptions,
} from '../transform/helpers/loadWywOptions';
import type { PartialOptions } from '../transform/helpers/loadWywOptions';

import { namesOf } from './output';
import {
  attachRegistryShare,
  readRegistryShare,
  resetProcessorLookups,
} from './registryShare';
import type { EngineHost, EngineResult, EngineScope, HostFile } from './types';

/** One version of the options of a scope, with what was derived from it. */
type Generation = {
  /** Read from the pinned object, so that normalization is memoized. */
  options: StrictOptions;
  optionSources: readonly string[];
  /** The plugin options as pinned; `transform()` finds `options` by them. */
  pluginOptions: PartialOptions;
  salt: string;
};

export type EngineScopeInput = {
  host: EngineHost;
  key: string;
  /**
   * The process scope of an eval runner that sessions share by name, or
   * `null` when the scope has a runner of its own.
   */
  runner: object | null;
  scope: Omit<EngineScope, 'eventEmitter'> &
    Partial<Pick<EngineScope, 'eventEmitter'>>;
};

export interface EngineScopeState {
  /** Disposes the runner of the scope, unless it is shared, and its caches. */
  close(): void;
  /** Disposes the runner of the scope, unless it is shared; caches stay. */
  disposeOwnRunner(): void;
  invalidate(files: readonly string[], extent: 'files' | 'all'): void;
  transform(callId: number, file: HostFile): Promise<EngineResult>;
}

const hasItems = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0;

/** The plugin options of a scope, without what belongs to the transform. */
const pluginOptionsOf = ({
  keepComments,
  prefixer,
  preprocessor,
  ...pluginOptions
}: EngineScope['options']): PartialOptions => pluginOptions;

/**
 * What the facts of the bundler change in the options of a scope, as loaded
 * from the plugin options and the config file. The facts only fill what the
 * user left unset there: the alias goes under the user's alias, conditions
 * and extensions go to the native resolver when it has none, and globals
 * extend the evaluation context before the user's `overrideContext` sees it.
 */
const bundlerFactsOf = (
  options: StrictOptions,
  {
    alias,
    conditions,
    extensions,
    globals,
  }: Pick<EngineScope, 'alias' | 'conditions' | 'extensions' | 'globals'>
): Partial<Pick<StrictOptions, 'oxcOptions' | 'overrideContext'>> => {
  const facts: Partial<Pick<StrictOptions, 'oxcOptions' | 'overrideContext'>> =
    {};
  let oxcOptions: OxcOptions | undefined = alias
    ? mergeOxcResolverAlias(options.oxcOptions, alias)
    : options.oxcOptions;

  const resolver = { ...oxcOptions?.resolver };
  let resolverChanged = false;
  if (
    conditions?.length &&
    !hasItems(options.conditionNames) &&
    !hasItems(resolver.conditionNames)
  ) {
    resolver.conditionNames = [...conditions];
    resolverChanged = true;
  }
  if (extensions?.length && !hasItems(resolver.extensions)) {
    resolver.extensions = [...extensions];
    resolverChanged = true;
  }
  if (resolverChanged) {
    oxcOptions = { ...oxcOptions, resolver };
  }
  if (oxcOptions !== undefined && oxcOptions !== options.oxcOptions) {
    facts.oxcOptions = oxcOptions;
  }

  if (globals) {
    const { overrideContext } = options;
    facts.overrideContext = (context, filename) => {
      const withGlobals = { ...context, ...globals };
      return overrideContext
        ? overrideContext(withGlobals, filename)
        : withGlobals;
    };
  }

  return facts;
};

// The keys are given, so the key never reads the identity of the resolver.
const unusedResolve = async (): Promise<string | null> => null;

/**
 * Opens one scope. Options load on the first transform; a failure rejects
 * that call and the calls that waited for the same load, and the next call
 * tries again.
 *
 * A change of a global input (`invalidate` with `extent: 'all'`) makes the
 * next call build a new generation of the options; calls that come while it
 * is built wait for it. When its evaluation cache key is the key of the
 * current generation, it applies at once; otherwise it waits until no call of
 * the scope is in flight, so that a call nested in a call in flight keeps the
 * key of its parent.
 */
export const createEngineScope = ({
  host,
  key,
  runner,
  scope,
}: EngineScopeInput): EngineScopeState => {
  const { keepComments, prefixer, preprocessor } = scope.options;
  const resolveKey = `${key}:resolve`;
  const loadKey = scope.load ? `${key}:load` : undefined;
  const cache = new TransformCacheCollection();
  let current: Generation | null = null;
  let next: Generation | null = null;
  let inFlight = 0;
  // Changes of global inputs asked for, and the last one a generation saw.
  let requested = 0;
  let built = 0;
  let building: Promise<void> | null = null;
  let closed = false;
  // Global inputs invalidated since the last generation was built.
  const changedGlobals = new Set<string>();

  const buildGeneration = async (): Promise<Generation> => {
    // A new object each time: normalization is memoized by identity.
    const pluginOptions = pluginOptionsOf(scope.options);
    const source = getWywConfigSource(pluginOptions);
    const optionSources = source === null ? [] : [source];
    // Before the options load and the pipeline runs, either of which can fail.
    host.optionSources(optionSources);
    // Here, not in `invalidate`: reading a config again can throw, and the
    // call that builds the generation reports it; the next call tries again.
    const configChanged =
      source !== null &&
      [...changedGlobals].some((file) => namesOf(file).includes(source));
    changedGlobals.clear();
    let options: StrictOptions;
    try {
      options = configChanged
        ? await reloadWywOptions(pluginOptions, source)
        : loadWywOptions(pluginOptions);
    } catch (error) {
      // The runtime keeps a failed evaluation of an ES module config, so the
      // next generation reads that config again.
      if (source !== null) changedGlobals.add(source);
      throw error;
    }

    // In place: the loader keeps this object for `pluginOptions`, and
    // `transform()` reads the options of each call from there. The facts go
    // after the config file, so that the file cannot drop them.
    Object.assign(options, bundlerFactsOf(options, scope));
    attachRegistryShare(options);

    return {
      options,
      optionSources,
      pluginOptions,
      salt: getEvalCacheKey(
        options,
        resolveKey,
        unusedResolve,
        undefined,
        scope.root,
        loadKey
      ),
    };
  };

  const forgetLookups = (generation: Generation | null) => {
    const share = generation && readRegistryShare(generation.options);
    if (share) resetProcessorLookups(share);
  };

  const startBuild = async (): Promise<void> => {
    const seen = requested;
    const generation = await buildGeneration();
    if (closed) {
      forgetLookups(generation);
      return;
    }

    built = seen;
    if (current === null) {
      current = generation;
    } else {
      next = generation;
    }
  };

  // One build at a time; the calls that come meanwhile wait for it.
  const waitForBuild = (): Promise<void> => {
    if (building === null) {
      building = startBuild().finally(() => {
        building = null;
      });
    }

    return building;
  };

  // Counts the call in flight in the same turn as it takes the generation.
  const generationForCall = async (): Promise<Generation> => {
    while (current === null || built < requested) {
      if (closed) {
        throw new Error(`[wyw-in-js] The engine session ${key} is closed`);
      }

      // eslint-disable-next-line no-await-in-loop
      await waitForBuild();
    }

    if (next !== null && (next.salt === current.salt || inFlight === 0)) {
      // Calls in flight keep the options and lookups they started with.
      current = next;
      next = null;
      cache.clear('all');
    }

    inFlight += 1;
    return current;
  };

  const run = async (callId: number, file: HostFile): Promise<EngineResult> => {
    const generation = await generationForCall();
    try {
      // With `globalCache` off, `transform()` keeps a cache and a runner of
      // the call, so the file must not reach the runner of the scope.
      const evalBrokerScope =
        runner !== null &&
        isFeatureEnabled(
          generation.options.features,
          'globalCache',
          file.filename
        )
          ? runner
          : null;
      const result = await transform(
        {
          asyncResolveKey: resolveKey,
          cache,
          emitWarning: (message) => host.warn(callId, message),
          ...(scope.eventEmitter ? { eventEmitter: scope.eventEmitter } : {}),
          ...(evalBrokerScope ? { evalBrokerScope } : {}),
          ...(scope.load
            ? {
                loadDependencyCode: (
                  id: string,
                  importer: string,
                  specifier: string
                ) => host.load(callId, { id, importer, specifier }),
                loadDependencyCodeKey: loadKey,
              }
            : {}),
          options: {
            filename: file.filename,
            inputSourceMap: file.inputSourceMap ?? undefined,
            keepComments,
            outputFilename: file.outputFilename,
            pluginOptions: generation.pluginOptions,
            prefixer,
            preprocessor,
            root: scope.root,
          },
        },
        file.code,
        (specifier, importer, stack) =>
          host.resolve(callId, { importer, specifier, stack })
      );

      return {
        optionSources: generation.optionSources,
        result,
        salt: generation.salt,
      };
    } finally {
      inFlight -= 1;
    }
  };

  const disposeOwnRunner = () => {
    if (runner === null) {
      disposeEvalBroker(cache);
    }
  };

  return {
    close() {
      disposeOwnRunner();
      forgetLookups(current);
      forgetLookups(next);
      closed = true;
      current = null;
      next = null;
      changedGlobals.clear();
      cache.clear('all');
    },
    disposeOwnRunner,
    invalidate(files, extent) {
      files.forEach((file) => cache.invalidateForFile(file));
      if (extent === 'all') {
        files.forEach((file) => changedGlobals.add(file));
        requested += 1;
        next = null;
      }
    },
    transform: run,
  };
};
