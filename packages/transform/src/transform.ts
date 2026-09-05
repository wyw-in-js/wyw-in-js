/* eslint-disable no-await-in-loop, no-continue */
/**
 * This file exposes sync and async transform functions that:
 * - parse the passed code to AST
 * - builds a dependency graph for the file
 * - shakes each dependency and removes unused code
 * - runs generated code in a sandbox
 * - collects artifacts
 * - returns transformed code (without WYW template literals), generated CSS, source maps and transform metadata.
 */

import { isFeatureEnabled } from '@wyw-in-js/shared';
import { AsyncLocalStorage } from 'node:async_hooks';

import type { PartialOptions } from './transform/helpers/loadWywOptions';
import { loadWywOptions } from './transform/helpers/loadWywOptions';
import {
  CacheKeySaltBusyError,
  TransformCacheCollection,
  type TransformCacheEpoch,
} from './cache';
import {
  createActionContext,
  disposeActionContext,
} from './transform/ActionContext';
import { Entrypoint } from './transform/Entrypoint';
import { asyncActionRunner } from './transform/actions/actionRunner';
import { baseHandlers } from './transform/generators';
import { withDefaultServices } from './transform/helpers/withDefaultServices';
import type { Handlers, Services } from './transform/types';
import { configureEvalSession, getEvalCacheKey } from './transform/evalSession';
import { isCacheEpochAbortedError } from './transform/actions/CacheEpochAbortedError';
import { CacheRecoveryConvergenceError } from './transform/actions/CacheRecoveryConvergenceError';
import type { Result } from './types';
import {
  hasPipelineTelemetryReporter,
  isPipelineTelemetryActive,
  markPipelineRootStatus,
  runWithoutPipelineTelemetry,
  runWithPipelineTelemetry,
} from './debug/pipelineTelemetry';

type PartialServices = Partial<Omit<Services, 'cacheEpoch' | 'options'>> & {
  options: Omit<Services['options'], 'pluginOptions'> & {
    pluginOptions?: PartialOptions;
  };
};

type AllHandlers<TMode extends 'async' | 'sync'> = Handlers<TMode>;

const MAX_CACHE_RECOVERY_RETRIES = 3;

interface ActiveCacheKeySaltLease {
  active: boolean;
  cacheOwner: WeakRef<TransformCacheEpoch['owner']>;
  keySalt: string;
  parent: ActiveCacheKeySaltLease | undefined;
}

const activeCacheKeySaltLeases =
  new AsyncLocalStorage<ActiveCacheKeySaltLease>();

const findActiveCacheKeySaltLease = (
  lease: ActiveCacheKeySaltLease | undefined,
  cacheOwner?: TransformCacheEpoch['owner']
): ActiveCacheKeySaltLease | undefined => {
  for (let current = lease; current; current = current.parent) {
    const currentOwner = current.cacheOwner.deref();
    if (
      current.active &&
      currentOwner &&
      (cacheOwner === undefined || currentOwner === cacheOwner)
    ) {
      return current;
    }
  }

  return undefined;
};

const executeTransformAttempt = async (
  services: Services,
  originalCode: string,
  resolveImports: ReturnType<typeof configureEvalSession>,
  customHandlers: Partial<AllHandlers<'sync'>>
): Promise<Result> => {
  const { options } = services;

  /*
   * This method can be run simultaneously for multiple files.
   * A shared cache is accessible for all runs, but each run has its own queue
   * to maintain the correct processing order. The cache stores the outcome
   * of tree-shaking, and if the result is already stored in the cache
   * but the "only" option has changed, the file will be re-processed using
   * the combined "only" option.
   */
  const entrypoint = Entrypoint.createRoot(
    services,
    options.filename,
    ['__wywPreval'],
    originalCode
  );

  if (entrypoint.ignored) {
    entrypoint.assertCurrentCacheEpoch();
    entrypoint.assertNotSuperseded();
    markPipelineRootStatus('ignored');
    return {
      code: originalCode,
      sourceMap: options.inputSourceMap,
    };
  }

  // Separate top-level runs must not share action state, even for the same
  // entrypoint, otherwise concurrent transforms can collide in BaseAction.run.
  const actionContext = createActionContext();

  try {
    const workflowAction = entrypoint.createAction(
      'workflow',
      undefined,
      null,
      actionContext,
      services
    );

    const result = await asyncActionRunner(workflowAction, {
      ...baseHandlers,
      ...customHandlers,
      resolveImports,
    });

    entrypoint.assertCurrentCacheEpoch();
    entrypoint.log('%s is ready', entrypoint.name);

    return result;
  } finally {
    disposeActionContext(actionContext);
  }
};

