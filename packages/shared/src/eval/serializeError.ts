/**
 * An error as it crosses the eval protocol: the fields that survive JSON.
 *
 * @internal Shared by the eval broker and the eval runner.
 */
export type SerializedError = {
  message: string;
  name?: string;
  stack?: string;
  cause?: SerializedError;
};

const readCause = (error: object): unknown => {
  try {
    return 'cause' in error ? (error as { cause?: unknown }).cause : undefined;
  } catch {
    return undefined;
  }
};

// A cause is carried when it looks like an error: an object with a string
// message. Errors from a `vm` context fail `instanceof Error`, so the check
// reads the shape instead of the class.
const hasErrorShape = (value: unknown): value is object => {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return typeof (value as { message?: unknown }).message === 'string';
  } catch {
    return false;
  }
};

const serializeErrorChain = (
  error: unknown,
  seen: Set<object>
): SerializedError => {
  if (typeof error === 'object' && error !== null) {
    let serialized: SerializedError | null = null;
    try {
      const { message, name, stack } = error as {
        message?: unknown;
        name?: unknown;
        stack?: unknown;
      };
      if (typeof message === 'string') {
        serialized = {
          message,
          name: typeof name === 'string' ? name : undefined,
          stack: typeof stack === 'string' ? stack : undefined,
        };
      }
    } catch {
      // Fall through to the guarded string representation below. Errors may
      // come from another VM context or even be proxy-like thrown values.
    }

    if (serialized) {
      seen.add(error);
      const cause = readCause(error);
      if (hasErrorShape(cause) && !seen.has(cause)) {
        serialized.cause = serializeErrorChain(cause, seen);
      }

      return serialized;
    }
  }

  try {
    return { message: String(error) };
  } catch {
    return { message: 'Unknown error' };
  }
};

/**
 * Encodes a thrown value with its message, name, stack and the whole chain
 * of error causes. A cycle in the chain stops at the error already encoded.
 *
 * @internal Shared by the eval broker and the eval runner.
 */
export const serializeError = (error: unknown): SerializedError =>
  serializeErrorChain(error, new Set());

/**
 * Restores an encoded error as an `Error` with the encoded name, stack and
 * causes. A missing value gives an `Error` with an empty message.
 *
 * @internal Shared by the eval broker and the eval runner.
 */
export const deserializeError = (
  value: SerializedError | null | undefined
): Error => {
  const error = new Error(value?.message ?? '');
  if (value?.name) {
    error.name = value.name;
  }

  if (value?.stack) {
    error.stack = value.stack;
  }

  if (value?.cause) {
    // An assigned cause is enumerable, so it survives the structured clone
    // of the parallel transform pool.
    error.cause = deserializeError(value.cause);
  }

  return error;
};
