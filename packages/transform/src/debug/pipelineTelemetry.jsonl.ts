/* eslint-disable no-bitwise */
import path from 'path';

import { getPipelineParserAttempts } from './pipelineTelemetry.parse';
import { PIPELINE_TELEMETRY_SCHEMA } from './pipelineTelemetry.schema';
import type {
  CacheName,
  CacheOperation,
  PipelineAccumulator,
} from './pipelineTelemetry.types';

type JSONRecord = Record<string, unknown>;

const enumIds = <T extends string>(values: readonly T[]): Record<T, number> =>
  Object.fromEntries(values.map((value, id) => [value, id])) as Record<
    T,
    number
  >;

const CACHE_IDS = enumIds<CacheName>(
  PIPELINE_TELEMETRY_SCHEMA.tupleEncoding.enumIds.cache
);

const CACHE_OPERATION_IDS = enumIds<CacheOperation>(
  PIPELINE_TELEMETRY_SCHEMA.tupleEncoding.enumIds.cacheOperation
);

const CACHE_OPERATIONS = [
  ['barrelManifests', 'get'],
  ['barrelManifests', 'has'],
  ['entrypoints', 'get'],
  ['entrypoints', 'has'],
  ['exports', 'get'],
  ['exports', 'has'],
] as const satisfies ReadonlyArray<readonly [CacheName, CacheOperation]>;

const PARSER_KEY_IDS: Readonly<Record<string, number>> = enumIds(
  PIPELINE_TELEMETRY_SCHEMA.tupleEncoding.enumIds.parserKey
);

const relativeFilename = (filename: string, workingDir: string): string => {
  const isWindowsPath = (value: string): boolean =>
    /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(value);
  const pathApi = isWindowsPath(filename) ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(filename)) return filename;
  if (!pathApi.isAbsolute(workingDir)) return pathApi.basename(filename);

  const relative = pathApi.relative(workingDir, filename);
  return pathApi.isAbsolute(relative) ? pathApi.basename(filename) : relative;
};

const nestedFilename = (
  filename: string,
  rootFilename: string,
  workingDir: string
): string | undefined =>
  filename === rootFilename
    ? undefined
    : relativeFilename(filename, workingDir);

const buildCache = (accumulator: PipelineAccumulator): unknown[] => {
  const { cache } = accumulator;
  let hits = 0;
  let misses = 0;
  let requests = 0;
  const byOperation: unknown[][] = [];
  CACHE_OPERATIONS.forEach(([cacheName, operation], index) => {
    const counter = cache.byOperation[index];
    if (!counter) return;
    hits += counter.hits;
    misses += counter.misses;
    requests += counter.requests;
    byOperation.push([
      CACHE_IDS[cacheName],
      CACHE_OPERATION_IDS[operation],
      counter.hits,
      counter.misses,
      counter.requests,
    ]);
  });

  let clearEntries = 0;
  let clearRequests = 0;
  const clearReasons = Array.from(cache.clearReasons.values(), (counter) => {
    clearEntries += counter.entries;
    clearRequests += counter.requests;
    return [
      CACHE_IDS[counter.cache],
      counter.reason,
      counter.entries,
      counter.requests,
    ];
  });

  const { changes, unchanged } = cache.salt;
  let clears = 0;
  let disables = 0;
  let migrations = 0;
  changes.forEach(({ outcome }) => {
    if (outcome === 'clear') clears += 1;
    if (outcome === 'disable') disables += 1;
    if (outcome === 'migrate') migrations += 1;
  });

  return [
    requests,
    hits,
    misses,
    clearRequests,
    clearEntries,
    [
      unchanged + changes.length,
      clears,
      disables,
      migrations,
      unchanged,
      changes,
    ],
    byOperation,
    clearReasons,
  ];
};

const hasCacheActivity = (accumulator: PipelineAccumulator): boolean =>
  accumulator.cache.byOperation.some(Boolean) ||
  accumulator.cache.clearReasons.size > 0 ||
  accumulator.cache.salt.unchanged > 0 ||
  accumulator.cache.salt.changes.length > 0;

