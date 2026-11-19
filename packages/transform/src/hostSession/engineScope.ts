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
  forgetWywConfigFile,
  getWywConfigSource,
  loadWywOptions,
} from '../transform/helpers/loadWywOptions';
import type { PartialOptions } from '../transform/helpers/loadWywOptions';

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
  /** The plugin options as pinned; `transform()` normalizes them again. */
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

/**
 * The plugin options of a scope with the facts of its bundler, which only
 * fill what the user left unset: the alias goes under the user's alias,
 * conditions and extensions go to the native resolver when it has none, and
 * globals extend the evaluation context before `overrideContext` sees it.
 */
export const pinPluginOptions = ({
  alias,
  conditions,
  extensions,
  globals,
  options,
}: Pick<
  EngineScope,
  'alias' | 'conditions' | 'extensions' | 'globals' | 'options'
>): PartialOptions => {
  // These belong to the transform, not to the plugin options.
  const { keepComments, prefixer, preprocessor, ...pluginOptions } = options;
  let oxcOptions: OxcOptions | undefined = alias
    ? mergeOxcResolverAlias(pluginOptions.oxcOptions, alias)
    : pluginOptions.oxcOptions;

  const resolver = { ...oxcOptions?.resolver };
  let resolverChanged = false;
  if (
    conditions?.length &&
    !hasItems(pluginOptions.conditionNames) &&
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

  const pinned: PartialOptions = { ...pluginOptions };
  if (oxcOptions !== undefined) {
    pinned.oxcOptions = oxcOptions;
  }

  if (globals) {
    const { overrideContext } = pluginOptions;
    pinned.overrideContext = (context, filename) => {
      const withGlobals = { ...context, ...globals };
      return overrideContext
        ? overrideContext(withGlobals, filename)
        : withGlobals;
    };
  }

  return pinned;
};

// The keys are given, so the key never reads the identity of the resolver.
const unusedResolve = async (): Promise<string | null> => null;

/**
 * Opens one scope. Options load on the first transform; a failure rejects
 * that call, and the next call tries again.
 *
 * A change of a global input (`invalidate` with `extent: 'all'`) makes the
 * next call build a new generation of the options. When its evaluation cache
 * key is the key of the current generation, it applies at once; otherwise it
 * waits until no call of the scope is in flight, so that a call nested in a
 * call in flight keeps the key of its parent.
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
  let reload = false;
  let inFlight = 0;
  // Global inputs invalidated since the last generation was built.
  const changedGlobals = new Set<string>();

  const buildGeneration = (): Generation => {
    // Here, not in `invalidate`: reading a config again can throw, and the
    // call that builds the generation reports it.
    changedGlobals.forEach((file) => forgetWywConfigFile(file));
    changedGlobals.clear();
    // A new object each time: normalization is memoized by identity.
    const pluginOptions = pinPluginOptions(scope);
    const options = loadWywOptions(pluginOptions);
    attachRegistryShare(options);
    const source = getWywConfigSource(pluginOptions);

    return {
      options,
      optionSources: source === null ? [] : [source],
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

  const generationForCall = (): Generation => {
    if (current === null) {
      current = buildGeneration();
      reload = false;
      return current;
    }

    if (reload) {
      next = buildGeneration();
      reload = false;
    }

    if (next !== null && (next.salt === current.salt || inFlight === 0)) {
      // Calls in flight keep the options and lookups they started with.
      current = next;
      next = null;
      cache.clear('all');
    }

    return current;
  };

  const run = async (callId: number, file: HostFile): Promise<EngineResult> => {
    const generation = generationForCall();
    // With `globalCache` off, `transform()` keeps a cache and a runner of the
    // call, so the file must not reach the runner of the scope.
    const evalBrokerScope =
      runner !== null &&
      isFeatureEnabled(
        generation.options.features,
        'globalCache',
        file.filename
      )
        ? runner
        : null;

    inFlight += 1;
    try {
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
        reload = true;
        next = null;
      }
    },
    transform: run,
  };
};
