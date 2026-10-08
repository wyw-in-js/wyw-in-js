import type {
  EvalResolverKind,
  EvalWarning,
  FeatureFlags,
  ImportOverrides,
} from '@wyw-in-js/shared';

import type { SerializedError, SerializedValue } from './serialize';

/**
 * Export conditions for the runner's own resolution, expanded per edge kind
 * (`import` also covers dynamic imports).
 */
export type EvalRunnerConditions = {
  import: string[];
  require: string[];
};

export type EvalRunnerInitPayload = {
  evalOptions: {
    errors: 'strict' | 'loose';
    require: 'warn-and-run' | 'error' | 'off';
    globals: Record<string, unknown>;
    importOverrides?: ImportOverrides;
    root?: string;
    extensions?: string[];
    /** Absent when no conditionNames are configured: Node defaults apply. */
    conditions?: EvalRunnerConditions;
  };
  features: FeatureFlags<'happyDOM'>;
  debugEvalFiles?: boolean;
  entrypoint: string;
  reuseModules?: boolean;
  /** Logical broker session used to discard replies from prior INITs. */
  sessionId?: number;
};

export type EvalRequest = {
  id: string;
};

export type EvalResultPayload = {
  values: Record<string, SerializedValue> | null;
  modules?: Record<string, Record<string, SerializedValue>>;
  debugEvalFiles?: Record<string, DebugEvalFileValues>;
};

export type DebugEvalFileValue =
  | {
      serialized: SerializedValue;
      status: 'serialized';
    }
  | {
      reason: string;
      status: 'stringified';
      stringified: string;
    };

export type DebugEvalFileValues = {
  exports?: Record<string, DebugEvalFileValue>;
  preval?: Record<string, DebugEvalFileValue>;
};

export type ResolveRequestPayload = {
  specifier: string;
  importerId: string;
  kind: EvalResolverKind;
};

export type ResolveResultPayload = {
  resolvedId: string | null;
  external?: boolean;
  error?: SerializedError;
};

export type LoadRequestPayload = {
  id: string;
  importerId?: string | null;
  request?: string | null;
};

export type LoadResultPayload = {
  id: string;
  code?: string;
  codeChunk?: string;
  chunkIndex?: number;
  chunkCount?: number;
  map?: unknown;
  hash?: string;
  only?: string[];
  exports?: Record<string, SerializedValue>;
  resetModule?: true;
  error?: SerializedError;
};

export type InitMessage = {
  type: 'INIT';
  id: string;
  payload: EvalRunnerInitPayload;
};

export type InitAckMessage = {
  type: 'INIT_ACK';
  id: string;
  error?: SerializedError;
  // Set by the runner when it just reset its moduleCache during INIT (full
  // context rebuild, including every `reuseModules: false`). The broker uses
  // this to invalidate its "what runner has" mirror without doing any
  // payload hashing or stringification on its own hot path.
  modulesReset?: boolean;
};

export type EvalMessage = {
  type: 'EVAL';
  id: string;
  payload: EvalRequest;
};

export type EvalResultMessage = {
  type: 'EVAL_RESULT';
  id: string;
  payload: EvalResultPayload;
  error?: SerializedError;
};

export type ResolveMessage = {
  type: 'RESOLVE';
  id: string;
  payload: ResolveRequestPayload;
  sessionId?: number;
};

export type ResolveResultMessage = {
  type: 'RESOLVE_RESULT';
  id: string;
  payload: ResolveResultPayload;
};

export type LoadMessage = {
  type: 'LOAD';
  id: string;
  payload: LoadRequestPayload;
  sessionId?: number;
};

export type LoadResultMessage = {
  type: 'LOAD_RESULT';
  id: string;
  payload: LoadResultPayload;
};

export type WarnMessage = {
  type: 'WARN';
  payload: EvalWarning;
};

export type RunnerToMainMessage =
  | ResolveMessage
  | LoadMessage
  | WarnMessage
  | InitAckMessage
  | EvalResultMessage;

export type MainToRunnerMessage =
  | InitMessage
  | EvalMessage
  | ResolveResultMessage
  | LoadResultMessage;
