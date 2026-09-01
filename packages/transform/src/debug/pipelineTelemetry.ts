import { AsyncLocalStorage } from 'node:async_hooks';

import type { EventEmitter } from '../utils/EventEmitter';
import {
  getOxcParserLanguage,
  type OxcParserLanguage,
} from '../utils/oxcParserLanguage';
import { serializePipelineTelemetryJSONl } from './pipelineTelemetry.jsonl';
import {
  getCodeMeasurement,
  measureBytes,
  measureCode,
  setMissingCodeMeasurement,
  type CompletedCodeMeasurement,
} from './pipelineTelemetry.measurements';
import { PIPELINE_TELEMETRY_SCHEMA } from './pipelineTelemetry.schema';
import {
  createAccumulator,
  normalizeOnly,
  releaseAccumulator,
} from './pipelineTelemetry.state';
import {
  buildCompactPipelineTelemetrySummary,
  buildPipelineTelemetrySummary,
  type PipelineTelemetryCompactSummary,
  type PipelineTelemetrySummary,
} from './pipelineTelemetry.summary';
import type {
  CacheName,
  CacheOperation,
  EntrypointStatus,
  ParseKind,
  PipelineAccumulator,
  PipelineCacheSaltOutcome,
  PipelineCleanupOutcome,
  PipelineCleanupToken,
  PipelineDangerousCodeToken,
  PipelineNoMetadataPhase,
  PipelineShakeToken,
  ParseRevisionCounter,
  ProcessorCounter,
  RootStatus,
} from './pipelineTelemetry.types';

const EMPTY_PROCESSOR_COUNTER = (): ProcessorCounter => ({
  definedProcessors: 0,
  importCandidates: 0,
  lookupAttempts: 0,
  lookupHits: 0,
  passes: 0,
  reusedPlans: 0,
  usages: 0,
});

const addProcessorCounter = (
  counter: ProcessorCounter,
  reusedPlan: boolean,
  importCandidates: number,
  lookupAttempts: number,
  lookupHits: number,
  definedProcessors: number,
  usages: number
): void => {
  const target = counter;
  target.definedProcessors += definedProcessors;
  target.importCandidates += importCandidates;
  target.lookupAttempts += lookupAttempts;
  target.lookupHits += lookupHits;
  target.passes += 1;
  target.reusedPlans += reusedPlan ? 1 : 0;
  target.usages += usages;
};

const CACHE_OPERATION_INDEX = {
  barrelManifests: { get: 0, has: 1 },
  entrypoints: { get: 2, has: 3 },
  exports: { get: 4, has: 5 },
} satisfies Record<CacheName, Record<CacheOperation, number>>;
export {
  PIPELINE_TELEMETRY_SCHEMA,
  type PipelineTelemetryCompactSummary,
  type PipelineTelemetrySummary,
};

const telemetryStorage = new AsyncLocalStorage<
  PipelineAccumulator | undefined
>();
const reporterByEmitter = new WeakMap<
  EventEmitter,
  PipelineTelemetryReporter
>();
let activeTelemetryRoots = 0;

const getAccumulator = (): PipelineAccumulator | undefined => {
  if (activeTelemetryRoots === 0) {
    return undefined;
  }

  const accumulator = telemetryStorage.getStore();
  return accumulator && !accumulator.closed ? accumulator : undefined;
};

type PipelineTelemetryReporterSink =
  | ((summary: PipelineTelemetrySummary) => void)
  | ((summary: PipelineTelemetryCompactSummary) => void);
type PipelineTelemetrySink = (
  summary: PipelineTelemetrySummary | PipelineTelemetryCompactSummary
) => void;
type PipelineTelemetryReporter = {
  codeMeasurements: PipelineAccumulator['codeMeasurements'];
  emit: (accumulator: PipelineAccumulator) => void;
};

export const hasPipelineTelemetryReporter = (emitter: EventEmitter): boolean =>
  reporterByEmitter.has(emitter);

export const isPipelineTelemetryActive = (): boolean =>
  getAccumulator() !== undefined;

