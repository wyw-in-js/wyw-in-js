import { NOOP_EVAL_PREPARATION_OBSERVER } from '../telemetry/observer';
import type { EventEmitter } from '../utils/EventEmitter';
import { serializeEvalTelemetryJSONl } from './evalTelemetry.jsonl';
import { EVAL_TELEMETRY_SCHEMA } from './evalTelemetry.schema';
import {
  EVAL_PREPARATION_ARTIFACT_LIMIT,
  EVAL_TELEMETRY_SCHEMA_VERSION,
  type EvalBrokerLifecycleMetadata,
  type EvalBrokerMirrorSnapshot,
  type EvalLoadCacheOutcome,
  type EvalOnlyShape,
  type EvalPreparationArtifact,
  type EvalPreparationResult,
  type EvalPreparationStage,
  type EvalPreparationToken,
  type EvalPressureProxy,
  type EvalRootStatus,
  type EvalRunnerSignal,
  type EvalTelemetryRecord,
  type EvalTelemetryRootRecord,
  type EvalTelemetryToken,
} from './evalTelemetry.types';

export {
  type EvalBrokerLifecycleEvent,
  type EvalBrokerLifecycleMetadata,
  type EvalBrokerMirrorSnapshot,
  type EvalLoadCacheOutcome,
  type EvalLoadResendReason,
  type EvalLoadTransmission,
  type EvalPreparationResult,
  type EvalPreparationStage,
  type EvalPreparationToken,
  type EvalPreparedCacheEviction,
  type EvalPressureProxy,
  type EvalRootStatus,
  type EvalRunnerSignal,
  type EvalTelemetryLifecycleRecord,
  type EvalTelemetryRecord,
  type EvalTelemetryRootRecord,
  type EvalTelemetryToken,
} from './evalTelemetry.types';
export { EVAL_TELEMETRY_SCHEMA };

type EvalTelemetrySink = (record: EvalTelemetryRecord) => void;

type BrokerReporterState = {
  brokerId: number;
  runnerActivations: number;
};

type EvalTelemetryReporter = {
  active: boolean;
  allocateBrokerId: () => number;
  brokers: WeakMap<object, BrokerReporterState>;
  sink: EvalTelemetrySink;
};

type MutablePreparationCounters =
  EvalTelemetryRootRecord['loads']['preparation'] & {
    artifactByKey: Map<string, EvalPreparationArtifact> | undefined;
  };

type EvalRootAccumulator = Omit<EvalTelemetryRootRecord, 'loads' | 'root'> & {
  closed: boolean;
  poisonIds: Set<string> | undefined;
  queuedAt: number;
  reporter: EvalTelemetryReporter;
  root: {
    batchIndex: number;
    batchSize: number;
    entrypoint: string;
    startedAt: number | undefined;
  };
  loads: Omit<EvalTelemetryRootRecord['loads'], 'preparation'> & {
    preparation: MutablePreparationCounters;
  };
};

const reporterByEmitter = new WeakMap<EventEmitter, EvalTelemetryReporter>();

export const hasEvalTelemetryReporter = (emitter: EventEmitter): boolean =>
  reporterByEmitter.has(emitter);

const EMPTY_MIRROR = (): EvalBrokerMirrorSnapshot => ({
  entries: 0,
  knownCodeBytes: 0,
  unknownByteEntries: 0,
});

const EMPTY_CACHE_OUTCOMES = (): Record<EvalLoadCacheOutcome, number> => ({
  hit: 0,
  'inflight-hit': 0,
  'inflight-wait': 0,
  'inflight-wait-miss': 0,
  'invalidation-miss': 0,
  miss: 0,
  promotion: 0,
  'serialized-exports': 0,
});

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

export const measureCanonicalImportMapBytes = (
  imports: ReadonlyMap<string, readonly string[]> | null | undefined
): number => {
  if (!imports) return 0;

  const entries = Array.from(
    imports,
    ([specifier, names]) =>
      [specifier, Array.from(new Set(names)).sort(compareStrings)] as const
  ).sort(([left], [right]) => compareStrings(left, right));
  return Buffer.byteLength(JSON.stringify(entries));
};

const getOnlyShape = (only: readonly string[]): EvalOnlyShape => {
  if (only.length === 0) return 'empty';
  return only.includes('*') ? 'wildcard' : 'named';
};

