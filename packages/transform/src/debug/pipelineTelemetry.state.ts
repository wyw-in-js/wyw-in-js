import type {
  CleanupRemovalKinds,
  PipelineAccumulator,
} from './pipelineTelemetry.types';

const EMPTY_REMOVAL_KINDS = (): CleanupRemovalKinds => ({
  emptyBlocks: 0,
  expressions: 0,
  generatedHelpers: 0,
  imports: 0,
  scopedDeclarations: 0,
  topLevelDeclarations: 0,
});

export const normalizeOnly = (
  accumulator: PipelineAccumulator,
  only: readonly string[]
): { key: string; only: string[] } => {
  const cached = accumulator.onlyNormalizations.get(only);
  if (cached) return cached;

  let normalized: string[];
  if (only.length <= 1) {
    normalized = only.length === 0 ? [] : [only[0]];
  } else if (only.includes('*')) {
    normalized = ['*'];
  } else {
    normalized = [...new Set(only)].sort();
  }

  const result = { key: JSON.stringify(normalized), only: normalized };
  accumulator.onlyNormalizations.set(only, result);
  return result;
};

export const createAccumulator = (filename: string): PipelineAccumulator => ({
  cache: {
    byOperation: new Array(6),
    clearReasons: new Map(),
    salt: {
      changes: [],
      unchanged: 0,
    },
  },
  cleanup: {
    calls: 0,
    candidateRemovals: EMPTY_REMOVAL_KINDS(),
    capHits: 0,
    committedBytes: 0,
    committedIterations: 0,
    committedRanges: 0,
    converged: 0,
    errors: 0,
    rollbackBytes: 0,
    rollbacks: 0,
    stalled: 0,
    attemptedBytes: 0,
    attemptedIterations: 0,
    attemptedRanges: 0,
  },
  closed: false,
  dangerousByFile: new Map(),
  entrypoints: {
    byOnly: new Map(),
    cached: 0,
    children: 0,
    created: 0,
    disposableRootsByPhase: new Map(),
    initialRoots: 0,
    loops: 0,
    roots: 0,
  },
  lateNoMetadata: [],
  lastCode: undefined,
  lastMeasurement: undefined,
  localCodeMeasurements: new Map(),
  onlyNormalizations: new Map(),
  parse: {
    cachedRevisions: new WeakMap(),
    revisionBuckets: new Map(),
    revisions: [],
  },
  processors: {
    byPhase: new Map(),
  },
  root: {
    filename,
    status: 'success',
  },
  shakes: {
    attempts: 0,
    calls: [],
    errors: 0,
    generatedBytes: 0,
    successes: 0,
  },
});

export const releaseAccumulator = (accumulator: PipelineAccumulator): void => {
  accumulator.closed = true;
  accumulator.cache.byOperation.fill(undefined);
  accumulator.cache.clearReasons.clear();
  accumulator.cache.salt.changes.length = 0;
  accumulator.dangerousByFile.clear();
  accumulator.entrypoints.byOnly.clear();
  accumulator.entrypoints.disposableRootsByPhase.clear();
  accumulator.lateNoMetadata.length = 0;
  accumulator.lastCode = undefined;
  accumulator.lastMeasurement = undefined;
  accumulator.localCodeMeasurements.clear();
  accumulator.onlyNormalizations.clear();
  accumulator.parse.revisionBuckets.clear();
  accumulator.parse.revisions.length = 0;
  accumulator.processors.byPhase.clear();
  accumulator.shakes.calls.length = 0;
};
