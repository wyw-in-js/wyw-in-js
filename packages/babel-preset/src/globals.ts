import { isPlainObject } from '@wyw-in-js/shared';

const ENCODED_GLOBAL_ENVELOPE_KEY = '__wyw_eval_global';
const ENCODED_GLOBAL_SIGNATURE = 'wyw-eval-global';
const ENCODED_GLOBAL_VERSION = 1;

type EncodedFunctionPayload = {
  kind: 'function';
  signature: typeof ENCODED_GLOBAL_SIGNATURE;
  source: string;
  version: typeof ENCODED_GLOBAL_VERSION;
};

type EncodedSymbolPayload = {
  description: string;
  kind: 'symbol';
  signature: typeof ENCODED_GLOBAL_SIGNATURE;
  version: typeof ENCODED_GLOBAL_VERSION;
};

type EncodedGlobalPayload = EncodedFunctionPayload | EncodedSymbolPayload;

type EncodedGlobal = {
  [ENCODED_GLOBAL_ENVELOPE_KEY]: EncodedGlobalPayload;
};

const formatGlobalsPath = (path: Array<string | number>): string =>
  path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') {
      return `${acc}[${segment}]`;
    }

    return /^[A-Za-z_$][\w$]*$/u.test(segment)
      ? `${acc}.${segment}`
      : `${acc}[${JSON.stringify(segment)}]`;
  }, 'eval.globals');

const validateFunctionSource = (
  source: string,
  path: Array<string | number>
) => {
  try {
    // eslint-disable-next-line no-eval
    const restored = eval(`(${source})`) as unknown;
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

const encodeGlobalsAtPath = (
  value: unknown,
  path: Array<string | number>
): unknown => {
  if (typeof value === 'function') {
    const source = value.toString();
    validateFunctionSource(source, path);

    return {
      [ENCODED_GLOBAL_ENVELOPE_KEY]: {
        signature: ENCODED_GLOBAL_SIGNATURE,
        version: ENCODED_GLOBAL_VERSION,
        kind: 'function',
        source,
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
    throw new Error(
      `[wyw-in-js] eval.globals contains an unsupported non-plain object at ${formatGlobalsPath(
        path
      )}. Use JSON-like primitives, arrays, plain objects, functions, and symbols.`
    );
  }

  return value;
};

export const encodeGlobals = (value: unknown): unknown =>
  encodeGlobalsAtPath(value, []);

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

  return value.kind === 'symbol' && typeof value.description === 'string';
};

const isEncodedGlobal = (value: unknown): value is EncodedGlobal => {
  if (!isPlainObject(value)) {
    return false;
  }

  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === ENCODED_GLOBAL_ENVELOPE_KEY &&
    isEncodedGlobalPayload(value[ENCODED_GLOBAL_ENVELOPE_KEY])
  );
};

const decodeGlobalsAtPath = (
  value: unknown,
  path: Array<string | number>
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      decodeGlobalsAtPath(item, [...path, index])
    );
  }

  if (isEncodedGlobal(value)) {
    const payload = value[ENCODED_GLOBAL_ENVELOPE_KEY];
    if (payload.kind === 'function') {
      try {
        // eslint-disable-next-line no-eval
        const restored = eval(`(${payload.source})`) as unknown;
        if (typeof restored !== 'function') {
          throw new TypeError('decoded source is not a function');
        }

        return restored;
      } catch (error) {
        throw new Error(
          `[wyw-in-js] Failed to restore eval.globals function at ${formatGlobalsPath(
            path
          )}. Original error: ${String(error)}`
        );
      }
    }

    return Symbol(payload.description);
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        decodeGlobalsAtPath(item, [...path, key]),
      ])
    );
  }

  return value;
};

export const decodeGlobals = (value: unknown): unknown =>
  decodeGlobalsAtPath(value, []);