const buildCleanup = (accumulator: PipelineAccumulator): unknown[] => {
  const { cleanup } = accumulator;
  const { candidateRemovals } = cleanup;
  return [
    cleanup.calls,
    cleanup.attemptedIterations,
    cleanup.attemptedRanges,
    cleanup.attemptedBytes,
    cleanup.committedIterations,
    cleanup.committedRanges,
    cleanup.committedBytes,
    cleanup.rollbackBytes,
    [
      candidateRemovals.emptyBlocks,
      candidateRemovals.expressions,
      candidateRemovals.generatedHelpers,
      candidateRemovals.imports,
      candidateRemovals.scopedDeclarations,
      candidateRemovals.topLevelDeclarations,
    ],
    cleanup.converged,
    cleanup.rollbacks,
    cleanup.capHits,
    cleanup.stalled,
    cleanup.errors,
  ];
};

const buildEntrypoints = (accumulator: PipelineAccumulator): unknown[] => {
  const { entrypoints } = accumulator;
  let disposableRoots = 0;
  const disposableRootsByPhase = Array.from(
    entrypoints.disposableRootsByPhase,
    ([phase, count]) => {
      disposableRoots += count;
      return [phase, count];
    }
  );

  return [
    entrypoints.roots + entrypoints.children,
    entrypoints.roots,
    entrypoints.children,
    entrypoints.created,
    entrypoints.cached,
    entrypoints.loops,
    entrypoints.initialRoots,
    entrypoints.roots - entrypoints.initialRoots,
    disposableRoots,
    Array.from(entrypoints.byOnly.values(), (counter) => [
      counter.only,
      counter.count,
    ]),
    disposableRootsByPhase,
  ];
};

const buildLateNoMetadata = (
  accumulator: PipelineAccumulator,
  rootFilename: string,
  workingDir: string
): unknown[] => {
  let dangerousCodeCalls = 0;
  let dangerousCodeMs = 0;
  if (accumulator.lateNoMetadata.length === 1) {
    const dangerous = accumulator.dangerousByFile.get(
      accumulator.lateNoMetadata[0].filename
    );
    dangerousCodeCalls = dangerous?.calls ?? 0;
    dangerousCodeMs = dangerous?.durationMs ?? 0;
  } else {
    const uniqueFiles = new Set(
      accumulator.lateNoMetadata.map(({ filename }) => filename)
    );
    uniqueFiles.forEach((filename) => {
      const dangerous = accumulator.dangerousByFile.get(filename);
      dangerousCodeCalls += dangerous?.calls ?? 0;
      dangerousCodeMs += dangerous?.durationMs ?? 0;
    });
  }

  return [
    accumulator.lateNoMetadata.length,
    dangerousCodeCalls,
    dangerousCodeMs,
    accumulator.lateNoMetadata.map((event) => {
      const record: unknown[] = [event.phase, event.only];
      const filename = nestedFilename(event.filename, rootFilename, workingDir);
      if (filename !== undefined) record.push(filename);
      return record;
    }),
  ];
};

const buildParse = (accumulator: PipelineAccumulator): unknown[] => {
  const { parse } = accumulator;
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
  const revisions = parse.revisions.map((counter) => {
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

    let mask = 0;
    const values: unknown[] = [];
    if (counter.kind !== 'cached') {
      mask |= 1;
      values.push(counter.kind);
    }
    if (counter.cacheHits !== 0) {
      mask |= 2;
      values.push(counter.cacheHits);
    }
    if (counter.cacheMisses !== 0) {
      mask |= 4;
      values.push(counter.cacheMisses);
    }
    if (counter.errors !== 0) {
      mask |= 8;
      values.push(counter.errors);
    }
    if (counter.jsxFallbackRequests !== 0) {
      mask |= 16;
      values.push(counter.jsxFallbackRequests);
    }
    if (counter.jsxFallbackAttempts !== 0) {
      mask |= 32;
      values.push(counter.jsxFallbackAttempts);
    }
    if (counter.rawTransferFallbackAttempts !== 0) {
      mask |= 64;
      values.push(counter.rawTransferFallbackAttempts);
    }
    return [
      counter.revision,
      typeof counter.parserKey === 'number'
        ? counter.parserKey
        : PARSER_KEY_IDS[counter.parserKey] ?? counter.parserKey,
      counter.bytes,
      counter.requests,
      mask,
      ...values,
    ];
  });
  const totals = [
    allRequests,
    cacheHits + cacheMisses,
    uncachedRequests,
    cacheHits,
    cacheMisses,
    parserAttempts,
    requestedBytes,
    parsedBytes,
    errors,
    jsxFallbackRequests,
    jsxFallbackAttempts,
    rawTransferFallbackAttempts,
  ];
  return [totals, revisions];
};