const registerPipelineTelemetryEmitter = (
  emitter: EventEmitter,
  emit: PipelineTelemetryReporter['emit']
): (() => void) => {
  const codeMeasurementEntries: PipelineAccumulator['codeMeasurements']['entries'] =
    new Map();
  const reporter: PipelineTelemetryReporter = {
    codeMeasurements: {
      codeUnits: 0,
      count: 0,
      entries: codeMeasurementEntries,
      evictionKeys: codeMeasurementEntries.keys(),
    },
    emit,
  };
  reporterByEmitter.set(emitter, reporter);
  let registered = true;

  return () => {
    if (!registered) {
      return;
    }

    registered = false;
    reporter.codeMeasurements.entries.clear();
    reporter.codeMeasurements.evictionKeys =
      reporter.codeMeasurements.entries.keys();
    reporter.codeMeasurements.codeUnits = 0;
    reporter.codeMeasurements.count = 0;
    if (reporterByEmitter.get(emitter) === reporter) {
      reporterByEmitter.delete(emitter);
    }
  };
};

export const getPipelineCodeSha256Hex = (code: string): string | undefined => {
  const accumulator = getAccumulator();
  if (!accumulator) return undefined;

  try {
    const measurement = getCodeMeasurement(accumulator, code);
    if (!measurement) return undefined;
    if (measurement.sha256Hex === undefined) {
      measurement.sha256Hex = Buffer.from(
        measurement.revision,
        'base64url'
      ).toString('hex');
    }
    return measurement.sha256Hex;
  } catch {
    return undefined;
  }
};

export const primePipelineCodeSha256Hex = (
  code: string,
  sha256Hex: string
): void => {
  const accumulator = getAccumulator();
  if (!accumulator) return;

  try {
    if (!/^[\da-f]{64}$/u.test(sha256Hex)) return;
    setMissingCodeMeasurement(accumulator, code, {
      bytes: Buffer.byteLength(code),
      revision: Buffer.from(sha256Hex, 'hex').toString('base64url'),
      sha256Hex,
    });
  } catch {
    // Debug measurement failures must not affect transform cache behavior.
  }
};

export const runWithoutPipelineTelemetry = <T>(callback: () => T): T =>
  telemetryStorage.run(undefined, callback);

export function registerPipelineTelemetryReporter(
  emitter: EventEmitter,
  sink: (summary: PipelineTelemetrySummary) => void
): () => void;
export function registerPipelineTelemetryReporter(
  emitter: EventEmitter,
  sink: (summary: PipelineTelemetryCompactSummary) => void,
  compact: true
): () => void;
export function registerPipelineTelemetryReporter(
  emitter: EventEmitter,
  sink: PipelineTelemetryReporterSink,
  compact = false
): () => void {
  const pipelineSink = sink as PipelineTelemetrySink;
  return registerPipelineTelemetryEmitter(emitter, (accumulator) => {
    pipelineSink(
      compact
        ? buildCompactPipelineTelemetrySummary(accumulator)
        : buildPipelineTelemetrySummary(accumulator)
    );
  });
}

export const registerPipelineTelemetryJSONlReporter = (
  emitter: EventEmitter,
  workingDirectory: string,
  sink: (line: string, status: RootStatus) => void
): (() => void) =>
  registerPipelineTelemetryEmitter(emitter, (accumulator) =>
    sink(
      serializePipelineTelemetryJSONl(accumulator, workingDirectory),
      accumulator.root.status
    )
  );

export const runWithPipelineTelemetry = <T>(
  emitter: EventEmitter,
  createRoot: () => { filename: string },
  callback: () => T
): T => {
  const reporter = reporterByEmitter.get(emitter);
  if (!reporter) {
    return callback();
  }

  let accumulator: PipelineAccumulator;
  try {
    accumulator = createAccumulator(
      createRoot().filename,
      reporter.codeMeasurements
    );
  } catch {
    return callback();
  }

  activeTelemetryRoots += 1;
  const finish = () => {
    activeTelemetryRoots -= 1;
    try {
      reporter.emit(accumulator);
    } catch {
      // Debug reporting must never change transform behavior.
    } finally {
      releaseAccumulator(accumulator);
    }
  };

  try {
    const result = telemetryStorage.run(accumulator, callback);
    if (result instanceof Promise) {
      result.then(finish, () => {
        accumulator.root.status = 'error';
        finish();
      });
      return result;
    }

    finish();
    return result;
  } catch (error) {
    accumulator.root.status = 'error';
    finish();
    throw error;
  }
};