const toCount = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

const toDuration = (finishedAt: number, startedAt: number): number =>
  Math.max(0, finishedAt - startedAt);

const getBrokerState = (
  reporter: EvalTelemetryReporter,
  broker: object
): BrokerReporterState => {
  const existing = reporter.brokers.get(broker);
  if (existing) return existing;

  const created: BrokerReporterState = {
    brokerId: reporter.allocateBrokerId(),
    runnerActivations: 0,
  };
  reporter.brokers.set(broker, created);
  return created;
};

const emitRecord = (
  reporter: EvalTelemetryReporter,
  record: EvalTelemetryRecord
): void => {
  if (!reporter.active) return;
  try {
    reporter.sink(record);
  } catch {
    // Debug reporting must never change evaluation behavior.
  }
};

export const registerEvalTelemetryReporter = (
  emitter: EventEmitter,
  sink: EvalTelemetrySink
): (() => void) => {
  const previous = reporterByEmitter.get(emitter);
  if (previous) previous.active = false;

  let nextBrokerId = 1;
  const reporter: EvalTelemetryReporter = {
    active: true,
    allocateBrokerId: () => {
      const allocated = nextBrokerId;
      nextBrokerId += 1;
      return allocated;
    },
    brokers: new WeakMap(),
    sink,
  };
  reporterByEmitter.set(emitter, reporter);
  let registered = true;

  return () => {
    if (!registered) return;
    registered = false;
    reporter.active = false;
    if (reporterByEmitter.get(emitter) === reporter) {
      reporterByEmitter.delete(emitter);
    }
  };
};

export const registerEvalTelemetryJSONlReporter = (
  emitter: EventEmitter,
  workingDirectory: string,
  sink: (line: string, record: EvalTelemetryRecord) => void
): (() => void) =>
  registerEvalTelemetryReporter(emitter, (record) => {
    sink(serializeEvalTelemetryJSONl(record, workingDirectory), record);
  });

export const recordEvalBrokerLifecycle = (
  emitter: EventEmitter,
  broker: object,
  createMetadata: () => EvalBrokerLifecycleMetadata
): void => {
  const reporter = reporterByEmitter.get(emitter);
  if (!reporter) return;

  let metadata: EvalBrokerLifecycleMetadata;
  try {
    metadata = createMetadata();
  } catch {
    return;
  }

  const brokerState = getBrokerState(reporter, broker);
  const isActivation = metadata.event === 'runner-activated';
  const restartInferred = isActivation && brokerState.runnerActivations > 0;
  if (isActivation) brokerState.runnerActivations += 1;

  emitRecord(reporter, {
    ...metadata,
    brokerId: brokerState.brokerId,
    observedAtMs: performance.now(),
    restartInferred,
    schemaVersion: EVAL_TELEMETRY_SCHEMA_VERSION,
    type: 'eval-lifecycle',
  });
};

const createAccumulator = (
  reporter: EvalTelemetryReporter,
  brokerId: number,
  entrypoint: string
): EvalRootAccumulator => {
  return {
    brokerId,
    closed: false,
    evictions: {
      brokerObservedPoisonIds: 0,
      brokerObservedPoisonSignals: 0,
      brokerObservedResetSignals: 0,
      hostPreparedCache: {
        capacity: 0,
        invalidation: 0,
        knownCodeBytes: 0,
        replacement: 0,
        total: 0,
        unknownByteEntries: 0,
      },
      primaryPressureProxy: { shipmentHashChanges: 0 },
      variantPressureProxy: { shipmentHashChanges: 0 },
    },
    loads: {
      cache: {
        hits: 0,
        inflightHits: 0,
        inflightWaitMisses: 0,
        inflightWaits: 0,
        invalidationMisses: 0,
        misses: 0,
        outcomes: EMPTY_CACHE_OUTCOMES(),
        promotions: 0,
        serializedExports: 0,
      },
      preparation: {
        artifactByKey: undefined,
        artifacts: [],
        calls: 0,
        droppedArtifacts: 0,
        durationMs: 0,
        errors: 0,
        importMapBytes: 0,
        prepareCalls: 0,
        prepareMs: 0,
        preparedCodeBytes: 0,
        shakeCalls: 0,
        shakeMs: 0,
        stripCalls: 0,
        stripMs: 0,
      },
      requests: 0,
      transmission: {
        chunkedResults: 0,
        chunks: 0,
        codeBytes: 0,
        emptyCodePayloads: 0,
        errors: 0,
        incompleteResults: 0,
        initial: 0,
        logicalResults: 0,
        moduleResetSignals: 0,
        omissions: 0,
        resendReasons: {
          'hash-change': 0,
          invalidation: 0,
          'only-widening': 0,
          'storage-shape-change': 0,
        },
        resends: 0,
        serializedExports: 0,
        wireBytes: 0,
        wireMessages: 0,
      },
    },
    mirror: EMPTY_MIRROR(),
    poisonIds: undefined,
    queuedAt: performance.now(),
    reporter,
    root: {
      batchIndex: 0,
      batchSize: 1,
      entrypoint,
      startedAt: undefined,
    },
    schemaVersion: EVAL_TELEMETRY_SCHEMA_VERSION,
    type: 'eval-root',
  };
};

