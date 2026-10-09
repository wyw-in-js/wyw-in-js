import { isPlainObject } from '@wyw-in-js/shared';

export type SerializedError = {
  message: string;
  name?: string;
  stack?: string;
  cause?: SerializedError;
};

export type SerializedValue =
  | { kind: 'value'; value: unknown }
  | { kind: 'null' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'function' }
  | { kind: 'symbol'; description: string }
  | { kind: 'unavailable'; error: SerializedError }
  | { kind: 'error'; error: SerializedError }
  | { kind: 'undefined' }
  | { kind: 'bigint'; value: string }
  | { kind: 'nan' }
  | { kind: 'infinity' }
  | { kind: '-infinity' }
  | { kind: 'array'; items: SerializedValue[] }
  | { kind: 'object'; entries: Record<string, SerializedValue> };

const ENCODED_GLOBAL_ENVELOPE_KEY = '__wyw_eval_global';
const ENCODED_GLOBAL_SIGNATURE = 'wyw-eval-global';
const ENCODED_GLOBAL_VERSION = 1;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/u;
const ARRAY_INDEX_RE = /^(?:0|[1-9]\d*)$/;
const IPC_SUPPORTED_VALUE_HINT =
  'Use importOverrides to mock the import or return plain data: null, booleans, strings, numbers, bigint, undefined, arrays, plain objects, and Error.';

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

export type EncodedGlobal = {
  [ENCODED_GLOBAL_ENVELOPE_KEY]: EncodedGlobalPayload;
};

type PathSegment = string | number | symbol;

type SerializeValueOptions = {
  allowFunctions?: boolean;
  allowSymbols?: boolean;
  deferNestedFailures?: boolean;
  ignoreSymbolKeys?: boolean;
  path?: PathSegment[];
  rootLabel?: string;
};

const isLikeError = (value: unknown): value is Error =>
  typeof value === 'object' &&
  value !== null &&
  !isPlainObject(value) &&
  'message' in value &&
  typeof value.message === 'string' &&
  ('stack' in value || 'name' in value);

const isCallable = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === 'function';

const getBoxedPrimitiveValue = (
  value: object
):
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | null => {
  const tag = Object.prototype.toString.call(value);

  if (tag === '[object String]') {
    return { kind: 'string', value: String(value.valueOf()) };
  }

  if (tag === '[object Number]') {
    return { kind: 'number', value: Number(value.valueOf()) };
  }

  if (tag === '[object Boolean]') {
    return { kind: 'boolean', value: Boolean(value.valueOf()) };
  }

  return null;
};

const getObjectTypeName = (value: object): string => {
  const { constructor } = value as { constructor?: { name?: unknown } };
  if (
    constructor &&
    typeof constructor.name === 'string' &&
    constructor.name.length > 0
  ) {
    return constructor.name;
  }

  const tag = Object.prototype.toString.call(value);
  return tag.slice(8, -1) || 'Object';
};

const formatPath = (
  rootLabel: string,
  path: PathSegment[],
  identifierRe: RegExp = IDENTIFIER_RE
): string =>
  path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') {
      return `${acc}[${segment}]`;
    }

    if (typeof segment === 'symbol') {
      return `${acc}[${String(segment)}]`;
    }

    if (identifierRe.test(segment)) {
      return `${acc}.${segment}`;
    }

    return `${acc}[${JSON.stringify(segment)}]`;
  }, rootLabel);

const formatGlobalsPath = (path: Array<string | number>): string =>
  formatPath('eval.globals', path);

const getEnumerableSymbolKeys = (value: object): symbol[] =>
  Object.getOwnPropertySymbols(value).filter((key) =>
    Object.prototype.propertyIsEnumerable.call(value, key)
  );

const IPC_SERIALIZATION_ERROR = Symbol('wyw.ipcSerializationError');

const createIpcSerializationError = (message: string): Error =>
  Object.assign(new Error(message), { [IPC_SERIALIZATION_ERROR]: true });

const isIpcSerializationError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  IPC_SERIALIZATION_ERROR in error;

const throwUnsupportedIpcValue = (
  rootLabel: string,
  path: PathSegment[],
  description: string
): never => {
  throw createIpcSerializationError(
    `[wyw-in-js] ${rootLabel} contains ${description} at ${formatPath(
      rootLabel,
      path
    )}. ${IPC_SUPPORTED_VALUE_HINT}`
  );
};

const serializeUnavailableError = (error: unknown): SerializedError => {
  if (typeof error === 'object' && error !== null) {
    try {
      const { message, name, stack } = error as {
        message?: unknown;
        name?: unknown;
        stack?: unknown;
      };
      if (typeof message === 'string') {
        return {
          message,
          name: typeof name === 'string' ? name : undefined,
          stack: typeof stack === 'string' ? stack : undefined,
        };
      }
    } catch {
      // Fall through to the guarded string representation below. Errors may
      // come from another VM context or even be proxy-like thrown values.
    }
  }

  try {
    return { message: String(error) };
  } catch {
    return { message: 'Unknown error' };
  }
};

