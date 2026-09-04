import { createHash } from 'crypto';
import fs from 'node:fs';
import { logger } from '@wyw-in-js/shared';

import {
  getPipelineCodeSha256Hex,
  primePipelineCodeSha256Hex,
  recordPipelineCacheClear,
  recordPipelineCacheRequest,
  recordPipelineCacheSalt,
} from './debug/pipelineTelemetry';
import type { BarrelManifestCacheEntry } from './transform/barrelManifest.types';
import type { Entrypoint } from './transform/Entrypoint';
import type { IEvaluatedEntrypoint } from './transform/EvaluatedEntrypoint';
import {
  CacheEpochAbortedError,
  type CacheRecoveryReason,
} from './transform/actions/CacheEpochAbortedError';
import { CacheKeySaltBusyError } from './transform/actions/CacheKeySaltBusyError';
import { resetEvalBrokersAfterCacheInvalidation } from './eval/brokerRegistry';
import { getFileIdx } from './utils/getFileIdx';
import { stripQueryAndHash } from './utils/parseRequest';

function hashContent(content: string) {
  const cached = getPipelineCodeSha256Hex(content);
  if (cached) return cached;

  const sha256Hex = createHash('sha256').update(content).digest('hex');
  primePipelineCodeSha256Hex(content, sha256Hex);
  return sha256Hex;
}

function isMissingFileError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const { code } = error as NodeJS.ErrnoException;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

interface IBaseCachedEntrypoint {
  dependencies: Map<string, { resolved: string | null }>;
  hasTransformResult?: boolean;
  initialCode?: string;
  isProcessing?: boolean;
  invalidateOnDependencyChange?: Set<string>;
  invalidationDependencies?: Map<string, { resolved: string | null }>;
  transformed?: boolean;
}

type EntrypointDependencySnapshot = Pick<
  IBaseCachedEntrypoint,
  'dependencies' | 'invalidationDependencies' | 'invalidateOnDependencyChange'
>;

const isEntrypointGraphIncomplete = (
  entrypoint: IBaseCachedEntrypoint | undefined
) =>
  Boolean(
    entrypoint?.isProcessing ||
      entrypoint?.transformed === false ||
      entrypoint?.hasTransformResult === false
  );

interface ICaches<TEntrypoint extends IBaseCachedEntrypoint> {
  barrelManifests: Map<string, BarrelManifestCacheEntry>;
  entrypoints: Map<string, TEntrypoint>;
  epochOwner: TransformCacheCollection<IBaseCachedEntrypoint>;
  exports: Map<string, string[]>;
}

type MapValue<T> = T extends Map<string, infer V> ? V : never;

export interface TransformCacheEpoch {
  readonly owner: TransformCacheCollection<IBaseCachedEntrypoint>;
  readonly version: number;
}

interface CacheEpochState {
  abortError: CacheEpochAbortedError | null;
  failure: Error | null;
  ready: Promise<void>;
  rejectReady: (error: Error) => void;
  resolveReady: () => void;
  status: 'failed' | 'pending' | 'ready';
}

interface KeySaltLeaseWaiter {
  readonly keySalt: string | null;
  reject(error: Error): void;
  resolve(release: () => void): void;
}

export interface CacheRecoveryTransition {
  readonly abortError: CacheEpochAbortedError;
  readonly started: boolean;
  complete(): void;
  fail(error: Error): void;
}

export { CacheKeySaltBusyError };

const graphTraversalTokenStates = new WeakMap<
  object,
  { epoch: TransformCacheEpoch }
>();

const createPendingEpochState = (): CacheEpochState => {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A reset failure makes the replacement epoch terminal. Some callers may
  // never have reached acquireReadyEpoch() yet, so keep that rejection from
  // becoming an unhandled promise while preserving it for future awaiters.
  ready.catch(() => undefined);

  return {
    abortError: null,
    failure: null,
    ready,
    rejectReady,
    resolveReady,
    status: 'pending',
  };
};

const createReadyEpochState = (): CacheEpochState => ({
  abortError: null,
  failure: null,
  ready: Promise.resolve(),
  rejectReady: () => {},
  resolveReady: () => {},
  status: 'ready',
});

const cacheLogger = logger.extend('cache');

const cacheNames = ['barrelManifests', 'entrypoints', 'exports'] as const;
type CacheNames = (typeof cacheNames)[number];

const loggers = cacheNames.reduce(
  (acc, key) => ({
    ...acc,
    [key]: cacheLogger.extend(key),
  }),
  {} as Record<CacheNames, typeof logger>
);

export class TransformCacheCollection<
  TEntrypoint extends IBaseCachedEntrypoint = Entrypoint | IEvaluatedEntrypoint,
