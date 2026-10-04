import type { RawSourceMap } from 'source-map';

import type { PartialOptions } from '../transform/helpers/loadWywOptions';
import type { Preprocessor, Result } from '../types';

/**
 * Everything a worker needs to run `transform()` for one adapter scope (for
 * example the client environment of one Vite plugin instance). It crosses a
 * thread boundary, so every value must be structured-cloneable: function
 * options have to come from a wyw-in-js config file, which workers load
 * themselves.
 */
export type TransformWorkerScopeConfig = {
  /** Stable key for the bundler resolver; it is part of the eval cache key. */
  asyncResolveKey: string;
  /**
   * Globals added to the evaluation context of every module, standing in for
   * an adapter's own `overrideContext` (e.g. Vite's `import.meta.env`).
   */
  contextGlobals?: Record<string, unknown>;
  keepComments?: boolean | RegExp;
  pluginOptions: PartialOptions;
  prefixer?: boolean;
  preprocessor?: Preprocessor;
  root: string;
};

export type SerializedError = {
  message: string;
  name: string;
  props: Record<string, unknown>;
  stack?: string;
};

export type MainToWorkerMessage =
  | { config: TransformWorkerScopeConfig; scopeId: number; type: 'scope' }
  | {
      code: string;
      filename: string;
      inputSourceMap?: RawSourceMap;
      jobId: number;
      outputFilename?: string;
      scopeId: number;
      type: 'transform';
    }
  | {
      error?: SerializedError;
      requestId: number;
      result?: string | null;
      type: 'resolved';
    }
  | { filename: string; scopeId: number; type: 'invalidate' }
  | { scopeId: number; type: 'clear' }
  | { scopeId: number; type: 'disposeEvalBroker' }
  | { scopeId: number; type: 'disposeScope' }
  | { type: 'shutdown' };

export type WorkerToMainMessage =
  | {
      importer: string;
      jobId: number;
      requestId: number;
      scopeId: number;
      stack: string[];
      type: 'resolve';
      what: string;
    }
  | { jobId: number; message: string; type: 'warning' }
  | { error?: SerializedError; jobId: number; result?: Result; type: 'done' }
  | { type: 'ready' };

const isCloneablePrimitive = (value: unknown): boolean =>
  value === null ||
  ['boolean', 'number', 'string', 'undefined'].includes(typeof value);

export const serializeError = (error: unknown): SerializedError => {
  if (!(error instanceof Error)) {
    return { message: String(error), name: 'Error', props: {} };
  }

  // Keep the extra fields bundlers report (code, id, loc, frame, ...), as
  // long as they survive a structured clone.
  const props: Record<string, unknown> = {};
  Object.entries(error).forEach(([key, value]) => {
    if (isCloneablePrimitive(value)) {
      props[key] = value;
      return;
    }

    try {
      props[key] = structuredClone(value);
    } catch {
      // Not transferable; drop it.
    }
  });

  return {
    message: error.message,
    name: error.name,
    props,
    stack: error.stack,
  };
};

export const deserializeError = (serialized: SerializedError): Error => {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  if (serialized.stack) {
    error.stack = serialized.stack;
  }

  Object.assign(error, serialized.props);
  return error;
};

/**
 * Returns the path of the first option that cannot be sent to a worker
 * (typically a function), or null if all options are structured-cloneable.
 */
export const findNonTransferableOption = (
  value: unknown,
  path = ''
): string | null => {
  if (isCloneablePrimitive(value) || value instanceof RegExp) {
    return null;
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return path;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findNonTransferableOption(value[i], `${path}[${i}]`);
      if (found !== null) return found;
    }

    return null;
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      try {
        structuredClone(value);
        return null;
      } catch {
        return path;
      }
    }

    for (const [key, item] of Object.entries(value as object)) {
      const found = findNonTransferableOption(
        item,
        path ? `${path}.${key}` : key
      );
      if (found !== null) return found;
    }
  }

  return null;
};
