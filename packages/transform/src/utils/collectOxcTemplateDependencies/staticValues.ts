/* eslint-disable no-restricted-syntax,no-continue */

import { types as nodeUtilTypes } from 'util';

export const isStaticProxy = (value: unknown): value is object =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  nodeUtilTypes.isProxy(value);

const invalidStaticLiteral = Symbol('wyw.oxc.invalidStaticLiteral');

const staticStringLiteral = (
  value: string
): string | typeof invalidStaticLiteral => {
  const literal = JSON.stringify(value);
  return typeof literal === 'string' ? literal : invalidStaticLiteral;
};

const isLiteralDataDescriptor = (
  descriptor: PropertyDescriptor | undefined
): descriptor is PropertyDescriptor & { value: unknown } =>
  !!descriptor &&
  'value' in descriptor &&
  descriptor.configurable === true &&
  descriptor.enumerable === true &&
  descriptor.writable === true;

const staticLiteralCodeInternal = (
  value: unknown,
  ancestors: WeakSet<object>,
  wrapObject = false
): string | typeof invalidStaticLiteral => {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return staticStringLiteral(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return invalidStaticLiteral;
    }
    return Object.is(value, -0) ? '-0' : String(value);
  }

  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    isStaticProxy(value) ||
    typeof value === 'function'
  ) {
    return invalidStaticLiteral;
  }

  if (ancestors.has(value)) {
    return invalidStaticLiteral;
  }

  const isArray = Array.isArray(value);
  if (
    Object.getPrototypeOf(value) !==
      (isArray ? Array.prototype : Object.prototype) ||
    !Object.isExtensible(value)
  ) {
    return invalidStaticLiteral;
  }

  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) {
      return invalidStaticLiteral;
    }

    if (isArray) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        !lengthDescriptor ||
        !('value' in lengthDescriptor) ||
        typeof lengthDescriptor.value !== 'number' ||
        lengthDescriptor.configurable !== false ||
        lengthDescriptor.enumerable !== false ||
        lengthDescriptor.writable !== true
      ) {
        return invalidStaticLiteral;
      }

      const length = lengthDescriptor.value;
      const elements: string[] = new Array(length);
      let elementCount = 0;
      for (const key of keys) {
        if (key === 'length') {
          continue;
        }

        const index = Number(key);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= length ||
          String(index) !== key
        ) {
          return invalidStaticLiteral;
        }

        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!isLiteralDataDescriptor(descriptor)) {
          return invalidStaticLiteral;
        }

        const element = staticLiteralCodeInternal(descriptor.value, ancestors);
        if (element === invalidStaticLiteral) {
          return invalidStaticLiteral;
        }

        elements[index] = element;
        elementCount += 1;
      }

      // Array holes stringify as `null`, which changes their observable shape.
      // Reject them instead of silently materializing elements.
      if (elementCount !== length) {
        return invalidStaticLiteral;
      }

      return `[${elements.join(',')}]`;
    }

    const properties: string[] = [];
    for (const key of keys) {
      if (typeof key !== 'string') {
        return invalidStaticLiteral;
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isLiteralDataDescriptor(descriptor)) {
        return invalidStaticLiteral;
      }

      const propertyValue = staticLiteralCodeInternal(
        descriptor.value,
        ancestors
      );
      if (propertyValue === invalidStaticLiteral) {
        return invalidStaticLiteral;
      }

      const keyCode = staticStringLiteral(key);
      if (keyCode === invalidStaticLiteral) {
        return invalidStaticLiteral;
      }
      const safeKey = key === '__proto__' ? `[${keyCode}]` : keyCode;
      properties.push(`${safeKey}:${propertyValue}`);
    }

    const objectCode = `{${properties.join(',')}}`;
    return wrapObject ? `(${objectCode})` : objectCode;
  } finally {
    ancestors.delete(value);
  }
};

export const literalCode = (value: unknown): string | null => {
  try {
    const literal = staticLiteralCodeInternal(value, new WeakSet(), true);
    return literal === invalidStaticLiteral ? null : literal;
  } catch {
    return null;
  }
};

export const isStaticSerializableValue = (value: unknown): boolean =>
  literalCode(value) !== null;

const unsafeStaticClone = Symbol('wyw.oxc.unsafeStaticClone');