const recordCacheOutcome = (
  accumulator: EvalRootAccumulator,
  outcome: EvalLoadCacheOutcome
): void => {
  const { cache } = accumulator.loads;
  cache.outcomes[outcome] += 1;
  switch (outcome) {
    case 'hit':
      cache.hits += 1;
      break;
    case 'inflight-hit':
      cache.hits += 1;
      cache.inflightHits += 1;
      break;
    case 'inflight-wait':
      cache.inflightWaits += 1;
      break;
    case 'inflight-wait-miss':
      cache.inflightWaitMisses += 1;
      break;
    case 'invalidation-miss':
      cache.invalidationMisses += 1;
      cache.misses += 1;
      break;
    case 'miss':
      cache.misses += 1;
      break;
    case 'promotion':
      cache.misses += 1;
      cache.promotions += 1;
      break;
    case 'serialized-exports':
      cache.serializedExports += 1;
      break;
    default:
      break;
  }
};

const getPreparationArtifactKey = (artifact: EvalPreparationArtifact): string =>
  `${artifact.id}\0${artifact.outputRevision ?? ''}\0${artifact.onlyShape}`;

const mergeArtifact = (
  preparation: MutablePreparationCounters,
  artifact: EvalPreparationArtifact
): void => {
  const counters = preparation;
  let existing: EvalPreparationArtifact | undefined;
  let key: string | undefined;

  if (counters.artifactByKey) {
    key = getPreparationArtifactKey(artifact);
    existing = counters.artifactByKey.get(key);
  } else if (counters.artifacts.length === 1) {
    const first = counters.artifacts[0];
    key = getPreparationArtifactKey(artifact);
    if (getPreparationArtifactKey(first) === key) {
      existing = first;
    } else {
      counters.artifactByKey = new Map([
        [getPreparationArtifactKey(first), first],
      ]);
    }
  }

  if (existing) {
    existing.calls += artifact.calls;
    existing.durationMs += artifact.durationMs;
    existing.errors += artifact.errors;
    existing.importMapBytes += artifact.importMapBytes;
    existing.prepareCalls += artifact.prepareCalls;
    existing.prepareMs += artifact.prepareMs;
    existing.preparedCodeBytes += artifact.preparedCodeBytes;
    existing.shakeCalls += artifact.shakeCalls;
    existing.shakeMs += artifact.shakeMs;
    existing.stripCalls += artifact.stripCalls;
    existing.stripMs += artifact.stripMs;
    return;
  }

  if (counters.artifacts.length >= EVAL_PREPARATION_ARTIFACT_LIMIT) {
    counters.droppedArtifacts += artifact.calls;
    return;
  }

  if (counters.artifactByKey) {
    counters.artifactByKey.set(
      key ?? getPreparationArtifactKey(artifact),
      artifact
    );
  }
  counters.artifacts.push(artifact);
};

