import { getPipelineParserAttempts } from './pipelineTelemetry.parse';
import { PIPELINE_TELEMETRY_SCHEMA } from './pipelineTelemetry.schema';
import type {
  CacheName,
  CacheOperation,
  ParseRevisionCounter,
  PipelineAccumulator,
  ProcessorCounter,
} from './pipelineTelemetry.types';

const CACHE_OPERATIONS = [
  ['barrelManifests', 'get'],
  ['barrelManifests', 'has'],
  ['entrypoints', 'get'],
  ['entrypoints', 'has'],
  ['exports', 'get'],
  ['exports', 'has'],
] as const satisfies ReadonlyArray<readonly [CacheName, CacheOperation]>;

const sortedEntries = <T>(map: Map<string, T>): Array<[string, T]> => {
  const entries = [...map.entries()];
  return entries.length > 1
    ? entries.sort(([left], [right]) => left.localeCompare(right))
    : entries;
};

const getParserKey = (counter: ParseRevisionCounter): string =>
  typeof counter.parserKey === 'number'
    ? PIPELINE_TELEMETRY_SCHEMA.tupleEncoding.enumIds.parserKey[
        counter.parserKey
      ]
    : counter.parserKey;

const buildCache = (
  accumulator: PipelineAccumulator,
  preserveInsertionOrder = false
) => {
  let hits = 0;
  let misses = 0;
  let requests = 0;
  const byOperation: Array<{
    cache: CacheName;
    hits: number;
    misses: number;
    operation: CacheOperation;
    requests: number;
  }> = [];
  CACHE_OPERATIONS.forEach(([cache, operation], index) => {
    const counter = accumulator.cache.byOperation[index];
    if (!counter) return;
    hits += counter.hits;
    misses += counter.misses;
    requests += counter.requests;
    byOperation.push({ cache, operation, ...counter });
  });

  const rawClearReasons = Array.from(accumulator.cache.clearReasons.values());
  let clearEntries = 0;
  let clearRequests = 0;
  rawClearReasons.forEach((counter) => {
    clearEntries += counter.entries;
    clearRequests += counter.requests;
  });
  const clearReasons = preserveInsertionOrder
    ? rawClearReasons
    : sortedEntries(accumulator.cache.clearReasons).map(
        ([, counter]) => counter
      );

  const { changes, unchanged } = accumulator.cache.salt;
  let clears = 0;
  let disables = 0;
  let migrations = 0;
  changes.forEach(({ outcome }) => {
    if (outcome === 'clear') clears += 1;
    if (outcome === 'disable') disables += 1;
    if (outcome === 'migrate') migrations += 1;
  });

  return {
    byOperation,
    clearEntries,
    clearReasons,
    clearRequests,
    hits,
    misses,
    requests,
    salt: {
      calls: unchanged + changes.length,
      changes: [...changes],
      clears,
      disables,
      migrations,
      unchanged,
    },
  };
};

const hasCacheActivity = (accumulator: PipelineAccumulator): boolean =>
  accumulator.cache.byOperation.some(Boolean) ||
  accumulator.cache.clearReasons.size > 0 ||
  accumulator.cache.salt.unchanged > 0 ||
  accumulator.cache.salt.changes.length > 0;

const buildCleanup = (accumulator: PipelineAccumulator) => ({
  ...accumulator.cleanup,
  candidateRemovals: { ...accumulator.cleanup.candidateRemovals },
});

const buildEntrypoints = (
  accumulator: PipelineAccumulator,
  preserveInsertionOrder = false
) => {
  const { entrypoints } = accumulator;
  let disposableRoots = 0;
  entrypoints.disposableRootsByPhase.forEach((count) => {
    disposableRoots += count;
  });

  return {
    byOnly: preserveInsertionOrder
      ? Array.from(entrypoints.byOnly.values())
      : sortedEntries(entrypoints.byOnly).map(([, counter]) => counter),
    cached: entrypoints.cached,
    children: entrypoints.children,
    created: entrypoints.created,
    disposableRoots,
    disposableRootsByPhase: preserveInsertionOrder
      ? Array.from(entrypoints.disposableRootsByPhase, ([phase, count]) => ({
          count,
          phase,
        }))
      : sortedEntries(entrypoints.disposableRootsByPhase).map(
          ([phase, count]) => ({ count, phase })
        ),
    initialRoots: entrypoints.initialRoots,
    loops: entrypoints.loops,
    onDemandRoots: entrypoints.roots - entrypoints.initialRoots,
    requests: entrypoints.roots + entrypoints.children,
    roots: entrypoints.roots,
  };
};

