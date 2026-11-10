import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The telemetry observer of the transform pipeline and of evaluation. Hot
 * paths report to an observer without checking whether telemetry is on: the
 * no-op adapters here do nothing, and the recording adapters in `debug/`
 * accumulate the records a reporter writes. This module depends on nothing in
 * `debug/`, so hot paths never load the recording code.
 */

export type CacheName = 'barrelManifests' | 'entrypoints' | 'exports';
export type CacheOperation = 'get' | 'has';
export type EntrypointStatus = 'cached' | 'created' | 'loop';
export type ParseKind = 'cached' | 'uncached';
export type RootStatus = 'error' | 'ignored' | 'soft-error' | 'success';

export type PipelineCacheSaltOutcome =
  | 'clear'
  | 'disable'
  | 'migrate'
  | 'unchanged';

export type PipelineNoMetadataPhase = 'collect' | 'preeval';

export type PipelineCleanupOutcome =
  | 'cap'
  | 'converged'
  | 'error'
  | 'rollback'
  | 'stalled';

/** What an observer measured about parsed code; parse cache entries keep it. */
export type PipelineParseMeasurement = {
  bytes: number;
  revision: string;
};

export interface PipelineCleanupObserver {
  finish(outcome: PipelineCleanupOutcome): void;
  recordIteration(
    code: string,
    mergedRanges: readonly { end: number; start: number }[],
    committed: boolean,
    scopedDeclarations: number,
    topLevelDeclarations: number,
    generatedHelpers: number,
    imports: number,
    expressions: number,
    emptyBlocks: number
  ): void;
}

export interface PipelineObserver {
  beginCleanup(filename: string): PipelineCleanupObserver;
  markRootStatus(status: RootStatus): void;
  /** Runs the dangerous-code removal of a file. */
  observeDangerousCode<T>(filename: string, removeDangerousCode: () => T): T;
  /** Runs one shake of `inputCode`. */
  observeShake<T extends { code: string }>(
    inputCode: string,
    only: readonly string[],
    mode: string,
    shake: () => T
  ): T;
  recordCacheClear(
    cache: CacheName,
    reason: string,
    removedEntries: number
  ): void;
  recordCacheRequest(
    cache: CacheName,
    operation: CacheOperation,
    hit: boolean
  ): void;
  recordCacheSalt(
    previous: string | null,
    current: string | null,
    outcome: PipelineCacheSaltOutcome
  ): void;
  recordCachedParseHit(
    cacheEntry: object,
    filename: string,
    code: string,
    sourceType: string,
    astType: string,
    jsxFallback: boolean,
    knownMeasurement?: PipelineParseMeasurement
  ): PipelineParseMeasurement | undefined;
  recordCachedParseMiss(
    filename: string,
    code: string,
    sourceType: string,
    astType: string,
    jsxFallback: boolean,
    error: boolean,
    cacheEntry?: object
  ): PipelineParseMeasurement | undefined;
  recordDisposableRoot(filename: string, phase: PipelineNoMetadataPhase): void;
  recordEntrypoint(
    isRoot: boolean,
    isInitial: boolean,
    status: EntrypointStatus,
    only: readonly string[]
  ): void;
  recordLateNoMetadata(
    filename: string,
    only: readonly string[],
    phase: PipelineNoMetadataPhase
  ): void;
  recordProcessors(
    phase: string,
    reusedPlan: boolean,
    importCandidates: number,
    lookupAttempts: number,
    lookupHits: number,
    definedProcessors: number,
    usages: number
  ): void;
  recordRawTransferFallback(
    filename: string,
    code: string,
    sourceType: string,
    astType: string,
    kind: ParseKind,
    jsxFallbackAllowed: boolean
  ): void;
  recordUncachedParse(
    filename: string,
    code: string,
    sourceType: string,
    astType: string,
    error: boolean,
    jsxFallback?: boolean,
    jsxFallbackAllowed?: boolean
  ): void;
}

/** The observer of one transform root; told once when the root settles. */
export interface PipelineRootObserver extends PipelineObserver {
  finishRoot(failed: boolean): void;
}

const noop = (): void => {};
const NOOP_CLEANUP_OBSERVER: PipelineCleanupObserver = {
  finish: noop,
  recordIteration: noop,
};

export const NOOP_PIPELINE_OBSERVER: PipelineObserver = {
  beginCleanup: () => NOOP_CLEANUP_OBSERVER,
  markRootStatus: noop,
  observeDangerousCode: (_filename, removeDangerousCode) =>
    removeDangerousCode(),
  observeShake: (_inputCode, _only, _mode, shake) => shake(),
  recordCacheClear: noop,
  recordCacheRequest: noop,
  recordCacheSalt: noop,
  recordCachedParseHit: () => undefined,
  recordCachedParseMiss: () => undefined,
  recordDisposableRoot: noop,
  recordEntrypoint: noop,
  recordLateNoMetadata: noop,
  recordProcessors: noop,
  recordRawTransferFallback: noop,
  recordUncachedParse: noop,
};

