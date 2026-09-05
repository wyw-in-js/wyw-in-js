import type { TransformCacheCollection } from '../cache';
import { resetEvalBrokersAfterCacheInvalidation } from '../eval/brokerRegistry';
import {
  CacheEpochAbortedError,
  type CacheRecoveryReason,
} from '../transform/actions/CacheEpochAbortedError';
import { CacheKeySaltBusyError } from '../transform/actions/CacheKeySaltBusyError';
import { recordPipelineCacheSalt } from '../debug/pipelineTelemetry';
import { CacheFreshness, type PendingUnknownGraph } from './cacheFreshness';
import { hashContent, type IBaseCachedEntrypoint } from './cacheTypes';

export interface TransformCacheEpoch {
  readonly owner: TransformCacheCollection<IBaseCachedEntrypoint>;
  readonly version: number;
}

interface CacheEpochState {
  abortController: AbortController;
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

/** @internal Recovery transitions must always be settled by transform internals. */
export interface CacheRecoveryTransition {
  readonly abortError: CacheEpochAbortedError;
  readonly started: boolean;
  complete(): void;
  fail(error: Error): void;
}

type GraphTraversalTokenState =
  | {
      epoch: TransformCacheEpoch;
      kind: 'epoch';
      recoveryOwner?: object;
    }
  | {
      kind: 'legacy';
      owner: TransformCacheCollection<IBaseCachedEntrypoint>;
      version: number;
      visited: Set<string>;
    };

const graphTraversalTokenStates = new WeakMap<
  object,
  GraphTraversalTokenState
>();

const createPendingEpochState = (): CacheEpochState => {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => undefined);

  return {
    abortController: new AbortController(),
    abortError: null,
    failure: null,
    ready,
    rejectReady,
    resolveReady,
    status: 'pending',
  };
};

const createReadyEpochState = (): CacheEpochState => ({
  abortController: new AbortController(),
  abortError: null,
  failure: null,
  ready: Promise.resolve(),
  rejectReady: () => {},
  resolveReady: () => {},
  status: 'ready',
});

export abstract class CacheLifecycle<
  TEntrypoint extends IBaseCachedEntrypoint,