const buildLateNoMetadata = (accumulator: PipelineAccumulator) => {
  const events = accumulator.lateNoMetadata
    .map((event) => ({ ...event }))
    .sort((left, right) =>
      `${left.filename}\0${left.phase}\0${left.only.join('\0')}`.localeCompare(
        `${right.filename}\0${right.phase}\0${right.only.join('\0')}`
      )
    );
  const uniqueFiles = new Set(events.map(({ filename }) => filename));
  let dangerousCodeCalls = 0;
  let dangerousCodeMs = 0;
  uniqueFiles.forEach((filename) => {
    const dangerous = accumulator.dangerousByFile.get(filename);
    dangerousCodeCalls += dangerous?.calls ?? 0;
    dangerousCodeMs += dangerous?.durationMs ?? 0;
  });
  return {
    count: events.length,
    dangerousCodeCalls,
    dangerousCodeMs,
    events,
  };
};

const buildCompactLateNoMetadata = (accumulator: PipelineAccumulator) => {
  const events = [...accumulator.lateNoMetadata];
  if (events.length === 1) {
    const dangerous = accumulator.dangerousByFile.get(events[0].filename);
    return {
      count: 1,
      dangerousCodeCalls: dangerous?.calls ?? 0,
      dangerousCodeMs: dangerous?.durationMs ?? 0,
      events,
    };
  }

  const uniqueFiles = new Set(events.map(({ filename }) => filename));
  let dangerousCodeCalls = 0;
  let dangerousCodeMs = 0;
  uniqueFiles.forEach((filename) => {
    const dangerous = accumulator.dangerousByFile.get(filename);
    dangerousCodeCalls += dangerous?.calls ?? 0;
    dangerousCodeMs += dangerous?.durationMs ?? 0;
  });
  return {
    count: events.length,
    dangerousCodeCalls,
    dangerousCodeMs,
    events,
  };
};

const buildParseTotals = (accumulator: PipelineAccumulator) => {
  let allRequests = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let errors = 0;
  let jsxFallbackAttempts = 0;
  let jsxFallbackRequests = 0;
  let parsedBytes = 0;
  let parserAttempts = 0;
  let requestedBytes = 0;
  let rawTransferFallbackAttempts = 0;
  let uncachedRequests = 0;
  accumulator.parse.revisions.forEach((counter) => {
    const revisionParserAttempts = getPipelineParserAttempts(counter);
    allRequests += counter.requests;
    cacheHits += counter.cacheHits;
    cacheMisses += counter.cacheMisses;
    errors += counter.errors;
    jsxFallbackAttempts += counter.jsxFallbackAttempts;
    jsxFallbackRequests += counter.jsxFallbackRequests;
    parsedBytes += counter.bytes * revisionParserAttempts;
    parserAttempts += revisionParserAttempts;
    requestedBytes += counter.bytes * counter.requests;
    rawTransferFallbackAttempts += counter.rawTransferFallbackAttempts;
    if (counter.kind === 'uncached') uncachedRequests += counter.requests;
  });
  return {
    allRequests,
    cacheHits,
    cacheMisses,
    cachedRequests: cacheHits + cacheMisses,
    errors,
    jsxFallbackAttempts,
    jsxFallbackRequests,
    parsedBytes,
    parserAttempts,
    requestedBytes,
    rawTransferFallbackAttempts,
    uncachedRequests,
  };
};

const buildParse = (accumulator: PipelineAccumulator) => ({
  ...buildParseTotals(accumulator),
  revisions: [...accumulator.parse.revisions]
    .sort((left, right) =>
      `${left.revision}\0${getParserKey(left)}\0${left.kind}`.localeCompare(
        `${right.revision}\0${getParserKey(right)}\0${right.kind}`
      )
    )
    .map((counter) => {
      const parserAttempts = getPipelineParserAttempts(counter);
      return {
        cacheHits: counter.cacheHits,
        cacheMisses: counter.cacheMisses,
        errors: counter.errors,
        jsxFallbackAttempts: counter.jsxFallbackAttempts,
        jsxFallbackRequests: counter.jsxFallbackRequests,
        kind: counter.kind,
        parsedBytes: counter.bytes * parserAttempts,
        parserAttempts,
        parserKey: getParserKey(counter),
        rawTransferFallbackAttempts: counter.rawTransferFallbackAttempts,
        requestedBytes: counter.bytes * counter.requests,
        requests: counter.requests,
        revision: counter.revision,
      };
    }),
});

const createProcessorCounter = (): ProcessorCounter => ({
  definedProcessors: 0,
  importCandidates: 0,
  lookupAttempts: 0,
  lookupHits: 0,
  passes: 0,
  reusedPlans: 0,
  usages: 0,
});