// The root scope. The counter lets the common case, no observed root at all,
// skip the AsyncLocalStorage lookup; it changes only in runWithPipelineObserver.
const observerStorage = new AsyncLocalStorage<PipelineObserver | undefined>();
let activeObservedRoots = 0;

/** The observer of the transform root that the current work belongs to. */
export const currentPipelineObserver = (): PipelineObserver => {
  if (activeObservedRoots === 0) {
    return NOOP_PIPELINE_OBSERVER;
  }

  return observerStorage.getStore() ?? NOOP_PIPELINE_OBSERVER;
};

/**
 * Runs the work of one transform root under `observer`. Without an observer
 * the work of the root is observed by no one: it stays out of an enclosing
 * observed root, as a nested transform without a reporter must.
 */
export const runWithPipelineObserver = <T>(
  observer: PipelineRootObserver | undefined,
  callback: () => T
): T => {
  if (!observer) {
    return activeObservedRoots === 0
      ? callback()
      : observerStorage.run(undefined, callback);
  }

  activeObservedRoots += 1;
  const finish = (failed: boolean) => {
    activeObservedRoots -= 1;
    observer.finishRoot(failed);
  };

  try {
    const result = observerStorage.run(observer, callback);
    if (result instanceof Promise) {
      result.then(
        () => finish(false),
        () => finish(true)
      );
      return result;
    }

    finish(false);
    return result;
  } catch (error) {
    finish(true);
    throw error;
  }
};

export type EvalRootStatus = 'error' | 'no-values' | 'success';

export type EvalPreparationStage = 'prepare' | 'shake' | 'strip';

export type EvalLoadCacheOutcome =
  | 'hit'
  | 'inflight-hit'
  | 'inflight-wait'
  | 'inflight-wait-miss'
  | 'invalidation-miss'
  | 'miss'
  | 'promotion'
  | 'serialized-exports';

export type EvalLoadResendReason =
  | 'hash-change'
  | 'invalidation'
  | 'only-widening'
  | 'storage-shape-change';

export type EvalLoadTransmission = {
  /** Physical messages carrying `codeChunk`; zero for an unchunked result. */
  chunks?: number;
  /** Code supplied in the logical LOAD_RESULT. An empty string is a payload. */
  code?: string;
  /** Successfully written code bytes for an incomplete chunked response. */
  codeBytes?: number;
  /** True when the logical response did not finish writing. */
  incomplete?: boolean;
  /** One for a normal result, greater than one only if callers coalesce work. */
  logicalResults?: number;
  mode: 'error' | 'initial' | 'omission' | 'resend' | 'serialized-exports';
  /** True when the logical result instructs the runner to reset this module. */
  moduleReset?: boolean;
  resendReason?: EvalLoadResendReason;
  /** Number of physical LOAD_RESULT messages written for the logical result. */
  wireMessages: number;
  /** UTF-8 bytes measured from the already serialized wire messages. */
  wireBytes: number;
};

export type EvalPreparedCacheEviction = {
  id: string;
  knownCodeBytes?: number;
  reason: 'capacity' | 'invalidation' | 'replacement';
};

export type EvalPressureProxy = {
  count?: number;
  store: 'primary' | 'variant';
  type: 'shipment-hash-change';
};

export type EvalRunnerSignal =
  | {
      type: 'modules-reset';
    }
  | {
      ids: readonly string[];
      type: 'poison-ids';
    };

export type EvalBrokerMirrorSnapshot = {
  entries: number;
  knownCodeBytes: number;
  unknownByteEntries: number;
};

export type EvalPreparationResult = {
  code: string;
  imports: ReadonlyMap<string, readonly string[]> | null;
  only: readonly string[];
  outputRevision: string;
};

/** Observes the preparation of one module for evaluation. */
export type EvalPreparationObserver = {
  fail: () => void;
  finish: (result: EvalPreparationResult) => void;
  measureStage: <T>(stage: EvalPreparationStage, callback: () => T) => T;
};

/** Observes the evaluation of one root by the eval broker. */
export type EvalObserver = {
  beginPreparation: (
    id: string,
    only: readonly string[]
  ) => EvalPreparationObserver;
  finish: (status: EvalRootStatus, mirror?: EvalBrokerMirrorSnapshot) => void;
  recordLoadCacheOutcome: (outcome: EvalLoadCacheOutcome) => void;
  recordLoadRequest: () => void;
  recordLoadTransmission: (transmission: EvalLoadTransmission) => void;
  recordPreparedCacheEviction: (eviction: EvalPreparedCacheEviction) => void;
  recordPressureProxy: (proxy: EvalPressureProxy) => void;
  recordRunnerSignal: (signal: EvalRunnerSignal) => void;
  start: (batch: { batchIndex: number; batchSize: number }) => void;
};

export const NOOP_EVAL_PREPARATION_OBSERVER: EvalPreparationObserver = {
  fail: noop,
  finish: noop,
  measureStage: (_stage, callback) => callback(),
};
