import { isPlainObject } from '../isPlainObject';

import { formatPath, getObjectTypeName } from './serializeValue';

const ENCODED_GLOBAL_ENVELOPE_KEY = '__wyw_eval_global';
const ENCODED_GLOBAL_SIGNATURE = 'wyw-eval-global';
const ENCODED_GLOBAL_VERSION = 1;

type EncodedFunctionPayload = {
  signature: typeof ENCODED_GLOBAL_SIGNATURE;
  version: typeof ENCODED_GLOBAL_VERSION;
  kind: 'function';
  source: string;
};

type EncodedSymbolPayload = {
  signature: typeof ENCODED_GLOBAL_SIGNATURE;
  version: typeof ENCODED_GLOBAL_VERSION;
  kind: 'symbol';
  description: string;
};

type EncodedGlobalPayload = EncodedFunctionPayload | EncodedSymbolPayload;

/**
 * The JSON envelope of a function or a symbol of `eval.globals`.
 *
 * @internal Shared by the eval broker, the eval runner and the Babel preset.
 */
export type EncodedGlobal = {
  [ENCODED_GLOBAL_ENVELOPE_KEY]: EncodedGlobalPayload;
};

type EvaluateFunctionSource = (source: string) => unknown;

// Direct eval: the source sees the scope of this module. A caller that needs
// another scope passes its own `evaluate` to `decodeGlobals`.
const evaluateInThisModule: EvaluateFunctionSource = (source) =>
  // eslint-disable-next-line no-eval
  eval(`(${source})`);

const formatGlobalsPath = (path: Array<string | number>): string =>
  formatPath('eval.globals', path);

const isCallable = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === 'function';

const throwUnsupportedNonPlainObject = (
  value: object,
  path: Array<string | number>
): never => {
  throw new Error(
    `[wyw-in-js] eval.globals contains an unsupported non-plain object at ${formatGlobalsPath(
      path
    )} (${getObjectTypeName(value)}). ` +
      `Use JSON-like primitives, arrays, plain objects, functions, and symbols.`
  );
};

const restoreFunction = (
  source: string,
  path: Array<string | number>,
  evaluate: EvaluateFunctionSource
) => {
  try {
    const restored = evaluate(source);
    if (typeof restored !== 'function') {
      throw new TypeError('decoded source is not a function');
    }

    return restored;
  } catch (error) {
    throw new Error(
      `[wyw-in-js] Failed to restore eval.globals function at ${formatGlobalsPath(
        path
      )}. ` +
        `Ensure the value is a user-defined function expression/arrow function. ` +
        `Native and bound functions are not supported. ` +
        `Original error: ${String(error)}`
    );
  }
};

const validateFunctionSource = (
  source: string,
  path: Array<string | number>
) => {
  try {
    const restored = evaluateInThisModule(source);
    if (typeof restored !== 'function') {
      throw new TypeError('decoded source is not a function');
    }
  } catch (error) {
    throw new Error(
      `[wyw-in-js] eval.globals contains an unsupported function at ${formatGlobalsPath(
        path
      )}. ` +
        `Ensure the value is a user-defined function expression/arrow function. ` +
        `Native and bound functions are not supported. ` +
        `Original error: ${String(error)}`
    );
  }
};

const serializeFunction = (
  value: (...args: unknown[]) => unknown,
  path: Array<string | number>
) => {
  const source = value.toString();

  // Validate that the source is restorable before storing it.
  validateFunctionSource(source, path);

  return source;
};

const isEncodedGlobalPayload = (
  value: unknown
): value is EncodedGlobalPayload => {
  if (!isPlainObject(value)) {
    return false;
  }

  if (
    value.signature !== ENCODED_GLOBAL_SIGNATURE ||
    value.version !== ENCODED_GLOBAL_VERSION
  ) {
    return false;
  }

  if (value.kind === 'function') {
    return typeof value.source === 'string';
  }

  if (value.kind === 'symbol') {
    return typeof value.description === 'string';
  }

  return false;
};

const isEncodedGlobal = (value: unknown): value is EncodedGlobal => {
  if (!isPlainObject(value)) {
    return false;
  }

  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== ENCODED_GLOBAL_ENVELOPE_KEY) {
    return false;
  }

  return isEncodedGlobalPayload(value[ENCODED_GLOBAL_ENVELOPE_KEY]);
};

const encodeGlobalsAtPath = (
  value: unknown,
  path: Array<string | number>
): unknown => {
  if (isCallable(value)) {
    return {
      [ENCODED_GLOBAL_ENVELOPE_KEY]: {
        signature: ENCODED_GLOBAL_SIGNATURE,
        version: ENCODED_GLOBAL_VERSION,
        kind: 'function',
        source: serializeFunction(value, path),
      },
    } satisfies EncodedGlobal;
  }

  if (typeof value === 'symbol') {
    return {
      [ENCODED_GLOBAL_ENVELOPE_KEY]: {
        signature: ENCODED_GLOBAL_SIGNATURE,
        version: ENCODED_GLOBAL_VERSION,
        kind: 'symbol',
        description: value.description ?? '',
      },
    } satisfies EncodedGlobal;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      encodeGlobalsAtPath(item, [...path, index])
    );
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        encodeGlobalsAtPath(item, [...path, key]),
      ])
    );
  }

  if (typeof value === 'object' && value !== null) {
    throwUnsupportedNonPlainObject(value, path);
  }

  return value;
};

/**
 * Encodes `eval.globals` as JSON: functions travel as their source, symbols
 * as their description. Throws on a value that cannot be restored.
 *
 * @internal Shared by the eval broker, the eval runner and the Babel preset.
 */
export const encodeGlobals = (value: unknown): unknown =>
  encodeGlobalsAtPath(value, []);

const decodeGlobalsAtPath = (
  value: unknown,
  path: Array<string | number>,
  evaluate: EvaluateFunctionSource
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      decodeGlobalsAtPath(item, [...path, index], evaluate)
    );
  }

  if (isEncodedGlobal(value)) {
    const payload = value[ENCODED_GLOBAL_ENVELOPE_KEY];
    if (payload.kind === 'function') {
      return restoreFunction(payload.source, path, evaluate);
    }

    return Symbol(payload.description);
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        decodeGlobalsAtPath(item, [...path, key], evaluate),
      ])
    );
  }

  return value;
};

/**
 * Restores `eval.globals` encoded by `encodeGlobals`. `evaluate` turns the
 * source of a function back into a function; without it the source is
 * evaluated by a direct `eval` in this module.
 *
 * @internal Shared by the eval broker, the eval runner and the Babel preset.
 */
export const decodeGlobals = (
  value: unknown,
  evaluate: EvaluateFunctionSource = evaluateInThisModule
): unknown => decodeGlobalsAtPath(value, [], evaluate);