export const markPipelineRootStatus = (status: RootStatus): void => {
  const accumulator = getAccumulator();
  if (accumulator) {
    accumulator.root.status = status;
  }
};

export const recordPipelineCacheRequest = (
  cache: CacheName,
  operation: CacheOperation,
  hit: boolean
): void => {
  const accumulator = getAccumulator();
  if (!accumulator) {
    return;
  }

  const index = CACHE_OPERATION_INDEX[cache][operation];
  let counter = accumulator.cache.byOperation[index];
  if (!counter) {
    counter = { hits: 0, misses: 0, requests: 0 };
    accumulator.cache.byOperation[index] = counter;
  }
  counter.requests += 1;
  if (hit) {
    counter.hits += 1;
  } else {
    counter.misses += 1;
  }
};

export const recordPipelineCacheSalt = (
  previous: string | null,
  current: string | null,
  outcome: PipelineCacheSaltOutcome
): void => {
  const accumulator = getAccumulator();
  if (!accumulator) {
    return;
  }

  if (outcome !== 'unchanged') {
    accumulator.cache.salt.changes.push({ current, outcome, previous });
  }
  if (outcome === 'unchanged') accumulator.cache.salt.unchanged += 1;
};

export const recordPipelineCacheClear = (
  cache: CacheName,
  reason: string,
  removedEntries: number
): void => {
  const accumulator = getAccumulator();
  if (!accumulator) {
    return;
  }

  const key = `${cache}\0${reason}`;
  let counter = accumulator.cache.clearReasons.get(key);
  if (!counter) {
    counter = { cache, entries: 0, reason, requests: 0 };
    accumulator.cache.clearReasons.set(key, counter);
  }
  counter.entries += removedEntries;
  counter.requests += 1;
};

export const recordPipelineEntrypoint = (
  isRoot: boolean,
  isInitial: boolean,
  status: EntrypointStatus,
  only: readonly string[]
): void => {
  const accumulator = getAccumulator();
  if (!accumulator) {
    return;
  }

  const { key: onlyKey, only: normalizedOnly } = normalizeOnly(
    accumulator,
    only
  );
  let onlyCounter = accumulator.entrypoints.byOnly.get(onlyKey);
  if (!onlyCounter) {
    onlyCounter = { count: 0, only: normalizedOnly };
    accumulator.entrypoints.byOnly.set(onlyKey, onlyCounter);
  }
  onlyCounter.count += 1;
  if (isRoot) {
    accumulator.entrypoints.roots += 1;
    if (isInitial) accumulator.entrypoints.initialRoots += 1;
  } else {
    accumulator.entrypoints.children += 1;
  }
  if (status === 'created') accumulator.entrypoints.created += 1;
  if (status === 'cached') accumulator.entrypoints.cached += 1;
  if (status === 'loop') accumulator.entrypoints.loops += 1;
};

export const recordPipelineDisposableRoot = (
  filename: string,
  phase: PipelineNoMetadataPhase
): void => {
  const accumulator = getAccumulator();
  if (!accumulator || accumulator.root.filename !== filename) {
    return;
  }

  accumulator.entrypoints.disposableRootsByPhase.set(
    phase,
    (accumulator.entrypoints.disposableRootsByPhase.get(phase) ?? 0) + 1
  );
};

const PIPELINE_PARSER_LANGUAGE_INDEX = {
  js: 0,
  jsx: 1,
  ts: 2,
  tsx: 3,
  dts: 4,
} as const satisfies Record<OxcParserLanguage, number>;