> extends CacheFreshness<TEntrypoint> {
  private keySalt: string | null = null;

  private activeKeySaltLease: string | null = null;

  private keySaltLeaseHolders = 0;

  private keySaltLeaseDraining = false;

  private readonly keySaltLeaseWaiters: KeySaltLeaseWaiter[] = [];

  private resetVersion = 0;

  private lifecycleError: Error | null = null;

  private lifecycleVersion = 0;

  private readonly legacyFileRecoveryErrors = new Map<
    string,
    { error: Error; version: number }
  >();

  private legacyGlobalRecoveryError: {
    error: Error;
    version: number;
  } | null = null;

  private readonly legacyPendingUnknownGraphs = new Map<
    string,
    PendingUnknownGraph
  >();

  private currentEpoch: TransformCacheEpoch;

  private readonly epochOwner: CacheLifecycle<IBaseCachedEntrypoint>;

  private readonly epochStates = new WeakMap<
    TransformCacheEpoch,
    CacheEpochState
  >();

  protected constructor(
    epochOwner?: TransformCacheCollection<IBaseCachedEntrypoint>
  ) {
    super();
    const self =
      this as unknown as TransformCacheCollection<IBaseCachedEntrypoint>;
    this.epochOwner = (epochOwner ??
      self) as unknown as CacheLifecycle<IBaseCachedEntrypoint>;
    this.currentEpoch = { owner: self, version: this.lifecycleVersion };
    this.epochStates.set(this.currentEpoch, createReadyEpochState());
  }

  private get epochOwnerCache(): TransformCacheCollection<IBaseCachedEntrypoint> {
    return this
      .epochOwner as unknown as TransformCacheCollection<IBaseCachedEntrypoint>;
  }

  protected abstract clearAllCachesForRecovery(): void;

  protected abstract clearCachesForKeySaltChange(reason: string): void;

  protected abstract hasPublishedEntrypoint(
    filename: string,
    publishedEntrypoint: TEntrypoint
  ): boolean;

  protected abstract migrateCacheKeys(remap: (key: string) => string): void;

  public setKeySalt(keySalt: string | null): void {
    if (this.epochOwner !== this) {
      this.epochOwner.setKeySalt(keySalt);
      return;
    }

    const previous = this.keySalt;
    if (previous === keySalt) {
      recordPipelineCacheSalt(previous, keySalt, 'unchanged');
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

  /** @internal Transform owns the lifetime of semantic cache-key leases. */
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

  /** @internal Transform owns the lifetime of semantic cache-key leases. */
  public tryAcquireKeySalt(
    keySalt: string | null,
    allowQueuedSameKey = false
  ): (() => void) | null {
    if (this.epochOwner !== this) {
      return this.epochOwner.tryAcquireKeySalt(keySalt, allowQueuedSameKey);
    }
    const currentState = this.epochStates.get(this.currentEpoch);
    if (currentState?.status !== 'ready') return null;

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
    const previous = this.keySalt;
    if (previous === keySalt) {
      recordPipelineCacheSalt(previous, keySalt, 'unchanged');
      return;
    }

    this.assertEpoch(this.currentEpoch);
    this.keySalt = keySalt;
    this.resetVersion += 1;

    if (previous === null && keySalt) {
      recordPipelineCacheSalt(previous, keySalt, 'migrate');
      const remap = (key: string) => this.getKey(key);
      this.migrateCacheKeys(remap);
      this.migrateFreshnessKeys(remap);
      return;
    }

    const reason = keySalt === null ? 'salt-disable' : 'salt-change';
    recordPipelineCacheSalt(
      previous,
      keySalt,
      keySalt === null ? 'disable' : 'clear'
    );
    this.clearCachesForKeySaltChange(reason);
    this.clearFreshnessForKeySalt();
    this.legacyFileRecoveryErrors.clear();
    this.legacyPendingUnknownGraphs.clear();
    this.rotateEpochAfterKeySaltChange(previous, keySalt);
  }

  private rotateEpochAfterKeySaltChange(
    previous: string | null,
    keySalt: string | null
  ): void {
    const fromEpoch = this.currentEpoch;
    const nextEpoch: TransformCacheEpoch = {
      owner: this.epochOwnerCache,
      version: fromEpoch.version + 1,
    };
    const nextState = createPendingEpochState();
    const cause = Object.assign(
      new Error(
        `[wyw-in-js] Transform cache key changed from ${String(
          previous
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
    const fromState = this.epochStates.get(fromEpoch)!;
    fromState.abortError = abortError;
    this.epochStates.set(nextEpoch, nextState);
    this.currentEpoch = nextEpoch;
    fromState.abortController.abort(abortError);
    this.lifecycleError = abortError;

    try {
      resetEvalBrokersAfterCacheInvalidation(
        this.epochOwnerCache,
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

  protected getKey(key: string): string {
    if (this.epochOwner !== this) {
      return (this.epochOwner as unknown as CacheLifecycle<TEntrypoint>).getKey(
        key
      );
    }
    return this.keySalt ? `${key}::${this.keySalt}` : key;
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

  /** @internal Cache epochs are coordinated by transform attempts. */
  public getCurrentEpoch(): TransformCacheEpoch {
    if (this.epochOwner !== this) return this.epochOwner.getCurrentEpoch();
    return this.currentEpoch;
  }

  /** @internal Cache epochs are coordinated by transform attempts. */
  public async acquireReadyEpoch(): Promise<TransformCacheEpoch> {
    if (this.epochOwner !== this) return this.epochOwner.acquireReadyEpoch();
    for (;;) {
      const epoch = this.currentEpoch;
      // eslint-disable-next-line no-await-in-loop
      await this.epochStates.get(epoch)!.ready;
      if (epoch === this.currentEpoch) return epoch;
    }
  }

  /** @internal Cache epochs are coordinated by transform attempts. */
  public assertEpoch(epoch: TransformCacheEpoch): void {
    if (epoch.owner !== this.epochOwnerCache) {
      throw new Error('[wyw-in-js] Transform cache epoch has a wrong owner');
    }
    if (this.epochOwner !== this) {
      this.epochOwner.assertEpoch(epoch);
      return;
    }

    const state = this.epochStates.get(epoch);
    if (epoch === this.currentEpoch) {
      if (state?.status === 'ready') return;
      if (state?.status === 'failed' && state.failure) throw state.failure;
      throw new Error(
        '[wyw-in-js] Transform cache recovery is still in progress'
      );
    }
    if (state?.abortError) throw state.abortError;
    throw (
      this.lifecycleError ??
      new Error('[wyw-in-js] Transform cache epoch was invalidated')
    );
  }

  /** @internal Cache epochs are coordinated by transform attempts. */
  public getEpochError(epoch: TransformCacheEpoch): Error | null {
    try {
      this.assertEpoch(epoch);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  /** @internal Cache users may stop waiting as soon as their epoch retires. */
  public getEpochAbortSignal(epoch: TransformCacheEpoch): AbortSignal {
    if (epoch.owner !== this.epochOwnerCache) {
      throw new Error('[wyw-in-js] Transform cache epoch has a wrong owner');
    }
    if (this.epochOwner !== this) {
      return this.epochOwner.getEpochAbortSignal(epoch);
    }
    const state = this.epochStates.get(epoch);
    if (!state) {
      this.assertEpoch(epoch);
      throw new Error('[wyw-in-js] Transform cache epoch was invalidated');
    }
    return state.abortController.signal;
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
    return version === this.lifecycleVersion
      ? null
      : this.legacyGlobalRecoveryError?.error ?? null;
  }

  public getRecoveryError(
    filename: string,
    sinceVersion: number,
    graphTraversalToken?: object
  ): Error | null {
    if (this.epochOwner !== this) {
      return this.epochOwner.getRecoveryError(
        filename,
        sinceVersion,
        graphTraversalToken
      );
    }
    const recovery = this.legacyFileRecoveryErrors.get(filename);
    if (!recovery) return null;
    if (recovery.version > sinceVersion) return recovery.error;
    const pending = this.legacyPendingUnknownGraphs.get(filename);
    return pending && graphTraversalToken !== pending.recoveryToken
      ? recovery.error
      : null;
  }

  public getScopedRecoveryError(
    version: number,
    visited: ReadonlySet<string>
  ): Error | undefined {
    if (this.epochOwner !== this) {
      return this.epochOwner.getScopedRecoveryError(version, visited);
    }
    for (const [filename, recovery] of this.legacyFileRecoveryErrors) {
      if (recovery.version > version && visited.has(filename)) {
        return recovery.error;
      }
    }
    return this.legacyGlobalRecoveryError?.error;
  }

  public createGraphTraversalToken(): object;
  /** @internal An explicit epoch may only come from a transform attempt. */
  public createGraphTraversalToken(epoch: TransformCacheEpoch): object;
  /** @internal Bind recovery attribution to a transform lineage. */
  public createGraphTraversalToken(
    epoch: TransformCacheEpoch,
    recoveryOwner: object | undefined
  ): object;
  public createGraphTraversalToken(
    epoch?: TransformCacheEpoch,
    recoveryOwner?: object
  ): object {
    const token = {};
    if (epoch === undefined) {
      const owner = this.epochOwnerCache;
      graphTraversalTokenStates.set(token, {
        kind: 'legacy',
        owner,
        version: owner.getLifecycleVersion(),
        visited: new Set(),
      });
      return token;
    }
    this.assertEpoch(epoch);
    graphTraversalTokenStates.set(token, {
      epoch,
      kind: 'epoch',
      recoveryOwner,
    });
    return token;
  }

  public getGraphTraversalTokenError(token: object): Error | null {
    const state = graphTraversalTokenStates.get(token);
    if (!state) return null;
    if (state.kind === 'epoch') {
      return state.epoch.owner.getEpochError(state.epoch);
    }

    const owner =
      state.owner === this.epochOwnerCache ? this.epochOwnerCache : state.owner;
    if (owner.getLifecycleVersion() === state.version) return null;
    const scopedError = owner.getScopedRecoveryError(
      state.version,
      state.visited
    );
    if (scopedError === undefined) return null;
    return owner.getLifecycleError(state.version) ?? scopedError;
  }

  protected validateGraphTraversal(
    filename: string,
    graphTraversalToken?: object
  ): void {
    const state = graphTraversalToken
      ? graphTraversalTokenStates.get(graphTraversalToken)
      : undefined;
    if (state?.kind === 'epoch' && state.epoch.owner !== this.epochOwnerCache) {
      throw new Error('[wyw-in-js] Transform cache epoch has a wrong owner');
    }
    const error = graphTraversalToken
      ? this.getGraphTraversalTokenError(graphTraversalToken)
      : null;
    if (error) {
      if (
        state?.kind === 'legacy' &&
        this.epochOwner.legacyPendingUnknownGraphs.has(filename)
      ) {
        throw (
          this.epochOwner.legacyFileRecoveryErrors.get(filename)?.error ?? error
        );
      }
      throw error;
    }
    if (state?.kind === 'legacy') state.visited.add(filename);
  }

  protected canTraverseUnknownGraph(
    filename: string,
    graphTraversalToken?: object
  ): boolean {
    if (!graphTraversalToken) return false;
    const state = graphTraversalTokenStates.get(graphTraversalToken);
    if (!state) return false;
    if (state.kind === 'epoch') {
      return (
        state.epoch.owner === this.epochOwnerCache &&
        state.epoch.owner.getEpochError(state.epoch) === null
      );
    }
    state.visited.add(filename);
    if (
      state.owner !== this.epochOwnerCache ||
      this.getGraphTraversalTokenError(graphTraversalToken) !== null
    ) {
      return false;
    }
    const pending = this.epochOwner.legacyPendingUnknownGraphs.get(filename);
    return !pending || pending.recoveryToken === graphTraversalToken;
  }

  protected getPendingUnknownGraph(
    filename: string
  ): PendingUnknownGraph | undefined {
    return this.epochOwner.legacyPendingUnknownGraphs.get(filename);
  }

  protected deletePendingUnknownGraph(filename: string): void {
    this.epochOwner.legacyPendingUnknownGraphs.delete(filename);
  }

  public beginUnknownGraphRecovery(
    filename: string,
    unknownDependencies: ReadonlySet<string>,
    sourceCode: string,
    recoveryToken: object
  ): Error {
    const cause = CacheLifecycle.createUnknownGraphRecoveryError(
      filename,
      unknownDependencies
    );
    const recoveryEpoch = this.getCurrentEpoch();
    this.assertEpoch(recoveryEpoch);
    const transition = (
      recoveryEpoch.owner as unknown as CacheLifecycle<TEntrypoint>
    ).beginFailClosedRecovery(
      recoveryEpoch,
      cause,
      'unknown-dependency-graph',
      filename,
      unknownDependencies
    );
    transition.complete();
    this.bindLegacyUnknownGraphRecovery(
      filename,
      unknownDependencies,
      sourceCode,
      recoveryToken
    );
    return cause;
  }

  private bindLegacyUnknownGraphRecovery(
    filename: string,
    unknownDependencies: ReadonlySet<string>,
    sourceCode: string,
    recoveryToken: object
  ): void {
    graphTraversalTokenStates.set(recoveryToken, {
      kind: 'legacy',
      owner: this.epochOwnerCache,
      version: this.getLifecycleVersion(),
      visited: new Set([filename]),
    });
    const lifecycle = this.epochOwner as unknown as CacheLifecycle<TEntrypoint>;
    lifecycle.legacyPendingUnknownGraphs.set(filename, {
      dependencies: new Set(unknownDependencies),
      recoveryToken,
      sourceHash: hashContent(sourceCode),
    });
  }

  public completeUnknownGraphRecovery(
    filename: string,
    publishedEntrypoint?: TEntrypoint
  ): void {
    if (this.epochOwner !== this) {
      this.epochOwner.completeUnknownGraphRecovery(
        filename,
        publishedEntrypoint
      );
      return;
    }
    if (
      publishedEntrypoint !== undefined &&
      !this.hasPublishedEntrypoint(filename, publishedEntrypoint)
    ) {
      return;
    }
    this.legacyPendingUnknownGraphs.delete(filename);
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
      CacheLifecycle.createUnknownGraphRecoveryError(
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
    filename: string,
    unknownDependencies: ReadonlySet<string>,
    sourceCode: string,
    recoveryToken: object,
    cause: Error
  ): CacheRecoveryTransition {
    const tokenState = graphTraversalTokenStates.get(recoveryToken);
    if (tokenState?.kind !== 'epoch') {
      if (
        tokenState?.owner !== undefined &&
        tokenState.owner !== this.epochOwnerCache
      ) {
        throw new Error('[wyw-in-js] Transform cache epoch has a wrong owner');
      }
      const recoveryEpoch = this.getCurrentEpoch();
      this.assertEpoch(recoveryEpoch);
      const lifecycle =
        recoveryEpoch.owner as unknown as CacheLifecycle<TEntrypoint>;
      const transition = lifecycle.beginFailClosedRecovery(
        recoveryEpoch,
        cause,
        'unknown-dependency-graph',
        filename,
        unknownDependencies
      );
      let bound = false;
      let settled = false;
      return {
        abortError: transition.abortError,
        started: transition.started,
        complete: () => {
          if (settled) return;
          transition.complete();
          settled = true;
          if (!bound && transition.started) {
            bound = true;
            this.bindLegacyUnknownGraphRecovery(
              filename,
              unknownDependencies,
              sourceCode,
              recoveryToken
            );
          }
        },
        fail: (error) => {
          if (settled) return;
          settled = true;
          transition.fail(error);
        },
      };
    }

    const { epoch } = tokenState;
    if (epoch.owner !== this.epochOwnerCache) {
      throw new Error('[wyw-in-js] Transform cache epoch has a wrong owner');
    }
    if (epoch === epoch.owner.getCurrentEpoch()) epoch.owner.assertEpoch(epoch);
    return (
      epoch.owner as unknown as CacheLifecycle<TEntrypoint>
    ).beginFailClosedRecovery(
      epoch,
      cause,
      'unknown-dependency-graph',
      filename,
      unknownDependencies,
      tokenState.recoveryOwner
    );
  }

  public beginSupersedeStormRecovery(error: Error, filename?: string): void;
  /** @internal An explicit epoch may only come from a transform attempt. */
  public beginSupersedeStormRecovery(
    error: Error,
    filename: string | undefined,
    epoch: TransformCacheEpoch,
    recoveryOwner?: object
  ): void;
  public beginSupersedeStormRecovery(
    error: Error,
    filename?: string,
    epoch: TransformCacheEpoch = this.getCurrentEpoch(),
    recoveryOwner?: object
  ): void {
    this.startSupersedeStormRecovery(
      error,
      filename,
      epoch,
      recoveryOwner
    ).complete();
  }

  /** @internal Use beginSupersedeStormRecovery unless the pending epoch is observed. */
  public startSupersedeStormRecovery(
    error: Error,
    filename?: string,
    epoch: TransformCacheEpoch = this.getCurrentEpoch(),
    recoveryOwner?: object
  ): CacheRecoveryTransition {
    return this.startRecovery(
      epoch,
      error,
      'supersede-storm',
      filename,
      recoveryOwner
    );
  }

  /** @internal Retire evaluated state after an irreversible side effect. */
  public startEvaluationSideEffectRecovery(
    error: Error,
    epoch: TransformCacheEpoch,
    recoveryOwner?: object
  ): CacheRecoveryTransition {
    return this.startRecovery(
      epoch,
      error,
      'evaluation-side-effect',
      undefined,
      recoveryOwner
    );
  }

  private startRecovery(
    epoch: TransformCacheEpoch,
    error: Error,
    reason: CacheRecoveryReason,
    filename?: string,
    recoveryOwner?: object
  ): CacheRecoveryTransition {
    if (epoch.owner !== this.epochOwnerCache) {
      throw new Error('[wyw-in-js] Transform cache epoch has a wrong owner');
    }
    if (epoch === epoch.owner.getCurrentEpoch()) epoch.owner.assertEpoch(epoch);
    return (
      epoch.owner as unknown as CacheLifecycle<TEntrypoint>
    ).beginFailClosedRecovery(
      epoch,
      error,
      reason,
      filename,
      new Set(),
      recoveryOwner
    );
  }

  private beginFailClosedRecovery(
    epoch: TransformCacheEpoch,
    cause: Error,
    reason: CacheRecoveryReason,
    legacySubject?: string,
    legacyUnknownDependencies: ReadonlySet<string> = new Set(),
    recoveryOwner?: object
  ): CacheRecoveryTransition {
    if (epoch !== this.currentEpoch) {
      const abortError =
        this.epochStates.get(epoch)?.abortError ??
        new CacheEpochAbortedError(
          epoch.version,
          this.currentEpoch.version,
          reason,
          cause,
          recoveryOwner
        );
      if (legacySubject !== undefined) {
        this.recordLegacyRecovery(legacySubject, cause, this.lifecycleVersion);
      }
      return {
        abortError,
        started: false,
        complete: () => {},
        fail: () => {},
      };
    }

    const nextEpoch: TransformCacheEpoch = {
      owner: this.epochOwnerCache,
      version: epoch.version + 1,
    };
    const nextState = createPendingEpochState();
    const abortError = new CacheEpochAbortedError(
      epoch.version,
      nextEpoch.version,
      reason,
      cause,
      recoveryOwner
    );
    const fromState = this.epochStates.get(epoch)!;
    fromState.abortError = abortError;
    this.epochStates.set(nextEpoch, nextState);
    this.currentEpoch = nextEpoch;
    fromState.abortController.abort(abortError);
    this.lifecycleVersion += 1;
    this.lifecycleError = abortError;
    this.resetLifecycle();
    this.recordLegacyRecovery(legacySubject, cause, this.lifecycleVersion);
    if (legacySubject !== undefined) this.markInvalidated(legacySubject);
    legacyUnknownDependencies.forEach((dependency) => {
      this.markInvalidated(dependency);
    });

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
          resetEvalBrokersAfterCacheInvalidation(
            this.epochOwnerCache,
            abortError,
            reason
          );
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

  private recordLegacyRecovery(
    subject: string | undefined,
    error: Error,
    version: number
  ): void {
    if (subject === undefined) {
      this.legacyGlobalRecoveryError = { error, version };
    } else {
      this.legacyFileRecoveryErrors.set(subject, { error, version });
    }
  }

  private resetLifecycle(): void {
    const pendingUnknownGraphs = new Map(this.legacyPendingUnknownGraphs);
    const { resetVersion } = this;
    this.clearAllCachesForRecovery();
    this.resetVersion = resetVersion;
    pendingUnknownGraphs.forEach((pending, filename) => {
      this.legacyPendingUnknownGraphs.set(filename, pending);
    });
    this.resetFreshness();
  }

  protected recordEntrypointsCleared(): void {
    this.resetVersion += 1;
    this.legacyPendingUnknownGraphs.clear();
  }
}

export { CacheKeySaltBusyError };