const createPreparationToken = (
  accumulator: EvalRootAccumulator,
  id: string,
  requestedOnly: readonly string[]
): EvalPreparationToken => {
  const { preparation } = accumulator.loads;
  preparation.calls += 1;
  const startedAt = performance.now();
  const stageCalls: Record<EvalPreparationStage, number> = {
    prepare: 0,
    shake: 0,
    strip: 0,
  };
  const stageMs: Record<EvalPreparationStage, number> = {
    prepare: 0,
    shake: 0,
    strip: 0,
  };
  let finished = false;

  const complete = (error: boolean, result?: EvalPreparationResult): void => {
    if (finished) return;
    finished = true;
    if (accumulator.closed) return;

    const durationMs = toDuration(performance.now(), startedAt);
    const preparedCodeBytes = result ? Buffer.byteLength(result.code) : 0;
    const importMapBytes = result
      ? measureCanonicalImportMapBytes(result.imports)
      : 0;
    const onlyShape = getOnlyShape(result?.only ?? requestedOnly);
    preparation.durationMs += durationMs;
    preparation.errors += error ? 1 : 0;
    preparation.importMapBytes += importMapBytes;
    preparation.prepareCalls += stageCalls.prepare;
    preparation.prepareMs += stageMs.prepare;
    preparation.preparedCodeBytes += preparedCodeBytes;
    preparation.shakeCalls += stageCalls.shake;
    preparation.shakeMs += stageMs.shake;
    preparation.stripCalls += stageCalls.strip;
    preparation.stripMs += stageMs.strip;

    mergeArtifact(preparation, {
      calls: 1,
      durationMs,
      errors: error ? 1 : 0,
      id,
      importMapBytes,
      onlyShape,
      outputRevision: result?.outputRevision ?? null,
      prepareCalls: stageCalls.prepare,
      prepareMs: stageMs.prepare,
      preparedCodeBytes,
      shakeCalls: stageCalls.shake,
      shakeMs: stageMs.shake,
      stripCalls: stageCalls.strip,
      stripMs: stageMs.strip,
    });
  };

  return {
    fail: () => complete(true),
    finish: (result) => complete(false, result),
    measureStage: <T>(stage: EvalPreparationStage, callback: () => T): T => {
      if (finished || accumulator.closed) return callback();
      stageCalls[stage] += 1;
      const stageStartedAt = performance.now();
      let stageFinished = false;

      try {
        const result = callback();
        if (result instanceof Promise) {
          const finishAsyncStage = (): void => {
            if (stageFinished || accumulator.closed) return;
            stageFinished = true;
            stageMs[stage] += toDuration(performance.now(), stageStartedAt);
          };
          result.then(finishAsyncStage, finishAsyncStage);
        } else if (!accumulator.closed) {
          stageFinished = true;
          stageMs[stage] += toDuration(performance.now(), stageStartedAt);
        }
        return result;
      } catch (error) {
        if (!stageFinished && !accumulator.closed) {
          stageFinished = true;
          stageMs[stage] += toDuration(performance.now(), stageStartedAt);
        }
        throw error;
      }
    },
  };
};

const releaseAccumulator = (accumulator: EvalRootAccumulator): void => {
  accumulator.loads.preparation.artifactByKey?.clear();
  accumulator.poisonIds?.clear();
};

const finishRoot = (
  accumulator: EvalRootAccumulator,
  status: EvalRootStatus,
  mirror?: EvalBrokerMirrorSnapshot
): void => {
  if (accumulator.closed) return;
  accumulator.closed = true;
  const finishedAt = performance.now();
  const { startedAt } = accumulator.root;
  if (mirror) accumulator.mirror = { ...mirror };

  const { artifactByKey, ...preparation } = accumulator.loads.preparation;
  artifactByKey?.clear();
  const record: EvalTelemetryRootRecord = {
    brokerId: accumulator.brokerId,
    evictions: accumulator.evictions,
    loads: {
      ...accumulator.loads,
      preparation,
    },
    mirror: accumulator.mirror,
    root: {
      batchIndex: accumulator.root.batchIndex,
      batchSize: accumulator.root.batchSize,
      durationMs:
        startedAt === undefined ? 0 : toDuration(finishedAt, startedAt),
      entrypoint: accumulator.root.entrypoint,
      queueWaitMs: toDuration(startedAt ?? finishedAt, accumulator.queuedAt),
      status,
    },
    schemaVersion: EVAL_TELEMETRY_SCHEMA_VERSION,
    type: 'eval-root',
  };
  emitRecord(accumulator.reporter, record);
  releaseAccumulator(accumulator);
};