const createPipelineParserKey = (
  sourceType: string,
  filename: string,
  astType: string,
  jsxFallbackAllowed: boolean
): number | string => {
  const language = getOxcParserLanguage(filename);
  if (
    (sourceType === 'module' || sourceType === 'unambiguous') &&
    (astType === 'js' || astType === 'ts')
  ) {
    const sourceTypeIndex = sourceType === 'module' ? 0 : 1;
    const astTypeIndex = astType === 'js' ? 0 : 1;
    const parserKeyIndex =
      sourceTypeIndex * 20 +
      PIPELINE_PARSER_LANGUAGE_INDEX[language] * 4 +
      astTypeIndex * 2 +
      (jsxFallbackAllowed ? 1 : 0);
    return parserKeyIndex;
  }

  return `oxc:${sourceType}:${language}:${astType}:r1:j${
    jsxFallbackAllowed ? 1 : 0
  }`;
};

const updatePipelineParseMissCounters = (
  revision: ParseRevisionCounter,
  kind: ParseKind,
  jsxFallback: boolean,
  error: boolean
): void => {
  const counter = revision;
  counter.requests += 1;
  if (kind === 'cached') counter.cacheMisses += 1;
  if (jsxFallback) {
    counter.jsxFallbackRequests += 1;
    counter.jsxFallbackAttempts += 1;
  }
  if (error) {
    counter.errors += 1;
  }
};

const updatePipelineCachedHitCounters = (
  revision: ParseRevisionCounter,
  jsxFallback: boolean
): void => {
  const counter = revision;
  counter.requests += 1;
  counter.cacheHits += 1;
  if (jsxFallback) {
    counter.jsxFallbackRequests += 1;
  }
};

const getPipelineParseRevision = (
  accumulator: PipelineAccumulator,
  parserKey: ParseRevisionCounter['parserKey'],
  kind: ParseKind,
  measurement: CompletedCodeMeasurement
) => {
  const { revision: revisionKey } = measurement;
  const bucket = accumulator.parse.revisionBuckets.get(measurement);
  if (bucket) {
    if (Array.isArray(bucket)) {
      for (const existing of bucket) {
        if (existing.parserKey === parserKey && existing.kind === kind) {
          return existing;
        }
      }
    } else if (bucket.parserKey === parserKey && bucket.kind === kind) {
      return bucket;
    }
  }

  const revision: ParseRevisionCounter = {
    bytes: measurement.bytes,
    cacheHits: 0,
    cacheMisses: 0,
    errors: 0,
    jsxFallbackAttempts: 0,
    jsxFallbackRequests: 0,
    kind,
    parserKey,
    requests: 0,
    revision: revisionKey,
  };
  if (!bucket) {
    accumulator.parse.revisionBuckets.set(measurement, revision);
  } else if (Array.isArray(bucket)) {
    bucket.push(revision);
  } else {
    accumulator.parse.revisionBuckets.set(measurement, [bucket, revision]);
  }
  accumulator.parse.revisions.push(revision);
  return revision;
};

export const recordPipelineCachedParseHit = (
  cacheEntry: object,
  filename: string,
  code: string,
  sourceType: string,
  jsxFallback: boolean,
  knownMeasurement?: CompletedCodeMeasurement
): CompletedCodeMeasurement | undefined => {
  const accumulator = getAccumulator();
  if (!accumulator) {
    return undefined;
  }

  if (knownMeasurement) {
    const knownRevision = accumulator.parse.cachedRevisions.get(cacheEntry);
    if (knownRevision) {
      updatePipelineCachedHitCounters(knownRevision, jsxFallback);
      return knownMeasurement;
    }
  }

  let measurement: CompletedCodeMeasurement;
  try {
    measurement = knownMeasurement
      ? getCodeMeasurement(accumulator, code) ??
        setMissingCodeMeasurement(accumulator, code, knownMeasurement)
      : measureCode(accumulator, code, false);
  } catch {
    return undefined;
  }
  let revision = accumulator.parse.cachedRevisions.get(cacheEntry);
  if (!revision) {
    const astType =
      filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'ts' : 'js';
    revision = getPipelineParseRevision(
      accumulator,
      createPipelineParserKey(
        sourceType,
        filename,
        astType,
        filename.endsWith('.js')
      ),
      'cached',
      measurement
    );
    accumulator.parse.cachedRevisions.set(cacheEntry, revision);
  }
  updatePipelineCachedHitCounters(revision, jsxFallback);
  return measurement;
};