type SerializeValueAtPath = (
  value: unknown,
  rootLabel: string,
  path: PathSegment[],
  seen: WeakMap<object, string>,
  allowFunctions: boolean,
  allowSymbols: boolean,
  deferNestedFailures: boolean,
  ignoreSymbolKeys: boolean
) => SerializedValue;

const serializeNestedValue = (
  readValue: () => unknown,
  rootLabel: string,
  path: PathSegment[],
  seen: WeakMap<object, string>,
  allowFunctions: boolean,
  allowSymbols: boolean,
  ignoreSymbolKeys: boolean,
  serialize: SerializeValueAtPath
): SerializedValue => {
  // Processor values are demand-driven: a processor may inspect one metadata
  // field without observing unrelated runtime state on the same object. Keep
  // the serializable shell usable, but preserve failures at the exact property
  // so data consumers still fail when they actually read it.
  let value: unknown;
  try {
    value = readValue();
  } catch (error) {
    return {
      kind: 'unavailable',
      error: serializeUnavailableError(error),
    };
  }

  try {
    return serialize(
      value,
      rootLabel,
      path,
      seen,
      allowFunctions,
      allowSymbols,
      true,
      ignoreSymbolKeys
    );
  } catch (error) {
    if (!isIpcSerializationError(error)) {
      throw error;
    }

    return {
      kind: 'unavailable',
      error: serializeUnavailableError(error),
    };
  }
};

const serializeValueAtPath: SerializeValueAtPath = (
  value: unknown,
  rootLabel: string,
  path: PathSegment[],
  seen: WeakMap<object, string>,
  allowFunctions: boolean,
  allowSymbols: boolean,
  deferNestedFailures: boolean,
  ignoreSymbolKeys: boolean
): SerializedValue => {
  if (value === null) {
    return { kind: 'null' };
  }

  if (value === undefined) {
    return { kind: 'undefined' };
  }

  if (typeof value === 'boolean') {
    return { kind: 'boolean', value };
  }

  if (typeof value === 'string') {
    return { kind: 'string', value };
  }

  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return { kind: 'nan' };
    }
    if (value === Infinity) {
      return { kind: 'infinity' };
    }
    if (value === -Infinity) {
      return { kind: '-infinity' };
    }

    return { kind: 'number', value };
  }

  if (typeof value === 'bigint') {
    return { kind: 'bigint', value: value.toString() };
  }

  if (typeof value === 'function') {
    if (allowFunctions) {
      // __wywPreval consumers only rely on function-ness, not implementation
      // identity. Preserve that signal explicitly instead of letting JSON
      // coerce to null/undefined.
      return { kind: 'function' };
    }

    throwUnsupportedIpcValue(rootLabel, path, 'an unsupported function');
  }

  if (typeof value === 'symbol') {
    if (allowSymbols) {
      return { kind: 'symbol', description: value.description ?? '' };
    }

    throwUnsupportedIpcValue(rootLabel, path, 'an unsupported symbol');
  }

  if (typeof value === 'object' && value !== null) {
    const boxed = getBoxedPrimitiveValue(value as object);
    if (boxed) {
      if (boxed.kind === 'number') {
        if (Number.isNaN(boxed.value)) {
          return { kind: 'nan' };
        }
        if (boxed.value === Infinity) {
          return { kind: 'infinity' };
        }
        if (boxed.value === -Infinity) {
          return { kind: '-infinity' };
        }
      }

      return boxed;
    }
  }

  if (isLikeError(value)) {
    return {
      kind: 'error',
      error: {
        message: value.message,
        name: value.name,
        stack: value.stack,
      },
    };
  }

  const currentPath = formatPath(rootLabel, path);
  const seenAt = seen.get(value as object);
  if (seenAt) {
    throw createIpcSerializationError(
      `[wyw-in-js] ${rootLabel} contains a circular reference at ${currentPath} (from ${seenAt}). ${IPC_SUPPORTED_VALUE_HINT}`
    );
  }

  if (Array.isArray(value)) {
    const symbolKeys = getEnumerableSymbolKeys(value);
    if (symbolKeys.length > 0 && !ignoreSymbolKeys) {
      throwUnsupportedIpcValue(
        rootLabel,
        [...path, symbolKeys[0]],
        'an unsupported symbol-keyed property'
      );
    }

    const extraKey = Object.keys(value).find(
      (key) => !ARRAY_INDEX_RE.test(key) || Number(key) >= value.length
    );
    if (extraKey !== undefined) {
      throwUnsupportedIpcValue(
        rootLabel,
        [...path, extraKey],
        'an unsupported non-index array property'
      );
    }

    seen.set(value, currentPath);
    try {
      return {
        kind: 'array',
        items: Array.from({ length: value.length }, (_, index) =>
          deferNestedFailures
            ? serializeNestedValue(
                () => value[index],
                rootLabel,
                [...path, index],
                seen,
                allowFunctions,
                allowSymbols,
                ignoreSymbolKeys,
                serializeValueAtPath
              )
            : serializeValueAtPath(
                value[index],
                rootLabel,
                [...path, index],
                seen,
                allowFunctions,
                allowSymbols,
                false,
                ignoreSymbolKeys
              )
        ),
      };
    } finally {
      seen.delete(value);
    }
  }

  if (!isPlainObject(value)) {
    throwUnsupportedIpcValue(
      rootLabel,
      path,
      `an unsupported non-plain object (${getObjectTypeName(value as object)})`
    );
  }

  const symbolKeys = getEnumerableSymbolKeys(value);
  if (symbolKeys.length > 0 && !ignoreSymbolKeys) {
    throwUnsupportedIpcValue(
      rootLabel,
      [...path, symbolKeys[0]],
      'an unsupported symbol-keyed property'
    );
  }

  seen.set(value, currentPath);
  try {
    return {
      kind: 'object',
      entries: Object.fromEntries(
        deferNestedFailures
          ? Object.keys(value).map((key) => [
              key,
              serializeNestedValue(
                () => (value as Record<string, unknown>)[key],
                rootLabel,
                [...path, key],
                seen,
                allowFunctions,
                allowSymbols,
                ignoreSymbolKeys,
                serializeValueAtPath
              ),
            ])
          : Object.entries(value).map(([key, item]) => [
              key,
              serializeValueAtPath(
                item,
                rootLabel,
                [...path, key],
                seen,
                allowFunctions,
                allowSymbols,
                false,
                ignoreSymbolKeys
              ),
            ])
      ),
    };
  } finally {
    seen.delete(value);
  }
};

