import type {
  EvalBrokerMirrorSnapshot,
  EvalLoadCacheOutcome,
  EvalLoadResendReason,
  EvalObserver,
  EvalPreparationObserver,
  EvalRootStatus,
} from '../telemetry/observer';

export type {
  EvalBrokerMirrorSnapshot,
  EvalLoadCacheOutcome,
  EvalLoadResendReason,
  EvalLoadTransmission,
  EvalPreparationResult,
  EvalPreparationStage,
  EvalPreparedCacheEviction,
  EvalPressureProxy,
  EvalRootStatus,
  EvalRunnerSignal,
} from '../telemetry/observer';

export const EVAL_TELEMETRY_SCHEMA_VERSION = 2 as const;

export const EVAL_PREPARATION_ARTIFACT_LIMIT = 128;

export type EvalOnlyShape = 'empty' | 'named' | 'wildcard';

export type EvalPreparationArtifact = {
  calls: number;
  durationMs: number;
  errors: number;
  id: string;
  importMapBytes: number;
  onlyShape: EvalOnlyShape;
  outputRevision: string | null;
  prepareCalls: number;
  prepareMs: number;
  preparedCodeBytes: number;
  shakeCalls: number;
  shakeMs: number;
  stripCalls: number;
  stripMs: number;
};

export type EvalTelemetryRootRecord = {
  brokerId: number;
  evictions: {
    brokerObservedPoisonIds: number;
    brokerObservedPoisonSignals: number;
    brokerObservedResetSignals: number;
    hostPreparedCache: {
      capacity: number;
      invalidation: number;
      knownCodeBytes: number;
      replacement: number;
      total: number;
      unknownByteEntries: number;
    };
    primaryPressureProxy: {
      shipmentHashChanges: number;
    };
    variantPressureProxy: {
      shipmentHashChanges: number;
    };
  };
  loads: {
    cache: {
      hits: number;
      inflightHits: number;
      inflightWaitMisses: number;
      inflightWaits: number;
      invalidationMisses: number;
      misses: number;
      outcomes: Record<EvalLoadCacheOutcome, number>;
      promotions: number;
      serializedExports: number;
    };
    preparation: {
      artifacts: EvalPreparationArtifact[];
      calls: number;
      droppedArtifacts: number;
      durationMs: number;
      errors: number;
      importMapBytes: number;
      prepareCalls: number;
      prepareMs: number;
      preparedCodeBytes: number;
      shakeCalls: number;
      shakeMs: number;
      stripCalls: number;
      stripMs: number;
    };
    requests: number;
    transmission: {
      chunkedResults: number;
      chunks: number;
      codeBytes: number;
      emptyCodePayloads: number;
      errors: number;
      incompleteResults: number;
      initial: number;
      logicalResults: number;
      moduleResetSignals: number;
      omissions: number;
      resendReasons: Record<EvalLoadResendReason, number>;
      resends: number;
      serializedExports: number;
      wireBytes: number;
      wireMessages: number;
    };
  };
  mirror: EvalBrokerMirrorSnapshot;
  root: {
    batchIndex: number;
    batchSize: number;
    durationMs: number;
    entrypoint: string;
    queueWaitMs: number;
    status: EvalRootStatus;
  };
  schemaVersion: typeof EVAL_TELEMETRY_SCHEMA_VERSION;
  type: 'eval-root';
};

export type EvalBrokerLifecycleEvent =
  | 'broker-created'
  | 'broker-dispose-observed'
  | 'broker-reused'
  | 'runner-activated'
  | 'runner-exit-observed'
  | 'runner-spawn-attempt'
  | 'runner-stop-requested';

export type EvalBrokerLifecycleMetadata = {
  event: EvalBrokerLifecycleEvent;
  reason: string;
  mirror?: EvalBrokerMirrorSnapshot;
};

export type EvalTelemetryLifecycleRecord = EvalBrokerLifecycleMetadata & {
  brokerId: number;
  observedAtMs: number;
  restartInferred: boolean;
  schemaVersion: typeof EVAL_TELEMETRY_SCHEMA_VERSION;
  type: 'eval-lifecycle';
};

export type EvalTelemetryRecord =
  | EvalTelemetryLifecycleRecord
  | EvalTelemetryRootRecord;

export type EvalPreparationToken = EvalPreparationObserver;

export type EvalTelemetryToken = EvalObserver;