const recordPipelineParseMiss = (
  filename: string,
  code: string,
  sourceType: string,
  astType: string,
  kind: ParseKind,
  jsxFallback: boolean,
  error: boolean,
  jsxFallbackAllowed: boolean,
  cacheEntry?: object
): CompletedCodeMeasurement | undefined => {
  const accumulator = getAccumulator();
  if (!accumulator) return undefined;

  try {
    const measurement = measureCode(accumulator, code);
    const revision = getPipelineParseRevision(
      accumulator,
      createPipelineParserKey(
        sourceType,
        filename,
        astType,
        jsxFallbackAllowed
      ),
      kind,
      measurement
    );
    if (cacheEntry) {
      accumulator.parse.cachedRevisions.set(cacheEntry, revision);
    }
    updatePipelineParseMissCounters(revision, kind, jsxFallback, error);
    return measurement;
  } catch {
    // Debug reporting must never change parser behavior or its errors.
    return undefined;
  }
};

export const recordPipelineCachedParseMiss = (
  filename: string,
  code: string,
  sourceType: string,
  astType: string,
  jsxFallback: boolean,
  error: boolean,
  cacheEntry?: object
): CompletedCodeMeasurement | undefined =>
  recordPipelineParseMiss(
    filename,
    code,
    sourceType,
    astType,
    'cached',
    jsxFallback,
    error,
    filename.endsWith('.js'),
    cacheEntry
  );

export const recordPipelineUncachedParse = (
  filename: string,
  code: string,
  sourceType: string,
  astType: string,
  error: boolean
): void => {
  recordPipelineParseMiss(
    filename,
    code,
    sourceType,
    astType,
    'uncached',
    false,
    error,
    false
  );
};

export const recordPipelineProcessors = (
  phase: string,
  reusedPlan: boolean,
  importCandidates: number,
  lookupAttempts: number,
  lookupHits: number,
  definedProcessors: number,
  usages: number
): void => {
  const accumulator = getAccumulator();
  if (!accumulator) {
    return;
  }

  let phaseCounter = accumulator.processors.byPhase.get(phase);
  if (!phaseCounter) {
    phaseCounter = EMPTY_PROCESSOR_COUNTER();
    accumulator.processors.byPhase.set(phase, phaseCounter);
  }
  addProcessorCounter(
    phaseCounter,
    reusedPlan,
    importCandidates,
    lookupAttempts,
    lookupHits,
    definedProcessors,
    usages
  );
};

export const beginPipelineDangerousCode = (
  filename: string
): PipelineDangerousCodeToken => {
  const accumulator = getAccumulator();
  if (!accumulator) {
    return undefined;
  }

  return {
    accumulator,
    filename,
    finished: false,
    startedAt: performance.now(),
  };
};

export const finishPipelineDangerousCode = (
  token: PipelineDangerousCodeToken
): void => {
  if (!token || token.finished || token.accumulator.closed) {
    return;
  }
  const dangerousToken = token;
  dangerousToken.finished = true;
  let current = dangerousToken.accumulator.dangerousByFile.get(
    dangerousToken.filename
  );
  if (!current) {
    current = { calls: 0, durationMs: 0 };
    dangerousToken.accumulator.dangerousByFile.set(
      dangerousToken.filename,
      current
    );
  }
  current.calls += 1;
  current.durationMs += performance.now() - dangerousToken.startedAt;
};

export const recordPipelineLateNoMetadata = (
  filename: string,
  only: readonly string[],
  phase: PipelineNoMetadataPhase
): void => {
  const accumulator = getAccumulator();
  if (!accumulator) {
    return;
  }

  accumulator.lateNoMetadata.push({
    filename,
    only: normalizeOnly(accumulator, only).only,
    phase,
  });
};

