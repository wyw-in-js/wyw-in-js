import { isPlainObject } from '../isPlainObject';

import {
  deserializeError,
  serializeError,
  type SerializedError,
} from './serializeError';

/**
 * A value as it crosses the eval protocol.
 *
 * @internal Shared by the eval broker and the eval runner.
 */
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

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/u;
const ARRAY_INDEX_RE = /^(?:0|[1-9]\d*)$/;
const IPC_SUPPORTED_VALUE_HINT =
  'Use importOverrides to mock the import or return plain data: null, booleans, strings, numbers, bigint, undefined, arrays, plain objects, and Error.';

export type PathSegment = string | number | symbol;

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

export const getObjectTypeName = (value: object): string => {
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

export const formatPath = (rootLabel: string, path: PathSegment[]): string =>
  path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') {
      return `${acc}[${segment}]`;
    }

    if (typeof segment === 'symbol') {
      return `${acc}[${String(segment)}]`;
    }

    if (IDENTIFIER_RE.test(segment)) {
      return `${acc}.${segment}`;
    }

    return `${acc}[${JSON.stringify(segment)}]`;
  }, rootLabel);

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
      error: serializeError(error),
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
      error: serializeError(error),
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
    return { kind: 'error', error: serializeError(value) };
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

/**
 * Encodes a value for the eval protocol and throws on a value that the
 * protocol cannot carry, naming where it was found.
 *
 * @internal Shared by the eval broker and the eval runner.
 */
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

const defineDeserializedProperty = (
  target: object,
  key: string | number,
  value: SerializedValue | null | undefined,
  deserialize: (serialized: SerializedValue | null | undefined) => unknown
): void => {
  if (value?.kind === 'unavailable') {
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

/**
 * Restores an encoded value. A missing value restores as `undefined`.
 *
 * @internal Shared by the eval broker and the eval runner.
 */
export const deserializeValue = (
  value: SerializedValue | null | undefined
): unknown => {
  switch (value?.kind) {
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
      // An unknown kind, like a missing value, falls back to its raw value.
      return (value as { value?: unknown } | null | undefined)?.value;
  }
};

/**
 * Encodes the values of `__wywPreval`: functions become stubs, symbols keep
 * their description, and a value that cannot be read or encoded fails only
 * where it is read.
 *
 * @internal Shared by the eval broker and the eval runner.
 */
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