const executeTransform = async (
  partialServices: PartialServices,
  originalCode: string,
  asyncResolve: (
    what: string,
    importer: string,
    stack: string[]
  ) => Promise<string | null>,
  customHandlers: Partial<AllHandlers<'sync'>>
): Promise<Result> => {
  const { options: partialOptions } = partialServices;
  const pluginOptions = loadWywOptions(partialOptions.pluginOptions);
  const options = { ...partialOptions, pluginOptions };
  const configuredCache = isFeatureEnabled(
    pluginOptions.features,
    'globalCache',
    options.filename
  )
    ? partialServices.cache ?? new TransformCacheCollection()
    : new TransformCacheCollection();
  const inheritedLeases = activeCacheKeySaltLeases.getStore();
  const parentLease = findActiveCacheKeySaltLease(inheritedLeases);
  const configuredCacheOwner = configuredCache.getCurrentEpoch().owner;
  const inheritedCacheLease = findActiveCacheKeySaltLease(
    inheritedLeases,
    configuredCacheOwner
  );
  const evalCacheKey = getEvalCacheKey(
    pluginOptions,
    partialServices.asyncResolveKey,
    asyncResolve,
    partialServices.loadDependencyCode,
    options.root,
    partialServices.loadDependencyCodeKey
  );
  let releaseKeySalt: (() => void) | undefined;
  let activeLease: ActiveCacheKeySaltLease | undefined;
  const cacheRecoveryOwner = {};

  try {
    if (parentLease) {
      // A bundler may recursively invoke transform() while its parent awaits
      // dependency loading. Waiting for any lease here can form an ABBA cycle.
      // The exact same cache/key session may join its ancestor; everything
      // else fails closed so adapters cannot silently switch cache semantics.
      const nestedRelease = configuredCache.tryAcquireKeySalt(
        evalCacheKey,
        inheritedCacheLease?.keySalt === evalCacheKey
      );
      if (!nestedRelease) {
        throw new CacheKeySaltBusyError();
      }
      releaseKeySalt = nestedRelease;
    } else {
      releaseKeySalt = await configuredCache.acquireKeySalt(evalCacheKey);
    }

    const cache = configuredCache;
    const cacheOwner = cache.getCurrentEpoch().owner;
    activeLease = {
      active: true,
      cacheOwner: new WeakRef(cacheOwner),
      keySalt: evalCacheKey,
      parent: inheritedLeases,
    };

    return await activeCacheKeySaltLeases.run(activeLease, async () => {
      const retriedEpochs = new Set<number>();

      for (;;) {
        let cacheEpoch: TransformCacheEpoch | undefined;

        try {
          cacheEpoch = await cache.acquireReadyEpoch();
          const services = withDefaultServices({
            ...partialServices,
            cache,
            cacheEpoch,
            cacheRecoveryOwner,
            options,
          });
          const resolveImports = configureEvalSession(
            services,
            pluginOptions,
            asyncResolve,
            evalCacheKey
          );

          return await executeTransformAttempt(
            services,
            originalCode,
            resolveImports,
            customHandlers
          );
        } catch (error) {
          const ownedEpochAbort =
            cacheEpoch !== undefined &&
            isCacheEpochAbortedError(error) &&
            cacheEpoch.owner.getEpochError(cacheEpoch) === error
              ? error
              : null;

          const consumesRetryBudget =
            ownedEpochAbort !== null &&
            (ownedEpochAbort.recoveryOwner === undefined ||
              ownedEpochAbort.recoveryOwner === cacheRecoveryOwner);

          if (
            ownedEpochAbort &&
            (!consumesRetryBudget ||
              (!retriedEpochs.has(ownedEpochAbort.toEpoch) &&
                retriedEpochs.size < MAX_CACHE_RECOVERY_RETRIES))
          ) {
            if (consumesRetryBudget) {
              retriedEpochs.add(ownedEpochAbort.toEpoch);
            }
            continue;
          }

          throw ownedEpochAbort
            ? new CacheRecoveryConvergenceError(
                options.filename,
                retriedEpochs.size,
                ownedEpochAbort
              )
            : error;
        }
      }
    });
  } catch (error) {
    if (
      isFeatureEnabled(pluginOptions.features, 'softErrors', options.filename)
    ) {
      markPipelineRootStatus('soft-error');
      // eslint-disable-next-line no-console
      console.error(`Error during transform of ${options.filename}:`, error);

      return {
        code: originalCode,
        sourceMap: options.inputSourceMap,
      };
    }

    throw error;
  } finally {
    if (activeLease) {
      activeLease.active = false;
    }
    releaseKeySalt?.();
  }
};

export function transformSync(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _partialServices: PartialServices,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _originalCode: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _syncResolve: (what: string, importer: string, stack: string[]) => string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _customHandlers: Partial<AllHandlers<'sync'>> = {}
): Result {
  throw new Error(
    '[wyw-in-js] transformSync is not supported in v2. Use transform() (async) instead.'
  );
}

export function transform(
  partialServices: PartialServices,
  originalCode: string,
  asyncResolve: (
    what: string,
    importer: string,
    stack: string[]
  ) => Promise<string | null>,
  customHandlers: Partial<AllHandlers<'sync'>> = {}
): Promise<Result> {
  const { eventEmitter } = partialServices;
  if (!eventEmitter || !hasPipelineTelemetryReporter(eventEmitter)) {
    if (isPipelineTelemetryActive()) {
      return runWithoutPipelineTelemetry(() =>
        executeTransform(
          partialServices,
          originalCode,
          asyncResolve,
          customHandlers
        )
      );
    }

    return executeTransform(
      partialServices,
      originalCode,
      asyncResolve,
      customHandlers
    );
  }

  return runWithPipelineTelemetry(
    eventEmitter,
    () => ({ filename: partialServices.options.filename }),
    () =>
      executeTransform(
        partialServices,
        originalCode,
        asyncResolve,
        customHandlers
      )
  );
}