const cloneStaticValueInternal = (
  value: unknown,
  seen = new WeakMap<object, unknown>()
): unknown | typeof unsafeStaticClone => {
  if (isStaticProxy(value)) {
    return unsafeStaticClone;
  }

  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing) {
      return existing;
    }

    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const result: unknown[] = new Array(
      typeof lengthDescriptor?.value === 'number' ? lengthDescriptor.value : 0
    );
    Object.setPrototypeOf(result, Object.getPrototypeOf(value));
    seen.set(value, result);
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') {
        continue;
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        continue;
      }

      if ('value' in descriptor) {
        const clonedValue = cloneStaticValueInternal(descriptor.value, seen);
        if (clonedValue === unsafeStaticClone) {
          return unsafeStaticClone;
        }
        Object.defineProperty(result, key, {
          ...descriptor,
          value: clonedValue,
        });
      } else {
        Object.defineProperty(result, key, descriptor);
      }
    }
    if (lengthDescriptor) {
      Object.defineProperty(result, 'length', lengthDescriptor);
    }
    return result;
  }

  if (typeof value === 'object' && value !== null) {
    const existing = seen.get(value);
    if (existing) {
      return existing;
    }

    const result = Object.create(Object.getPrototypeOf(value)) as Record<
      string,
      unknown
    >;
    seen.set(value, result);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        continue;
      }

      if ('value' in descriptor) {
        const clonedValue = cloneStaticValueInternal(descriptor.value, seen);
        if (clonedValue === unsafeStaticClone) {
          return unsafeStaticClone;
        }
        Object.defineProperty(result, key, {
          ...descriptor,
          value: clonedValue,
        });
      } else {
        Object.defineProperty(result, key, descriptor);
      }
    }
    return result;
  }

  return value;
};

export const cloneStaticValue = (
  value: unknown,
  seen = new WeakMap<object, unknown>()
): unknown => {
  const cloned = cloneStaticValueInternal(value, seen);
  return cloned === unsafeStaticClone ? undefined : cloned;
};

export type StaticPropertyRead = Readonly<{
  found: boolean;
  safe: boolean;
  value?: unknown;
}>;

export const readOwnDataProperty = (
  value: object,
  key: PropertyKey
): StaticPropertyRead => {
  if (isStaticProxy(value)) {
    return { found: false, safe: false };
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      return { found: false, safe: true };
    }

    return 'value' in descriptor
      ? { found: true, safe: true, value: descriptor.value }
      : { found: true, safe: false };
  } catch {
    return { found: false, safe: false };
  }
};

export const defineStaticDataProperty = (
  target: object,
  key: PropertyKey,
  value: unknown
): boolean => {
  try {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
    return true;
  } catch {
    return false;
  }
};

export const copyEnumerableOwnDataProperties = (
  target: object,
  source: object,
  excludedStringKeys?: ReadonlySet<string>,
  enumerableSymbols: 'copy' | 'reject' = 'copy'
): boolean => {
  if (isStaticProxy(source)) {
    return false;
  }

  try {
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key === 'string' && excludedStringKeys?.has(key)) {
        continue;
      }

      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor?.enumerable) {
        continue;
      }

      if (typeof key === 'symbol' && enumerableSymbols === 'reject') {
        return false;
      }

      if (
        !('value' in descriptor) ||
        !defineStaticDataProperty(target, key, descriptor.value)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};

export const readObjectMember = (
  objectValue: unknown,
  property: string | number
): StaticPropertyRead => {
  if (
    isStaticProxy(objectValue) ||
    objectValue === null ||
    objectValue === undefined ||
    (typeof objectValue !== 'object' &&
      typeof objectValue !== 'string' &&
      typeof objectValue !== 'number' &&
      typeof objectValue !== 'boolean')
  ) {
    return { found: false, safe: false };
  }

  const target =
    typeof objectValue === 'object' ? objectValue : Object(objectValue);
  return readOwnDataProperty(target, String(property));
};

export const hasOnlyDataProperties = (value: object): boolean => {
  if (isStaticProxy(value)) {
    return false;
  }

  try {
    return Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !!descriptor && 'value' in descriptor;
    });
  } catch {
    return false;
  }
};

export const hasExactPrototype = (
  value: object,
  prototype: object
): boolean => {
  if (isStaticProxy(value)) {
    return false;
  }

  try {
    return Object.getPrototypeOf(value) === prototype;
  } catch {
    return false;
  }
};

export const readObjectProjectionProperty = (
  value: object,
  key: string | number
): StaticPropertyRead => {
  const propertyKey = String(key);
  const own = readOwnDataProperty(value, propertyKey);
  if (!own.safe || own.found) {
    return own;
  }

  try {
    return Object.getOwnPropertyDescriptor(Object.prototype, propertyKey)
      ? { found: true, safe: false }
      : own;
  } catch {
    return { found: false, safe: false };
  }
};

export const readArrayProjectionElement = (
  value: unknown[],
  index: number
): StaticPropertyRead => {
  const propertyKey = String(index);
  const own = readOwnDataProperty(value, propertyKey);
  if (!own.safe || own.found) {
    return own;
  }

  try {
    if (
      Object.getOwnPropertyDescriptor(Array.prototype, propertyKey) ||
      Object.getOwnPropertyDescriptor(Object.prototype, propertyKey)
    ) {
      return { found: true, safe: false };
    }
    return own;
  } catch {
    return { found: false, safe: false };
  }
};

const defaultArrayIterator = Array.prototype[Symbol.iterator];

export const hasDefaultArrayIterator = (value: unknown[]): boolean => {
  const ownIterator = readOwnDataProperty(value, Symbol.iterator);
  if (!ownIterator.safe) {
    return false;
  }
  if (ownIterator.found) {
    return ownIterator.value === defaultArrayIterator;
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator
    );
    return (
      !!descriptor &&
      'value' in descriptor &&
      descriptor.value === defaultArrayIterator
    );
  } catch {
    return false;
  }
};