export const beginPipelineShake = (
  inputCode: string,
  only: readonly string[],
  mode: string
): PipelineShakeToken => {
  const accumulator = getAccumulator();
  if (!accumulator) {
    return undefined;
  }

  let inputBytes: number;
  let inputRevision: string;
  let normalizedOnly: string[];
  try {
    const measurement = measureCode(accumulator, inputCode);
    inputBytes = measurement.bytes;
    inputRevision = measurement.revision;
    normalizedOnly = normalizeOnly(accumulator, only).only;
  } catch {
    return undefined;
  }
  accumulator.shakes.attempts += 1;
  return {
    accumulator,
    finished: false,
    inputBytes,
    inputRevision,
    mode,
    only: normalizedOnly,
  };
};

export const finishPipelineShake = (
  token: PipelineShakeToken,
  outputCode: string | null,
  error: boolean
): void => {
  if (!token || token.finished || token.accumulator.closed) {
    return;
  }
  const shakeToken = token;
  shakeToken.finished = true;
  let generatedBytes = 0;
  let outputRevision: string | null = null;
  try {
    if (outputCode !== null) {
      const measurement = measureCode(shakeToken.accumulator, outputCode);
      generatedBytes = measurement.bytes;
      outputRevision = measurement.revision;
    }
  } catch {
    // Debug measurement failures must not affect transform output.
  }
  if (error) shakeToken.accumulator.shakes.errors += 1;
  else shakeToken.accumulator.shakes.successes += 1;
  shakeToken.accumulator.shakes.generatedBytes += generatedBytes;
  shakeToken.accumulator.shakes.calls.push({
    error,
    generatedBytes,
    inputBytes: shakeToken.inputBytes,
    inputRevision: shakeToken.inputRevision,
    mode: shakeToken.mode,
    only: shakeToken.only,
    outputRevision,
  });
};

export const beginPipelineCleanup = (
  filename: string
): PipelineCleanupToken => {
  const accumulator = getAccumulator();
  if (!accumulator) {
    return undefined;
  }

  accumulator.cleanup.calls += 1;
  return { accumulator, filename, finished: false };
};

export const recordPipelineCleanupIteration = (
  token: PipelineCleanupToken,
  code: string,
  mergedRanges: readonly { end: number; start: number }[],
  committed: boolean,
  scopedDeclarations: number,
  topLevelDeclarations: number,
  generatedHelpers: number,
  imports: number,
  expressions: number,
  emptyBlocks: number
): void => {
  if (!token || token.finished || token.accumulator.closed) {
    return;
  }

  const { cleanup } = token.accumulator;
  let bytes = 0;
  try {
    const ascii = measureBytes(token.accumulator, code) === code.length;
    mergedRanges.forEach(({ end, start }) => {
      bytes += ascii ? end - start : Buffer.byteLength(code.slice(start, end));
    });
  } catch {
    return;
  }
  cleanup.attemptedIterations += 1;
  cleanup.attemptedRanges += mergedRanges.length;
  cleanup.attemptedBytes += bytes;
  cleanup.candidateRemovals.scopedDeclarations += scopedDeclarations;
  cleanup.candidateRemovals.topLevelDeclarations += topLevelDeclarations;
  cleanup.candidateRemovals.generatedHelpers += generatedHelpers;
  cleanup.candidateRemovals.imports += imports;
  cleanup.candidateRemovals.expressions += expressions;
  cleanup.candidateRemovals.emptyBlocks += emptyBlocks;
  if (committed) {
    cleanup.committedIterations += 1;
    cleanup.committedRanges += mergedRanges.length;
    cleanup.committedBytes += bytes;
  } else if (mergedRanges.length > 0) {
    cleanup.rollbackBytes += bytes;
  }
};

export const finishPipelineCleanup = (
  token: PipelineCleanupToken,
  outcome: PipelineCleanupOutcome
): void => {
  if (!token || token.finished || token.accumulator.closed) {
    return;
  }
  const cleanupToken = token;
  cleanupToken.finished = true;
  const { cleanup } = cleanupToken.accumulator;
  if (outcome === 'converged') cleanup.converged += 1;
  if (outcome === 'rollback') cleanup.rollbacks += 1;
  if (outcome === 'cap') cleanup.capHits += 1;
  if (outcome === 'stalled') cleanup.stalled += 1;
  if (outcome === 'error') cleanup.errors += 1;
};