> {
  public readonly barrelManifests: Map<string, BarrelManifestCacheEntry>;

  public readonly entrypoints: Map<string, TEntrypoint>;

  public readonly exports: Map<string, string[]>;

  private readonly barrelManifestDependencies = new Map<string, Set<string>>();

  private contentHashes = new Map<string, { fs?: string; loaded?: string }>();

  private fileMtimes = new Map<string, number>();

  private readonly exportDependencies = new Map<string, Set<string>>();

  private readonly entrypointDependencySnapshots = new Map<
    string,
    EntrypointDependencySnapshot
  >();

  private keySalt: string | null = null;

  private activeKeySaltLease: string | null = null;

  private keySaltLeaseHolders = 0;

  private keySaltLeaseDraining = false;

  private readonly keySaltLeaseWaiters: KeySaltLeaseWaiter[] = [];

  private invalidatedFiles = new Map<string, number>();

  private consumedInvalidationVersions = new Map<string, number>();

  private resetVersion = 0;

  private lifecycleError: Error | null = null;

  private lifecycleVersion = 0;

  private currentEpoch: TransformCacheEpoch;

  private readonly epochOwner: TransformCacheCollection<IBaseCachedEntrypoint>;

  private readonly epochStates = new WeakMap<
    TransformCacheEpoch,
    CacheEpochState
  >();

  constructor(caches: Partial<ICaches<TEntrypoint>> = {}) {
    this.barrelManifests = caches.barrelManifests || new Map();
    this.entrypoints = caches.entrypoints || new Map();
    this.exports = caches.exports || new Map();
    this.epochOwner = caches.epochOwner ?? this;
    this.currentEpoch = { owner: this, version: this.lifecycleVersion };
    this.epochStates.set(this.currentEpoch, createReadyEpochState());
  }

  public setKeySalt(keySalt: string | null): void {
    if (this.epochOwner !== this) {
      this.epochOwner.setKeySalt(keySalt);
      return;
    }

    const prevKeySalt = this.keySalt;
    if (prevKeySalt === keySalt) {
      recordPipelineCacheSalt(prevKeySalt, keySalt, 'unchanged');
      return;
    }

    if (
      this.keySaltLeaseHolders > 0 ||
      this.keySaltLeaseDraining ||
      this.keySaltLeaseWaiters.length > 0
    ) {
      throw new CacheKeySaltBusyError();
    }

    this.applyKeySalt(keySalt);
  }

  public acquireKeySalt(keySalt: string | null): Promise<() => void> {
    if (this.epochOwner !== this) {
      return this.epochOwner.acquireKeySalt(keySalt);
    }

    return new Promise<() => void>((resolve, reject) => {
      if (
        this.keySaltLeaseHolders > 0 &&
        this.keySaltLeaseWaiters.length === 0 &&
        this.activeKeySaltLease === keySalt
      ) {
        this.keySaltLeaseHolders += 1;
        resolve(this.createKeySaltLeaseRelease());
        return;
      }

      this.keySaltLeaseWaiters.push({ keySalt, reject, resolve });
      this.drainKeySaltLeaseWaiters().catch(() => undefined);
    });
  }

  public tryAcquireKeySalt(
    keySalt: string | null,
    allowQueuedSameKey = false
  ): (() => void) | null {
    if (this.epochOwner !== this) {
      return this.epochOwner.tryAcquireKeySalt(keySalt, allowQueuedSameKey);
    }

    const currentState = this.epochStates.get(this.currentEpoch);
    if (currentState?.status !== 'ready') {
      return null;
    }

    if (this.keySaltLeaseHolders > 0) {
      if (
        this.activeKeySaltLease !== keySalt ||
        (!allowQueuedSameKey && this.keySaltLeaseWaiters.length > 0)
      ) {
        return null;
      }

      this.keySaltLeaseHolders += 1;
      return this.createKeySaltLeaseRelease();
    }

    if (this.keySaltLeaseDraining || this.keySaltLeaseWaiters.length > 0) {
      return null;
    }

    this.applyKeySalt(keySalt);
    this.activeKeySaltLease = keySalt;
    this.keySaltLeaseHolders = 1;
    return this.createKeySaltLeaseRelease();
  }

  private createKeySaltLeaseRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.keySaltLeaseHolders -= 1;
      if (this.keySaltLeaseHolders === 0) {
        this.drainKeySaltLeaseWaiters().catch(() => undefined);
      }
    };
  }

  private async drainKeySaltLeaseWaiters(): Promise<void> {
    if (
      this.keySaltLeaseDraining ||
      this.keySaltLeaseHolders > 0 ||
      this.keySaltLeaseWaiters.length === 0
    ) {
      return;
    }

    this.keySaltLeaseDraining = true;
    const { keySalt } = this.keySaltLeaseWaiters[0];
    try {
      await this.acquireReadyEpoch();
      this.applyKeySalt(keySalt);

      const waiters: KeySaltLeaseWaiter[] = [];
      while (this.keySaltLeaseWaiters[0]?.keySalt === keySalt) {
        waiters.push(this.keySaltLeaseWaiters.shift()!);
      }

      this.activeKeySaltLease = keySalt;
      this.keySaltLeaseHolders = waiters.length;
      waiters.forEach((waiter) => {
        waiter.resolve(this.createKeySaltLeaseRelease());
      });
    } catch (error) {
      const leaseError =
        error instanceof Error ? error : new Error(String(error));
      while (this.keySaltLeaseWaiters[0]?.keySalt === keySalt) {
        this.keySaltLeaseWaiters.shift()!.reject(leaseError);
      }
    } finally {
      this.keySaltLeaseDraining = false;
      if (this.keySaltLeaseHolders === 0) {
        this.drainKeySaltLeaseWaiters().catch(() => undefined);
      }
    }
  }

  private applyKeySalt(keySalt: string | null): void {
    const prevKeySalt = this.keySalt;
    if (prevKeySalt === keySalt) {
      recordPipelineCacheSalt(prevKeySalt, keySalt, 'unchanged');
      return;
    }

    this.assertEpoch(this.currentEpoch);

    this.keySalt = keySalt;
    this.resetVersion += 1;

    // Preserve the historical public cache contract: installing the first
    // semantic key adopts entries that callers populated before transform().
    // No work is retired because those entries remain in the same epoch; only
    // their map keys move into the now-named namespace.
    if (prevKeySalt === null && keySalt) {
      recordPipelineCacheSalt(prevKeySalt, keySalt, 'migrate');
      const migrate = <TValue>(cache: Map<string, TValue>) => {
        const entries = Array.from(cache.entries());
        cache.clear();
        entries.forEach(([key, value]) => {
          cache.set(this.getKey(key), value);
        });
      };

      migrate(this.barrelManifests);
      migrate(this.entrypoints);
      migrate(this.exports);
      migrate(this.barrelManifestDependencies);
      migrate(this.entrypointDependencySnapshots);
      migrate(this.exportDependencies);
      return;
    }

    let clearReason = 'salt-change';
    if (keySalt === null) {
      clearReason = 'salt-disable';
    }
    recordPipelineCacheSalt(
      prevKeySalt,
      keySalt,
      keySalt === null ? 'disable' : 'clear'
    );
    recordPipelineCacheClear(
      'barrelManifests',
      clearReason,
      this.barrelManifests.size
    );
    this.barrelManifests.clear();
    recordPipelineCacheClear('entrypoints', clearReason, this.entrypoints.size);
    this.entrypoints.clear();
    recordPipelineCacheClear('exports', clearReason, this.exports.size);
    this.exports.clear();
    this.entrypointDependencySnapshots.clear();
    this.clearCacheDependencies('all');

    this.rotateEpochAfterKeySaltChange(prevKeySalt, keySalt);
  }

  private rotateEpochAfterKeySaltChange(
    prevKeySalt: string | null,
    keySalt: string | null
  ): void {
    const fromEpoch = this.currentEpoch;
    const nextEpoch: TransformCacheEpoch = {
      owner: this,
      version: this.lifecycleVersion + 1,
    };
    const nextState = createPendingEpochState();
    const cause = Object.assign(
      new Error(
        `[wyw-in-js] Transform cache key changed from ${String(
          prevKeySalt
        )} to ${String(keySalt)}.`
      ),
      { code: 'WYW_CACHE_KEY_SALT_CHANGED' }
    );
    const abortError = new CacheEpochAbortedError(
      fromEpoch.version,
      nextEpoch.version,
      'cache-key-salt-change',
      cause
    );
    this.epochStates.get(fromEpoch)!.abortError = abortError;
    this.epochStates.set(nextEpoch, nextState);
    this.currentEpoch = nextEpoch;
    this.lifecycleVersion = nextEpoch.version;
    this.lifecycleError = abortError;

    try {
      resetEvalBrokersAfterCacheInvalidation(
        this,
        abortError,
        'cache-key-salt-change'
      );
      nextState.status = 'ready';
      nextState.resolveReady();
    } catch (error) {
      const resetError =
        error instanceof Error ? error : new Error(String(error));
      nextState.failure = resetError;
      nextState.status = 'failed';
      nextState.rejectReady(resetError);
      throw resetError;
    }
  }

  private getKey(key: string): string {
    if (this.epochOwner !== this) return this.epochOwner.getKey(key);
    if (!this.keySalt) return key;
    return `${key}::${this.keySalt}`;
  }

  public getKeySalt(): string | null {
    return this.epochOwner === this
      ? this.keySalt
      : this.epochOwner.getKeySalt();
  }

  public getLifecycleVersion(): number {
    return this.epochOwner === this
      ? this.lifecycleVersion
      : this.epochOwner.getLifecycleVersion();
  }

  public getCurrentEpoch(): TransformCacheEpoch {
    if (this.epochOwner !== this) {
      return this.epochOwner.getCurrentEpoch();
    }
    return this.currentEpoch;
  }

  public async acquireReadyEpoch(): Promise<TransformCacheEpoch> {
    if (this.epochOwner !== this) {
      return this.epochOwner.acquireReadyEpoch();
    }
    // A recovery publishes the replacement epoch before retiring the eval
    // runner. Wait for that transition to finish, then make sure another
    // recovery did not replace it while this caller was waiting.
    for (;;) {
      const epoch = this.currentEpoch;
      // Cache recovery is an explicit async barrier for every new attempt.
      // eslint-disable-next-line no-await-in-loop
      await this.epochStates.get(epoch)!.ready;
      if (epoch === this.currentEpoch) {
        return epoch;
      }
    }
  }

  public assertEpoch(epoch: TransformCacheEpoch): void {
    if (epoch.owner !== this.epochOwner) {
      throw new Error('[wyw-in-js] Transform cache epoch has a wrong owner');
    }

    if (this.epochOwner !== this) {
      this.epochOwner.assertEpoch(epoch);
      return;
    }

    const state = this.epochStates.get(epoch);
    if (epoch === this.currentEpoch) {
      if (state?.status === 'ready') {
        return;
      }
      if (state?.status === 'failed' && state.failure) {
        throw state.failure;
      }
      throw new Error(
        '[wyw-in-js] Transform cache recovery is still in progress'
      );
    }

    const abortError = state?.abortError;
    if (abortError) {
      throw abortError;
    }

    throw (
      this.lifecycleError ??
      new Error('[wyw-in-js] Transform cache epoch was invalidated')
    );
  }

  public getEpochError(epoch: TransformCacheEpoch): Error | null {
    try {
      this.assertEpoch(epoch);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  public getResetVersion(): number {
    return this.epochOwner === this
      ? this.resetVersion
      : this.epochOwner.getResetVersion();
  }

  public getLifecycleError(version: number): Error | null {
    if (this.epochOwner !== this) {
      return this.epochOwner.getLifecycleError(version);
    }
    return version === this.lifecycleVersion ? null : this.lifecycleError;
  }

  public createGraphTraversalToken(
    epoch: TransformCacheEpoch = this.getCurrentEpoch()
  ): object {
    this.assertEpoch(epoch);
    const token = {};
    graphTraversalTokenStates.set(token, { epoch });
    return token;
  }

  // eslint-disable-next-line class-methods-use-this
  public getGraphTraversalTokenError(token: object): Error | null {
    const state = graphTraversalTokenStates.get(token);
    if (!state) {
      return null;
    }

    return state.epoch.owner.getEpochError(state.epoch);
  }

  public beginUnknownGraphRecovery(
    filename: string,
    unknownDependencies: ReadonlySet<string>,
    sourceCode: string,
    recoveryToken: object
  ): Error {
    const cause = TransformCacheCollection.createUnknownGraphRecoveryError(
      filename,
      unknownDependencies
    );
    // The released API accepted an arbitrary token and rebound it to the
    // replacement lifecycle. Keep that contract while the internal start*
    // API uses a pre-registered token to identify the retiring epoch.
    graphTraversalTokenStates.set(recoveryToken, {
      epoch: this.getCurrentEpoch(),
    });
    const transition = this.startUnknownGraphRecoveryWithCause(
      filename,
      unknownDependencies,
      sourceCode,
      recoveryToken,
      cause
    );
    transition.complete();
    graphTraversalTokenStates.set(recoveryToken, {
      epoch: this.getCurrentEpoch(),
    });
    return cause;
  }

  /**
   * @deprecated Unknown-graph recovery is complete when
   * beginUnknownGraphRecovery returns.
   */
  public completeUnknownGraphRecovery(
    filename: string,
    publishedEntrypoint?: TEntrypoint
  ): void {
    if (this.epochOwner !== this) {
      this.epochOwner.completeUnknownGraphRecovery(
        filename,
        publishedEntrypoint
      );
    }
  }

  /** @internal Use beginUnknownGraphRecovery unless the pending epoch is observed. */
  public startUnknownGraphRecovery(
    filename: string,
    unknownDependencies: ReadonlySet<string>,
    sourceCode: string,
    recoveryToken: object
  ): CacheRecoveryTransition {
    return this.startUnknownGraphRecoveryWithCause(
      filename,
      unknownDependencies,
      sourceCode,
      recoveryToken,
      TransformCacheCollection.createUnknownGraphRecoveryError(
        filename,
        unknownDependencies
      )
    );
  }

  private static createUnknownGraphRecoveryError(
    filename: string,
    unknownDependencies: ReadonlySet<string>
  ): Error {
    return Object.assign(
      new Error(
        `[wyw-in-js] Resetting transform and evaluation caches for ${filename} because the dependency graph is incomplete (${[
          ...unknownDependencies,
        ].join(', ')}).`
      ),
      {
        code: 'WYW_UNKNOWN_DEPENDENCY_GRAPH_RESET',
        name: 'UnknownDependencyGraphResetError',
      }
    );
  }

  private startUnknownGraphRecoveryWithCause(
    _filename: string,
    _unknownDependencies: ReadonlySet<string>,
    _sourceCode: string,
    recoveryToken: object,
    cause: Error
  ): CacheRecoveryTransition {
    const recoveryEpoch = graphTraversalTokenStates.get(recoveryToken)?.epoch;
    if (!recoveryEpoch) {
      throw new Error('[wyw-in-js] Invalid graph traversal token');
    }
    if (recoveryEpoch.owner !== this.epochOwner) {
      throw new Error('[wyw-in-js] Transform cache epoch has a wrong owner');
    }
    if (recoveryEpoch === recoveryEpoch.owner.getCurrentEpoch()) {
      recoveryEpoch.owner.assertEpoch(recoveryEpoch);
    }
    return recoveryEpoch.owner.beginFailClosedRecovery(
      recoveryEpoch,
      cause,
      'unknown-dependency-graph'
    );
  }

  public beginSupersedeStormRecovery(
    error: Error,
    filename?: string,
    epoch: TransformCacheEpoch = this.getCurrentEpoch()
  ): void {
    this.startSupersedeStormRecovery(error, filename, epoch).complete();
  }

  /** @internal Use beginSupersedeStormRecovery unless the pending epoch is observed. */
  public startSupersedeStormRecovery(
    error: Error,
    _filename?: string,
    epoch: TransformCacheEpoch = this.getCurrentEpoch()
  ): CacheRecoveryTransition {
    if (epoch.owner !== this.epochOwner) {
      throw new Error('[wyw-in-js] Transform cache epoch has a wrong owner');
    }
    if (epoch === epoch.owner.getCurrentEpoch()) {
      epoch.owner.assertEpoch(epoch);
    }
    return epoch.owner.beginFailClosedRecovery(epoch, error, 'supersede-storm');
  }

  private beginFailClosedRecovery(
    epoch: TransformCacheEpoch,
    cause: Error,
    reason: CacheRecoveryReason
  ): CacheRecoveryTransition {
    if (epoch !== this.currentEpoch) {
      const abortError =
        this.epochStates.get(epoch)?.abortError ??
        new CacheEpochAbortedError(
          epoch.version,
          this.currentEpoch.version,
          reason,
          cause
        );
      return {
        abortError,
        started: false,
        complete: () => {},
        fail: () => {},
      };
    }

    const fromEpoch = epoch;
    const nextEpoch: TransformCacheEpoch = {
      owner: this,
      version: this.lifecycleVersion + 1,
    };
    const nextState = createPendingEpochState();
    const abortError = new CacheEpochAbortedError(
      fromEpoch.version,
      nextEpoch.version,
      reason,
      cause
    );
    const fromState = this.epochStates.get(fromEpoch)!;
    fromState.abortError = abortError;
    this.epochStates.set(nextEpoch, nextState);
    this.currentEpoch = nextEpoch;
    this.lifecycleVersion = nextEpoch.version;
    this.lifecycleError = abortError;
    this.resetLifecycle();

    const settle = (error?: Error) => {
      if (nextState.status !== 'pending') return;
      if (error) {
        nextState.failure = error;
        nextState.status = 'failed';
        nextState.rejectReady(error);
      } else {
        nextState.status = 'ready';
        nextState.resolveReady();
      }
    };

    return {
      abortError,
      started: true,
      complete: () => {
        if (nextState.status !== 'pending') return;
        try {
          resetEvalBrokersAfterCacheInvalidation(this, abortError, reason);
          settle();
        } catch (error) {
          const resetError =
            error instanceof Error ? error : new Error(String(error));
          settle(resetError);
          throw resetError;
        }
      },
      fail: (error) => settle(error),
    };
  }

  private resetLifecycle(): void {
    const { resetVersion } = this;
    this.clear('all');
    // This is an internal recovery attempt, not an explicit configuration or
    // user cache reset. Preserve the supersede budget across retries so a
    // graph that never converges still reaches the bounded diagnostic.
    this.resetVersion = resetVersion;
    this.contentHashes.clear();
    this.fileMtimes.clear();
    this.invalidatedFiles.clear();
    this.consumedInvalidationVersions.clear();
  }

  public add<
    TCache extends CacheNames,
    TValue extends MapValue<ICaches<TEntrypoint>[TCache]>,
  >(cacheName: TCache, key: string, value: TValue): void {
    const cache = this[cacheName] as Map<string, TValue>;
    const cacheKey = this.getKey(key);
    loggers[cacheName]('%s:add %s %f', getFileIdx(key), key, () => {
      if (value === undefined) {
        return cache.has(cacheKey) ? 'removed' : 'noop';
      }

      if (!cache.has(cacheKey)) {
        return 'added';
      }

      return cache.get(cacheKey) === value ? 'unchanged' : 'updated';
    });

    if (value === undefined) {
      cache.delete(cacheKey);
      this.contentHashes.delete(key);
      if (cacheName === 'entrypoints') {
        this.entrypointDependencySnapshots.delete(cacheKey);
      }
      this.clearCacheDependencies(cacheName, key);
      return;
    }

    if (cacheName === 'entrypoints') {
      const previous = cache.get(cacheKey) as TEntrypoint | undefined;
      if (previous && previous !== (value as unknown as TEntrypoint)) {
        // Direct replacement (for example applyDeferredSupersede) bypasses
        // invalidate/delete. Preserve the previous completed graph before an
        // unfinished successor replaces it.
        this.snapshotEntrypointDependencies(key, previous);
      }
    }

    this.clearCacheDependencies(cacheName, key);
    cache.set(cacheKey, value);

    // Keep the last complete entrypoint snapshot while a replacement is live.
    // Its dependency maps are incomplete while it is processing, so checks
    // merge them with the retained graph. If the replacement is evicted before
    // it finishes, the previous complete graph remains the safe fallback. A
    // real source change explicitly forgets it in invalidateIfChanged.

    if ('initialCode' in value) {
      const maybeOriginalCode = (value as unknown as { originalCode?: unknown })
        .originalCode;
      const isLoaded = typeof value.initialCode === 'string';
      const source = isLoaded ? 'loaded' : 'fs';

      let resolvedCode: string | undefined;
      if (isLoaded) {
        resolvedCode = value.initialCode;
      } else if (typeof maybeOriginalCode === 'string') {
        resolvedCode = maybeOriginalCode;
      }

      if (resolvedCode !== undefined) {
        this.setContentHash(key, source, hashContent(resolvedCode));
        return;
      }

      try {
        const fileContent = fs.readFileSync(stripQueryAndHash(key), 'utf8');
        this.setContentHash(key, source, hashContent(fileContent));
      } catch {
        this.setContentHash(key, source, hashContent(''));
      }

      return;
    }

    if (cacheName === 'barrelManifests' || cacheName === 'exports') {
      try {
        const fileContent = fs.readFileSync(stripQueryAndHash(key), 'utf8');
        this.setContentHash(key, 'fs', hashContent(fileContent));
      } catch {
        this.setContentHash(key, 'fs', hashContent(''));
      }
    }
  }

  public publish<
    TCache extends CacheNames,
    TValue extends MapValue<ICaches<TEntrypoint>[TCache]>,
  >(
    epoch: TransformCacheEpoch,
    cacheName: TCache,
    key: string,
    value: TValue
  ): void {
    this.assertEpoch(epoch);
    this.add(cacheName, key, value);
  }

  public clear(cacheName: CacheNames | 'all'): void {
    if (cacheName === 'all') {
      cacheNames.forEach((name) => {
        this.clear(name);
      });

      return;
    }

    loggers[cacheName]('clear');
    const cache = this[cacheName] as Map<string, unknown>;

    recordPipelineCacheClear(cacheName, 'explicit', cache.size);
    cache.clear();
    if (cacheName === 'entrypoints') {
      this.resetVersion += 1;
      this.entrypointDependencySnapshots.clear();
    }
    this.clearCacheDependencies(cacheName);
  }

  public delete(cacheName: CacheNames, key: string): void {
    this.invalidate(cacheName, key);
  }

  public removePublished(
    epoch: TransformCacheEpoch,
    cacheName: CacheNames,
    key: string
  ): void {
    this.assertEpoch(epoch);
    this.delete(cacheName, key);
  }

  public get<
    TCache extends CacheNames,
    TValue extends MapValue<ICaches<TEntrypoint>[TCache]>,
  >(cacheName: TCache, key: string): TValue | undefined {
    const cache = this[cacheName] as Map<string, TValue>;
    const res = cache.get(this.getKey(key));

    loggers[cacheName]('get', key, res === undefined ? 'miss' : 'hit');
    recordPipelineCacheRequest(cacheName, 'get', res !== undefined);
    return res;
  }

  public has(cacheName: CacheNames, key: string): boolean {
    const cache = this[cacheName] as Map<string, unknown>;
    const res = cache.has(this.getKey(key));

    loggers[cacheName]('has', key, res);
    recordPipelineCacheRequest(cacheName, 'has', res);
    return res;
  }

  public invalidate(cacheName: CacheNames, key: string): void {
    const cache = this[cacheName] as Map<string, unknown>;
    const cacheKey = this.getKey(key);

    if (!cache.has(cacheKey)) {
      return;
    }

    loggers[cacheName]('invalidate', key);

    if (cacheName === 'entrypoints') {
      this.snapshotEntrypointDependencies(
        key,
        cache.get(cacheKey) as TEntrypoint
      );
    }

    cache.delete(cacheKey);
    recordPipelineCacheClear(cacheName, 'invalidate', 1);
    this.clearCacheDependencies(cacheName, key);
  }

  public invalidateForFile(filename: string) {
    cacheNames.forEach((cacheName) => {
      this.invalidate(cacheName, filename);
    });
    this.markInvalidated(filename);
  }

  private markInvalidated(filename: string): void {
    const key = stripQueryAndHash(filename);
    const version = this.invalidatedFiles.get(key) ?? 0;
    this.invalidatedFiles.set(key, version + 1);
  }

  public consumeInvalidation(filename: string) {
    const key = stripQueryAndHash(filename);
    const invalidationVersion = this.invalidatedFiles.get(key);

    if (invalidationVersion === undefined) {
      return false;
    }

    const consumedVersion =
      this.consumedInvalidationVersions.get(filename) ?? 0;
    if (consumedVersion >= invalidationVersion) {
      return false;
    }

    this.consumedInvalidationVersions.set(filename, invalidationVersion);
    return true;
  }

  public invalidateIfChanged(
    filename: string,
    content: string,
    previousVisitedFiles?: Set<string>,
    source: 'fs' | 'loaded' = 'loaded',
    changedFiles = new Set<string>(),
    dependencyChangeMemo = new Map<string, boolean>(),
    forceContentCheck = false
  ) {
    return this.invalidateIfChangedInternal(
      filename,
      content,
      previousVisitedFiles,
      source,
      changedFiles,
      dependencyChangeMemo,
      forceContentCheck,
      new Set(),
      undefined
    );
  }

  public invalidateIfChangedWithDetails(
    filename: string,
    content: string,
    source: 'fs' | 'loaded' = 'loaded',
    graphTraversalToken?: object,
    epoch: TransformCacheEpoch = this.getCurrentEpoch()
  ): {
    changed: boolean;
    unknownDependencyGraphs: Set<string>;
  } {
    this.assertEpoch(epoch);
    const graphTraversalTokenError = graphTraversalToken
      ? this.getGraphTraversalTokenError(graphTraversalToken)
      : null;
    if (graphTraversalTokenError) {
      throw graphTraversalTokenError;
    }

    const unknownDependencyGraphs = new Set<string>();
    const changed = this.invalidateIfChangedInternal(
      filename,
      content,
      undefined,
      source,
      new Set(),
      new Map(),
      false,
      unknownDependencyGraphs,
      graphTraversalToken
    );

    return { changed, unknownDependencyGraphs };
  }

  private invalidateIfChangedInternal(
    filename: string,
    content: string,
    previousVisitedFiles: Set<string> | undefined,
    source: 'fs' | 'loaded',
    changedFiles: Set<string>,
    dependencyChangeMemo: Map<string, boolean>,
    forceContentCheck: boolean,
    unknownDependencyGraphs: Set<string>,
    graphTraversalToken?: object
  ): boolean {
    if (changedFiles.has(filename)) {
      return true;
    }

    const visitedFiles = new Set(previousVisitedFiles);
    const fileEntrypoint = this.get('entrypoints', filename);
    let anyDepChanged = false;

    if (
      !visitedFiles.has(filename) &&
      (fileEntrypoint ||
        this.entrypointDependencySnapshots.has(this.getKey(filename)) ||
        this.hasCachedDependencies(filename))
    ) {
      visitedFiles.add(filename);
      const invalidateOnDependencyChange = this.getInvalidateOnDependencyChange(
        filename,
        fileEntrypoint
      );
      const dependenciesToCheck = this.getDependenciesToCheck(
        filename,
        fileEntrypoint
      );

      for (const [, dependency] of dependenciesToCheck) {
        const dependencyFilename = dependency.resolved;

        if (dependencyFilename) {
          const dependencyChanged = this.didDependencyChange(
            dependencyFilename,
            visitedFiles,
            changedFiles,
            dependencyChangeMemo,
            unknownDependencyGraphs,
            forceContentCheck ||
              invalidateOnDependencyChange?.has(dependencyFilename) ||
              false,
            graphTraversalToken
          );

          if (
            dependencyChanged &&
            invalidateOnDependencyChange?.has(dependencyFilename)
          ) {
            cacheLogger(
              'dependency affecting output has changed, invalidate all for %s',
              filename
            );
            this.invalidateForFile(filename);
            changedFiles.add(filename);

            return true;
          }

          if (dependencyChanged) {
            anyDepChanged = true;
          }
        }
      }
    }

    const existing = this.contentHashes.get(filename);
    const previousHash = existing?.[source];
    const newHash = hashContent(content);

    if (previousHash === undefined) {
      const otherSource = source === 'fs' ? 'loaded' : 'fs';
      const otherHash = existing?.[otherSource];
      const contentChanged = otherHash !== undefined && otherHash !== newHash;

      if (contentChanged || anyDepChanged) {
        cacheLogger('content has changed, invalidate all for %s', filename);
        this.setContentHash(filename, source, newHash);
        this.invalidateForFile(filename);
        if (contentChanged) {
          this.forgetEntrypointDependencySnapshot(filename);
        }
        changedFiles.add(filename);

        return true;
      }

      this.setContentHash(filename, source, newHash);
      return false;
    }

    const contentChanged = previousHash !== newHash;
    if (contentChanged || anyDepChanged) {
      cacheLogger('content has changed, invalidate all for %s', filename);
      this.setContentHash(filename, source, newHash);
      this.invalidateForFile(filename);
      if (contentChanged) {
        this.forgetEntrypointDependencySnapshot(filename);
      }
      changedFiles.add(filename);

      return true;
    }

    return false;
  }

  private getDependenciesToCheck(
    filename: string,
    fileEntrypoint?: TEntrypoint
  ): Map<string, { resolved: string | null }> {
    const dependenciesToCheck = new Map<string, { resolved: string | null }>();
    const snapshot = this.entrypointDependencySnapshots.get(
      this.getKey(filename)
    );
    const graphMayBeIncomplete = isEntrypointGraphIncomplete(fileEntrypoint);
    const dependencySources =
      fileEntrypoint && graphMayBeIncomplete && snapshot
        ? [snapshot, fileEntrypoint]
        : [fileEntrypoint ?? snapshot];

    for (const [sourceIndex, dependencySource] of dependencySources.entries()) {
      for (const [key, dependency] of dependencySource?.dependencies ?? []) {
        const graphKey =
          dependencySources.length === 1 ? key : `${sourceIndex}:${key}`;
        dependenciesToCheck.set(graphKey, dependency);
      }

      for (const [
        key,
        dependency,
      ] of dependencySource?.invalidationDependencies ?? []) {
        const graphKey =
          dependencySources.length === 1 ? key : `${sourceIndex}:${key}`;
        if (!dependenciesToCheck.has(graphKey)) {
          dependenciesToCheck.set(graphKey, dependency);
        }
      }
    }

    for (const dependencyFilename of this.getCachedDependencies(filename)) {
      if (
        ![...dependenciesToCheck.values()].some(
          (dependency) => dependency.resolved === dependencyFilename
        )
      ) {
        dependenciesToCheck.set(dependencyFilename, {
          resolved: dependencyFilename,
        });
      }
    }

    return dependenciesToCheck;
  }

  private getInvalidateOnDependencyChange(
    filename: string,
    fileEntrypoint?: TEntrypoint
  ): Set<string> | undefined {
    const snapshot = this.entrypointDependencySnapshots.get(
      this.getKey(filename)
    );
    if (
      fileEntrypoint &&
      isEntrypointGraphIncomplete(fileEntrypoint) &&
      snapshot
    ) {
      return new Set([
        ...(snapshot.invalidateOnDependencyChange ?? []),
        ...(fileEntrypoint.invalidateOnDependencyChange ?? []),
      ]);
    }

    return (
      fileEntrypoint?.invalidateOnDependencyChange ??
      snapshot?.invalidateOnDependencyChange
    );
  }

  private didDependencyChange(
    dependencyFilename: string,
    visitedFiles: Set<string>,
    changedFiles: Set<string>,
    dependencyChangeMemo: Map<string, boolean>,
    unknownDependencyGraphs: Set<string>,
    forceContentCheck = false,
    graphTraversalToken?: object
  ): boolean {
    if (changedFiles.has(dependencyFilename)) {
      return true;
    }

    const dependencyMemoKey = `${
      forceContentCheck ? 'forced' : 'normal'
    }\0${dependencyFilename}`;
    const memoized = dependencyChangeMemo.get(dependencyMemoKey);
    if (memoized !== undefined) {
      return memoized;
    }

    if (visitedFiles.has(dependencyFilename)) {
      return false;
    }

    const strippedDependencyFilename = stripQueryAndHash(dependencyFilename);
    const cachedMtime = this.fileMtimes.get(dependencyFilename);
    const cachedEntrypoint = this.get('entrypoints', dependencyFilename);
    const hasRetainedSnapshot = this.entrypointDependencySnapshots.has(
      this.getKey(dependencyFilename)
    );
    const graphMayBeIncomplete = isEntrypointGraphIncomplete(cachedEntrypoint);
    const hasKnownDependencyGraph = cachedEntrypoint
      ? !graphMayBeIncomplete || hasRetainedSnapshot
      : hasRetainedSnapshot;
    const allowUnknownDependencyGraph =
      this.canTraverseUnknownGraph(graphTraversalToken);
    if (!hasKnownDependencyGraph && !allowUnknownDependencyGraph) {
      // Record this independently of the mtime/hash fast path. The first
      // verification after a cache clear may need to seed its fs hash, but
      // reading the module's own bytes still cannot prove that its missing
      // transitive graph is complete.
      unknownDependencyGraphs.add(dependencyFilename);
    }

    if (cachedMtime !== undefined) {
      let currentMtime: number;

      try {
        currentMtime = fs.statSync(strippedDependencyFilename).mtimeMs;
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }

        this.invalidateForFile(dependencyFilename);
        this.forgetEntrypointDependencySnapshot(dependencyFilename);
        changedFiles.add(dependencyFilename);
        dependencyChangeMemo.set(dependencyMemoKey, true);
        return true;
      }

      if (currentMtime === cachedMtime) {
        const nestedDependencies = this.getDependenciesToCheck(
          dependencyFilename,
          cachedEntrypoint
        );

        if (
          forceContentCheck &&
          this.didFileContentHashChange(
            dependencyFilename,
            strippedDependencyFilename,
            changedFiles
          )
        ) {
          dependencyChangeMemo.set(dependencyMemoKey, true);
          return true;
        }

        const invalidateOnDependencyChange =
          this.getInvalidateOnDependencyChange(
            dependencyFilename,
            cachedEntrypoint
          );
        const fsHash = this.contentHashes.get(dependencyFilename)?.fs;
        const dependencyGraphIsUnknown =
          !hasKnownDependencyGraph || fsHash === undefined;
        if (dependencyGraphIsUnknown && !allowUnknownDependencyGraph) {
          unknownDependencyGraphs.add(dependencyFilename);
        }

        if (!cachedEntrypoint) {
          // A missing entrypoint can be cache churn. Verify its own source,
          // then continue through the lightweight dependency snapshot taken
          // when the entrypoint was evicted.
          if (
            !forceContentCheck &&
            this.didFileContentHashChange(
              dependencyFilename,
              strippedDependencyFilename,
              changedFiles
            )
          ) {
            dependencyChangeMemo.set(dependencyMemoKey, true);
            return true;
          }
        }

        if (nestedDependencies.size > 0) {
          const nextVisitedFiles = new Set(visitedFiles);
          nextVisitedFiles.add(dependencyFilename);

          for (const [, nestedDependency] of nestedDependencies) {
            if (
              nestedDependency.resolved &&
              this.didDependencyChange(
                nestedDependency.resolved,
                nextVisitedFiles,
                changedFiles,
                dependencyChangeMemo,
                unknownDependencyGraphs,
                forceContentCheck ||
                  invalidateOnDependencyChange?.has(
                    nestedDependency.resolved
                  ) ||
                  false,
                graphTraversalToken
              )
            ) {
              this.invalidateForFile(dependencyFilename);
              changedFiles.add(dependencyFilename);
              dependencyChangeMemo.set(dependencyMemoKey, true);
              return true;
            }
          }
        }

        if (dependencyGraphIsUnknown) {
          // Auxiliary export/barrel dependencies are useful edges, so inspect
          // them above and invalidate their caches when they change. They are
          // still only a partial graph, though. Without a complete entrypoint
          // graph, an evicted or unfinished module may hide another changed
          // transitive dependency. Remain fail-closed until a complete graph
          // is restored; the supersede guard bounds a failure to converge.
          cacheLogger(
            'dependency graph for %s is unknown, conservatively report as changed',
            dependencyFilename
          );
          dependencyChangeMemo.set(
            dependencyMemoKey,
            !allowUnknownDependencyGraph
          );
          return !allowUnknownDependencyGraph;
        }

        dependencyChangeMemo.set(dependencyMemoKey, false);
        return false;
      }
    }

    let dependencyContent: string;

    try {
      dependencyContent = fs.readFileSync(strippedDependencyFilename, 'utf8');
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      this.invalidateForFile(dependencyFilename);
      this.forgetEntrypointDependencySnapshot(dependencyFilename);
      changedFiles.add(dependencyFilename);
      dependencyChangeMemo.set(dependencyMemoKey, true);
      return true;
    }

    const invalidated = this.invalidateIfChangedInternal(
      dependencyFilename,
      dependencyContent,
      visitedFiles,
      'fs',
      changedFiles,
      dependencyChangeMemo,
      forceContentCheck,
      unknownDependencyGraphs,
      graphTraversalToken
    );

    const dependencyChanged =
      invalidated || (!hasKnownDependencyGraph && !allowUnknownDependencyGraph);
    if (!hasKnownDependencyGraph) {
      cacheLogger(
        'dependency graph for %s is unknown after content verification, conservatively report as changed',
        dependencyFilename
      );
    }
    dependencyChangeMemo.set(dependencyMemoKey, dependencyChanged);
    return dependencyChanged;
  }

  private canTraverseUnknownGraph(graphTraversalToken?: object): boolean {
    if (!graphTraversalToken) {
      return false;
    }

    const tokenState = graphTraversalTokenStates.get(graphTraversalToken);
    if (!tokenState) {
      return false;
    }

    return this.getEpochError(tokenState.epoch) === null;
  }

  private didFileContentHashChange(
    filename: string,
    strippedFilename: string,
    changedFiles: Set<string>
  ): boolean {
    const previousHash = this.contentHashes.get(filename)?.fs;
    if (previousHash === undefined) {
      return false;
    }

    let content: string;
    try {
      content = fs.readFileSync(strippedFilename, 'utf8');
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      this.invalidateForFile(filename);
      this.forgetEntrypointDependencySnapshot(filename);
      changedFiles.add(filename);
      return true;
    }

    const nextHash = hashContent(content);
    if (previousHash === nextHash) {
      return false;
    }

    this.setContentHash(filename, 'fs', nextHash);
    this.invalidateForFile(filename);
    this.forgetEntrypointDependencySnapshot(filename);
    changedFiles.add(filename);
    return true;
  }

  public setCacheDependencies(
    cacheName: 'barrelManifests' | 'exports',
    key: string,
    dependencies: Iterable<string>
  ): void {
    const cache = this.getDependencyCache(cacheName);
    const nextDependencies = new Set(
      [...dependencies].filter((dependency) => dependency.length > 0)
    );
    const cacheKey = this.getKey(key);

    if (nextDependencies.size === 0) {
      cache.delete(cacheKey);
      return;
    }

    cache.set(cacheKey, nextDependencies);
  }

  public publishCacheDependencies(
    epoch: TransformCacheEpoch,
    cacheName: 'barrelManifests' | 'exports',
    key: string,
    dependencies: Iterable<string>
  ): void {
    this.assertEpoch(epoch);
    this.setCacheDependencies(cacheName, key, dependencies);
  }

  /**
   * Fast check if a file changed on disk since last seen.
   * Uses mtime as a fast path and only reads the file if mtime differs.
   */
  public checkFreshness(filename: string, strippedFilename: string): boolean {
    try {
      const currentMtime = fs.statSync(strippedFilename).mtimeMs;
      const cachedMtime = this.fileMtimes.get(filename);

      if (cachedMtime !== undefined && currentMtime === cachedMtime) {
        return false;
      }

      const content = fs.readFileSync(strippedFilename, 'utf8');
      this.fileMtimes.set(filename, currentMtime);

      if (this.invalidateIfChanged(filename, content, undefined, 'fs')) {
        return true;
      }

      return false;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      this.invalidateForFile(filename);
      this.forgetEntrypointDependencySnapshot(filename);
      return true;
    }
  }

  private clearCacheDependencies(cacheName: CacheNames | 'all', key?: string) {
    if (cacheName === 'all') {
      this.barrelManifestDependencies.clear();
      this.exportDependencies.clear();
      return;
    }

    if (cacheName === 'barrelManifests') {
      if (key === undefined) {
        this.barrelManifestDependencies.clear();
      } else {
        this.barrelManifestDependencies.delete(this.getKey(key));
      }
      return;
    }

    if (cacheName === 'exports') {
      if (key === undefined) {
        this.exportDependencies.clear();
      } else {
        this.exportDependencies.delete(this.getKey(key));
      }
    }
  }

  private getCachedDependencies(filename: string): Set<string> {
    const key = this.getKey(filename);

    return new Set([
      ...(this.barrelManifestDependencies.get(key) ?? []),
      ...(this.exportDependencies.get(key) ?? []),
    ]);
  }

  private getDependencyCache(cacheName: 'barrelManifests' | 'exports') {
    return cacheName === 'barrelManifests'
      ? this.barrelManifestDependencies
      : this.exportDependencies;
  }

  private hasCachedDependencies(filename: string): boolean {
    return this.getCachedDependencies(filename).size > 0;
  }

  private snapshotEntrypointDependencies(
    filename: string,
    entrypoint: TEntrypoint
  ): void {
    if (
      entrypoint.isProcessing ||
      entrypoint.transformed === false ||
      entrypoint.hasTransformResult === false
    ) {
      // An unfinished entrypoint's dependency maps may be incomplete: take no
      // snapshot, but keep one from an earlier completed generation. The
      // previous complete graph still allows conservative dependency checks;
      // deleting it would force repeated unknown-graph invalidation.
      return;
    }

    const copy = (
      dependencies: Map<string, { resolved: string | null }> | undefined
    ): Map<string, { resolved: string | null }> =>
      new Map(
        Array.from(dependencies ?? [], ([key, dependency]) => [
          key,
          { resolved: dependency.resolved },
        ])
      );

    this.entrypointDependencySnapshots.set(this.getKey(filename), {
      dependencies: copy(entrypoint.dependencies),
      invalidationDependencies: copy(entrypoint.invalidationDependencies),
      invalidateOnDependencyChange: new Set(
        entrypoint.invalidateOnDependencyChange ?? []
      ),
    });
  }

  private forgetEntrypointDependencySnapshot(filename: string): void {
    this.entrypointDependencySnapshots.delete(this.getKey(filename));
  }

  private setContentHash(
    filename: string,
    source: 'fs' | 'loaded',
    hash: string
  ) {
    const current = this.contentHashes.get(filename);
    if (current) {
      current[source] = hash;
    } else {
      this.contentHashes.set(filename, { [source]: hash });
    }

    if (source === 'fs') {
      try {
        this.fileMtimes.set(
          filename,
          fs.statSync(stripQueryAndHash(filename)).mtimeMs
        );
      } catch {
        // ignore
      }
    }
  }
}
