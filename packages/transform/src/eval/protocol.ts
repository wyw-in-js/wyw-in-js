import { isPlainObject } from '@wyw-in-js/shared';
import type {
  EvalResolverKind,
  EvalWarning,
  EvalWarningCode,
  FeatureFlags,
  ImportOverrides,
  SerializedError,
  SerializedValue,
} from '@wyw-in-js/shared';

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
  /** Ids the runner dropped from its caches during this evaluation. */
  evictedIds?: string[];
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

/**
 * Warning codes the runner sends: the public `EvalWarningCode` and the codes
 * the public type of the 2.x line does not list.
 */
export type RunnerWarningCode = EvalWarningCode | 'eval-stale-module';

export type RunnerWarning = Omit<EvalWarning, 'code'> & {
  code: RunnerWarningCode;
};

export type WarnMessage = {
  type: 'WARN';
  payload: RunnerWarning;
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

/** The arguments of a request from the broker to the runner. */
export type RunnerRequestArgs =
  | [type: 'INIT', payload: EvalRunnerInitPayload, timeoutMs?: number]
  | [type: 'EVAL', payload: EvalRequest, timeoutMs?: number];

const RUNNER_MESSAGE_TYPES = new Set([
  'INIT_ACK',
  'EVAL_RESULT',
  'RESOLVE',
  'LOAD',
  'WARN',
]);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * Parses one line that the runner wrote to stdout and checks the envelope of
 * the message: its type, its id and its payload. Returns `null` for a line
 * that is not JSON or not a message of the protocol.
 */
export const parseRunnerMessage = (
  line: string
): RunnerToMainMessage | null => {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isPlainObject(message) || typeof message.type !== 'string') {
    return null;
  }

  const { type, id, payload } = message;
  if (!RUNNER_MESSAGE_TYPES.has(type)) return null;
  if (type !== 'WARN' && typeof id !== 'string') return null;
  if (type === 'INIT_ACK') return message as RunnerToMainMessage;
  if (!isPlainObject(payload)) return null;

  if (
    type === 'WARN' &&
    (typeof payload.code !== 'string' || typeof payload.message !== 'string')
  ) {
    return null;
  }

  if (
    type === 'EVAL_RESULT' &&
    payload.evictedIds !== undefined &&
    !isStringArray(payload.evictedIds)
  ) {
    return null;
  }

  return message as RunnerToMainMessage;
};