const addProcessorCounters = (
  target: ProcessorCounter,
  source: ProcessorCounter
): void => {
  const counter = target;
  counter.definedProcessors += source.definedProcessors;
  counter.importCandidates += source.importCandidates;
  counter.lookupAttempts += source.lookupAttempts;
  counter.lookupHits += source.lookupHits;
  counter.passes += source.passes;
  counter.reusedPlans += source.reusedPlans;
  counter.usages += source.usages;
};

const buildProcessors = (accumulator: PipelineAccumulator) => {
  const byPhase = sortedEntries(accumulator.processors.byPhase);
  const totals = createProcessorCounter();
  byPhase.forEach(([, counter]) => {
    addProcessorCounters(totals, counter);
  });
  return {
    byPhase: byPhase.map(([phase, counter]) => ({
      phase,
      ...counter,
    })),
    totals,
  };
};

const buildShakes = (accumulator: PipelineAccumulator) => ({
  ...accumulator.shakes,
  calls: [...accumulator.shakes.calls],
});

export const buildPipelineTelemetrySummary = (
  accumulator: PipelineAccumulator
) => ({
  cache: buildCache(accumulator),
  cleanup: buildCleanup(accumulator),
  entrypoints: buildEntrypoints(accumulator),
  lateNoMetadata: buildLateNoMetadata(accumulator),
  parse: buildParse(accumulator),
  processors: buildProcessors(accumulator),
  root: { ...accumulator.root },
  schemaVersion: PIPELINE_TELEMETRY_SCHEMA.schemaVersion,
  shakes: buildShakes(accumulator),
  type: 'pipeline-telemetry' as const,
});

export type PipelineTelemetrySummary = ReturnType<
  typeof buildPipelineTelemetrySummary
>;

export type PipelineTelemetryCompactSummary = Pick<
  PipelineTelemetrySummary,
  'root' | 'schemaVersion' | 'type'
> &
  Partial<
    Omit<
      PipelineTelemetrySummary,
      'parse' | 'processors' | 'root' | 'schemaVersion' | 'type'
    >
  > & {
    parse?: Omit<PipelineTelemetrySummary['parse'], 'revisions'> & {
      revisions: Array<
        Omit<ParseRevisionCounter, 'parserKey'> & {
          parserAttempts: number;
          parserKey: string;
        }
      >;
    };
    processors?: {
      byPhase: PipelineTelemetrySummary['processors']['byPhase'];
    };
  };

const buildCompactParse = (
  accumulator: PipelineAccumulator
): NonNullable<PipelineTelemetryCompactSummary['parse']> => ({
  ...buildParseTotals(accumulator),
  revisions: accumulator.parse.revisions.map((counter) => {
    const parserAttempts = getPipelineParserAttempts(counter);
    return {
      ...counter,
      parserAttempts,
      parserKey: getParserKey(counter),
    };
  }),
});

const buildCompactProcessors = (
  accumulator: PipelineAccumulator
): NonNullable<PipelineTelemetryCompactSummary['processors']> => ({
  byPhase: Array.from(accumulator.processors.byPhase, ([phase, counter]) => ({
    phase,
    ...counter,
  })),
});

export const buildCompactPipelineTelemetrySummary = (
  accumulator: PipelineAccumulator
): PipelineTelemetryCompactSummary => {
  const summary: PipelineTelemetryCompactSummary = {
    root: { ...accumulator.root },
    schemaVersion: PIPELINE_TELEMETRY_SCHEMA.schemaVersion,
    type: 'pipeline-telemetry',
  };
  const { cleanup, entrypoints, parse, processors, shakes } = accumulator;
  if (hasCacheActivity(accumulator)) {
    summary.cache = buildCache(accumulator, true);
  }
  if (cleanup.calls > 0) summary.cleanup = buildCleanup(accumulator);
  if (
    entrypoints.roots > 0 ||
    entrypoints.children > 0 ||
    entrypoints.disposableRootsByPhase.size > 0
  ) {
    summary.entrypoints = buildEntrypoints(accumulator, true);
  }
  if (accumulator.lateNoMetadata.length > 0) {
    summary.lateNoMetadata = buildCompactLateNoMetadata(accumulator);
  }
  if (parse.revisions.length > 0) {
    summary.parse = buildCompactParse(accumulator);
  }
  if (processors.byPhase.size > 0) {
    summary.processors = buildCompactProcessors(accumulator);
  }
  if (shakes.attempts > 0) summary.shakes = buildShakes(accumulator);
  return summary;
};