const buildProcessors = (accumulator: PipelineAccumulator): unknown[] =>
  Array.from(accumulator.processors.byPhase, ([phase, counter]) => {
    let mask = 0;
    const values: unknown[] = [];
    if (counter.definedProcessors !== 0) {
      mask |= 1;
      values.push(counter.definedProcessors);
    }
    if (counter.importCandidates !== 0) {
      mask |= 2;
      values.push(counter.importCandidates);
    }
    if (counter.lookupAttempts !== 0) {
      mask |= 4;
      values.push(counter.lookupAttempts);
    }
    if (counter.lookupHits !== 0) {
      mask |= 8;
      values.push(counter.lookupHits);
    }
    if (counter.passes !== 1) {
      mask |= 16;
      values.push(counter.passes);
    }
    if (counter.reusedPlans !== 0) {
      mask |= 32;
      values.push(counter.reusedPlans);
    }
    if (counter.usages !== 0) {
      mask |= 64;
      values.push(counter.usages);
    }
    return [phase, mask, ...values];
  });

const buildShakes = (accumulator: PipelineAccumulator): unknown[] => {
  const { shakes } = accumulator;
  return [
    shakes.attempts,
    shakes.successes,
    shakes.errors,
    shakes.generatedBytes,
    shakes.calls.map((call) => {
      let mask = 0;
      const values: unknown[] = [];
      if (call.error) mask |= 1;
      if (call.generatedBytes !== 0) {
        mask |= 2;
        values.push(call.generatedBytes);
      }
      return [
        call.inputRevision,
        call.mode,
        call.only,
        call.outputRevision,
        call.inputBytes,
        mask,
        ...values,
      ];
    }),
  ];
};

/**
 * Serializes a root-scoped telemetry record as named sections containing
 * compact tuples. The file reporter writes the returned newline as-is.
 */
export const serializePipelineTelemetryJSONl = (
  accumulator: PipelineAccumulator,
  workingDir: string
): string => {
  const { root } = accumulator;
  const result: JSONRecord = {
    root: {
      filename: relativeFilename(root.filename, workingDir),
      status: root.status,
    },
    schemaVersion: PIPELINE_TELEMETRY_SCHEMA.schemaVersion,
    type: 'pipeline-telemetry',
  };
  const { cleanup, entrypoints, parse, processors, shakes } = accumulator;
  if (hasCacheActivity(accumulator)) {
    result.cache = buildCache(accumulator);
  }
  if (cleanup.calls > 0) result.cleanup = buildCleanup(accumulator);
  if (
    entrypoints.roots > 0 ||
    entrypoints.children > 0 ||
    entrypoints.disposableRootsByPhase.size > 0
  ) {
    result.entrypoints = buildEntrypoints(accumulator);
  }
  if (accumulator.lateNoMetadata.length > 0) {
    result.lateNoMetadata = buildLateNoMetadata(
      accumulator,
      root.filename,
      workingDir
    );
  }
  if (parse.revisions.length > 0) {
    result.parse = buildParse(accumulator);
  }
  if (processors.byPhase.size > 0) {
    result.processors = buildProcessors(accumulator);
  }
  if (shakes.attempts > 0) {
    result.shakes = buildShakes(accumulator);
  }
  return `${JSON.stringify(result)}\n`;
};