export const beginEvalTelemetry = (
  emitter: EventEmitter,
  broker: object,
  createRoot: () => { entrypoint: string }
): EvalTelemetryToken | undefined => {
  const reporter = reporterByEmitter.get(emitter);
  if (!reporter) return undefined;

  let entrypoint: string;
  try {
    entrypoint = createRoot().entrypoint;
  } catch {
    return undefined;
  }

  const brokerState = getBrokerState(reporter, broker);
  const accumulator = createAccumulator(
    reporter,
    brokerState.brokerId,
    entrypoint
  );

  return {
    beginPreparation: (id, only) =>
      accumulator.closed
        ? NOOP_EVAL_PREPARATION_OBSERVER
        : createPreparationToken(accumulator, id, only),
    finish: (status, mirror) => finishRoot(accumulator, status, mirror),
    recordLoadCacheOutcome: (outcome) => {
      if (!accumulator.closed) recordCacheOutcome(accumulator, outcome);
    },
    recordLoadRequest: () => {
      if (!accumulator.closed) accumulator.loads.requests += 1;
    },
    recordLoadTransmission: (transmission) => {
      if (accumulator.closed) return;
      const counters = accumulator.loads.transmission;
      const logicalResults = toCount(
        transmission.logicalResults ?? (transmission.incomplete ? 0 : 1)
      );
      const wireMessages = toCount(transmission.wireMessages);
      const chunks = toCount(transmission.chunks ?? 0);
      counters.logicalResults += logicalResults;
      counters.wireMessages += wireMessages;
      counters.wireBytes += toCount(transmission.wireBytes);
      counters.chunks += chunks;
      counters.incompleteResults += transmission.incomplete ? 1 : 0;
      if (transmission.moduleReset) {
        counters.moduleResetSignals += logicalResults;
      }
      if (transmission.codeBytes !== undefined) {
        counters.codeBytes += toCount(transmission.codeBytes);
      } else if (typeof transmission.code === 'string') {
        counters.codeBytes += Buffer.byteLength(transmission.code);
      }
      if (transmission.code === '') counters.emptyCodePayloads += 1;
      if (chunks > 0) {
        counters.chunkedResults += logicalResults;
      }
      switch (transmission.mode) {
        case 'error':
          counters.errors += logicalResults;
          break;
        case 'initial':
          counters.initial += logicalResults;
          break;
        case 'omission':
          counters.omissions += logicalResults;
          break;
        case 'resend':
          counters.resends += logicalResults;
          if (transmission.resendReason) {
            counters.resendReasons[transmission.resendReason] += logicalResults;
          }
          break;
        case 'serialized-exports':
          counters.serializedExports += logicalResults;
          break;
        default:
          break;
      }
    },
    recordPreparedCacheEviction: (eviction) => {
      if (accumulator.closed) return;
      const counters = accumulator.evictions.hostPreparedCache;
      counters.total += 1;
      counters[eviction.reason] += 1;
      if (eviction.knownCodeBytes === undefined) {
        counters.unknownByteEntries += 1;
      } else {
        counters.knownCodeBytes += toCount(eviction.knownCodeBytes);
      }
    },
    recordPressureProxy: (proxy: EvalPressureProxy) => {
      if (accumulator.closed) return;
      const count = toCount(proxy.count ?? 1);
      const counters =
        proxy.store === 'primary'
          ? accumulator.evictions.primaryPressureProxy
          : accumulator.evictions.variantPressureProxy;
      counters.shipmentHashChanges += count;
    },
    recordRunnerSignal: (signal: EvalRunnerSignal) => {
      if (accumulator.closed) return;
      if (signal.type === 'modules-reset') {
        accumulator.evictions.brokerObservedResetSignals += 1;
        return;
      }

      accumulator.evictions.brokerObservedPoisonSignals += 1;
      const poisonIds =
        accumulator.poisonIds ?? (accumulator.poisonIds = new Set());
      signal.ids.forEach((id) => poisonIds.add(id));
      accumulator.evictions.brokerObservedPoisonIds = poisonIds.size;
    },
    start: ({ batchIndex, batchSize }) => {
      if (accumulator.closed || accumulator.root.startedAt !== undefined) {
        return;
      }
      accumulator.root.batchIndex = toCount(batchIndex);
      accumulator.root.batchSize = toCount(batchSize);
      accumulator.root.startedAt = performance.now();
    },
  };
};
