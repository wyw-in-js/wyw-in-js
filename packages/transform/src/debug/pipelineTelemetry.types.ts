import type {
  CacheName,
  PipelineCacheSaltOutcome,
  PipelineNoMetadataPhase,
  ParseKind,
  RootStatus,
} from '../telemetry/observer';

export type {
  CacheName,
  CacheOperation,
  EntrypointStatus,
  ParseKind,
  PipelineCacheSaltOutcome,
  PipelineCleanupOutcome,
  PipelineNoMetadataPhase,
  RootStatus,
} from '../telemetry/observer';

export type Counter = {
  hits: number;
  misses: number;
  requests: number;
};

export type ParseRevisionCounter = {
  bytes: number;
  cacheHits: number;
  cacheMisses: number;
  errors: number;
  jsxFallbackAttempts: number;
  jsxFallbackRequests: number;
  kind: ParseKind;
  parserKey: number | string;
  rawTransferFallbackAttempts: number;
  requests: number;
  revision: string;
};

export type ProcessorCounter = {
  definedProcessors: number;
  importCandidates: number;
  lookupAttempts: number;
  lookupHits: number;
  passes: number;
  reusedPlans: number;
  usages: number;
};

export type CodeMeasurement = {
  bytes: number;
  revision?: string;
};

export type CodeMeasurementEntry = {
  code: string;
  measurement: CodeMeasurement;
};

export type CodeMeasurementBucket =
  | CodeMeasurementEntry
  | CodeMeasurementEntry[];

export type CleanupRemovalKinds = {
  emptyBlocks: number;
  expressions: number;
  generatedHelpers: number;
  imports: number;
  scopedDeclarations: number;
  topLevelDeclarations: number;
};

export type PipelineShakeRecord = {
  error: boolean;
  generatedBytes: number;
  inputBytes: number;
  inputRevision: string;
  mode: string;
  only: string[];
  outputRevision: string | null;
};

export type PipelineAccumulator = {
  cache: {
    byOperation: Array<Counter | undefined>;
    clearReasons: Map<
      string,
      { cache: CacheName; entries: number; reason: string; requests: number }
    >;
    salt: {
      changes: Array<{
        current: string | null;
        outcome: PipelineCacheSaltOutcome;
        previous: string | null;
      }>;
      unchanged: number;
    };
  };
  cleanup: {
    calls: number;
    candidateRemovals: CleanupRemovalKinds;
    capHits: number;
    committedBytes: number;
    committedIterations: number;
    committedRanges: number;
    converged: number;
    errors: number;
    rollbackBytes: number;
    rollbacks: number;
    stalled: number;
    attemptedBytes: number;
    attemptedIterations: number;
    attemptedRanges: number;
  };
  closed: boolean;
  dangerousByFile: Map<string, { calls: number; durationMs: number }>;
  entrypoints: {
    byOnly: Map<string, { count: number; only: string[] }>;
    cached: number;
    children: number;
    created: number;
    disposableRootsByPhase: Map<string, number>;
    initialRoots: number;
    loops: number;
    roots: number;
  };
  lateNoMetadata: Array<{
    filename: string;
    only: string[];
    phase: PipelineNoMetadataPhase;
  }>;
  lastCode: string | undefined;
  lastMeasurement: CodeMeasurement | undefined;
  localCodeMeasurements: Map<number, CodeMeasurementBucket>;
  onlyNormalizations: Map<readonly string[], { key: string; only: string[] }>;
  parse: {
    cachedRevisions: WeakMap<object, ParseRevisionCounter>;
    revisionBuckets: Map<
      CodeMeasurement,
      ParseRevisionCounter | ParseRevisionCounter[]
    >;
    revisions: ParseRevisionCounter[];
  };
  processors: {
    byPhase: Map<string, ProcessorCounter>;
  };
  root: {
    filename: string;
    status: RootStatus;
  };
  shakes: {
    attempts: number;
    calls: PipelineShakeRecord[];
    errors: number;
    generatedBytes: number;
    successes: number;
  };
};

export type PipelineDangerousCodeToken =
  | {
      accumulator: PipelineAccumulator;
      filename: string;
      finished: boolean;
      startedAt: number;
    }
  | undefined;

export type PipelineShakeToken =
  | {
      accumulator: PipelineAccumulator;
      finished: boolean;
      inputBytes: number;
      inputRevision: string;
      mode: string;
      only: string[];
    }
  | undefined;

export type PipelineCleanupToken =
  | {
      accumulator: PipelineAccumulator;
      filename: string;
      finished: boolean;
    }
  | undefined;