export const serializeValue = (
  value: unknown,
  options: SerializeValueOptions = {}
): SerializedValue =>
  serializeValueAtPath(
    value,
    options.rootLabel ?? 'value',
    options.path ?? [],
    new WeakMap<object, string>(),
    options.allowFunctions ?? false,
    options.allowSymbols ?? false,
    options.deferNestedFailures ?? false,
    options.ignoreSymbolKeys ?? false
  );

const deserializeError = (value: SerializedError): Error => {
  const error = new Error(value.message);
  if (value.name) {
    error.name = value.name;
  }

  if (value.stack) {
    error.stack = value.stack;
  }

  return error;
};

const defineDeserializedProperty = (
  target: object,
  key: string | number,
  value: SerializedValue,
  deserialize: (serialized: SerializedValue) => unknown
): void => {
  if (value.kind === 'unavailable') {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get() {
        throw deserializeError(value.error);
      },
      set(this: object, replacement: unknown) {
        Object.defineProperty(this, key, {
          configurable: true,
          enumerable: true,
          value: replacement,
          writable: true,
        });
      },
    });
    return;
  }

  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value: deserialize(value),
    writable: true,
  });
};

export const deserializeValue = (value: SerializedValue): unknown => {
  switch (value.kind) {
    case 'null':
      return null;
    case 'boolean':
    case 'string':
    case 'number':
      return value.value;
    case 'undefined':
      return undefined;
    case 'bigint':
      return BigInt(value.value);
    case 'nan':
      return Number.NaN;
    case 'infinity':
      return Infinity;
    case '-infinity':
      return -Infinity;
    case 'function':
      return () => {};
    case 'symbol':
      // eslint-disable-next-line symbol-description
      return value.description ? Symbol.for(value.description) : Symbol();
    case 'unavailable':
      throw deserializeError(value.error);
    case 'error': {
      return deserializeError(value.error);
    }
    case 'array': {
      const result = new Array(value.items.length) as unknown[];
      value.items.forEach((item, index) => {
        defineDeserializedProperty(result, index, item, deserializeValue);
      });
      return result;
    }
    case 'object': {
      const result: Record<string, unknown> = {};
      Object.entries(value.entries).forEach(([key, item]) => {
        defineDeserializedProperty(result, key, item, deserializeValue);
      });
      return result;
    }
    case 'value':
    default:
      return value.value;
  }
};

export const serializePreval = (
  values: Record<string, unknown>
): Record<string, SerializedValue> =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      serializeValue(value, {
        allowFunctions: true,
        allowSymbols: true,
        deferNestedFailures: true,
        ignoreSymbolKeys: true,
        rootLabel: '__wywPreval',
        path: [key],
      }),
    ])
  );

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

const restoreFunction = (source: string, path: Array<string | number>) => {
  try {
    // eslint-disable-next-line no-eval
    const restored = eval(`(${source})`) as unknown;
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

export const encodeGlobals = (value: unknown): unknown =>
  encodeGlobalsAtPath(value, []);

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
      return restoreFunction(payload.source, path);
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
