import vm from 'vm';

import * as shared from '../index';

type SerializedError = {
  cause?: SerializedError;
  message: string;
  name?: string;
  stack?: string;
};

type SerializedValue = { kind: string } & Record<string, unknown>;

type LruCacheInstance<K, V> = {
  get: (key: K) => V | undefined;
  has: (key: K) => boolean;
  set: (key: K, value: V) => void;
};

// The codec is read through the namespace so that every case reports its own
// failure when a name is missing instead of failing the whole file on import.
type EvalCodec = {
  LruCache: new <K, V>(maxSize: number) => LruCacheInstance<K, V>;
  decodeGlobals: (
    value: unknown,
    evaluate?: (source: string) => unknown
  ) => unknown;
  deserializeError: (value: SerializedError | undefined) => Error;
  deserializeValue: (value: SerializedValue | null | undefined) => unknown;
  encodeGlobals: (value: unknown) => unknown;
  isBuiltinSpecifier: (specifier: string) => boolean;
  serializeError: (error: unknown) => SerializedError;
  serializePreval: (
    values: Record<string, unknown>
  ) => Record<string, SerializedValue>;
  serializeValue: (value: unknown) => SerializedValue;
};

const codec = shared as unknown as EvalCodec;

// Values cross the eval protocol as JSON lines.
const overTheWire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('shared eval codec', () => {
  it('treats a key that holds undefined as a cache hit', () => {
    const cache = new codec.LruCache<string, number | undefined>(2);

    cache.set('a', undefined);
    cache.set('b', 1);
    cache.get('a');
    cache.set('c', 2);

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('keeps the message, the name and the stack of every error in a cause chain', () => {
    const inner = vm.runInNewContext("new SyntaxError('inner')") as Error;
    const middle = new RangeError('middle', { cause: inner });
    const outer = new TypeError('outer', { cause: middle });

    const restored = codec.deserializeError(
      overTheWire(codec.serializeError(outer))
    );

    expect(restored).toBeInstanceOf(Error);
    expect(restored.message).toBe('outer');
    expect(restored.name).toBe('TypeError');
    expect(restored.stack).toBe(outer.stack);

    const restoredMiddle = restored.cause as Error;
    expect(restoredMiddle.message).toBe('middle');
    expect(restoredMiddle.name).toBe('RangeError');
    expect(restoredMiddle.stack).toBe(middle.stack);

    const restoredInner = restoredMiddle.cause as Error;
    expect(restoredInner.message).toBe('inner');
    expect(restoredInner.name).toBe('SyntaxError');
    expect(restoredInner.stack).toBe(inner.stack);
    expect(restoredInner.cause).toBeUndefined();
  });

  it('stops a cyclic cause chain at the error it has already seen', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    first.cause = second;

    const serialized = overTheWire(codec.serializeError(first));

    expect(serialized.message).toBe('first');
    expect(serialized.cause?.message).toBe('second');
    expect(serialized.cause?.cause).toBeUndefined();
  });

  it('keeps the cause chain of an error value', () => {
    const value = new TypeError('outer', {
      cause: new RangeError('inner'),
    });

    const restored = codec.deserializeValue(
      overTheWire(codec.serializeValue(value))
    ) as Error;

    expect(restored).toBeInstanceOf(Error);
    expect(restored.message).toBe('outer');
    expect(restored.name).toBe('TypeError');
    expect((restored.cause as Error).message).toBe('inner');
    expect((restored.cause as Error).name).toBe('RangeError');
  });

  it('accepts a missing value the way the eval runner does', () => {
    expect(codec.deserializeValue(undefined)).toBeUndefined();
    expect(codec.deserializeValue(null)).toBeUndefined();

    const fromErrorWithoutPayload = codec.deserializeValue({ kind: 'error' });
    expect(fromErrorWithoutPayload).toBeInstanceOf(Error);
    expect((fromErrorWithoutPayload as Error).message).toBe('');

    const fromMissingError = codec.deserializeError(undefined);
    expect(fromMissingError).toBeInstanceOf(Error);
    expect(fromMissingError.message).toBe('');
  });

  it('carries functions and symbols of eval.globals across the protocol', () => {
    const encoded = overTheWire(
      codec.encodeGlobals({
        nested: { token: Symbol('theme') },
        twice: (input: number) => input * 2,
      })
    );

    const decoded = codec.decodeGlobals(encoded) as {
      nested: { token: symbol };
      twice: (input: number) => number;
    };

    expect(decoded.twice(21)).toBe(42);
    expect(typeof decoded.nested.token).toBe('symbol');
    expect(decoded.nested.token.description).toBe('theme');
  });

  it('restores functions of eval.globals with the evaluate it is given', () => {
    const twice = (input: number) => input * 2;
    const restoredByCaller = (input: number) => input * 3;
    const sources: string[] = [];

    const decoded = codec.decodeGlobals(
      overTheWire(codec.encodeGlobals({ twice })),
      (source) => {
        sources.push(source);
        return restoredByCaller;
      }
    ) as { twice: (input: number) => number };

    expect(sources).toEqual([twice.toString()]);
    expect(decoded.twice).toBe(restoredByCaller);
  });

  it('tells builtin modules from packages and relative paths', () => {
    expect(codec.isBuiltinSpecifier('fs')).toBe(true);
    expect(codec.isBuiltinSpecifier('node:path')).toBe(true);
    expect(codec.isBuiltinSpecifier('react')).toBe(false);
    expect(codec.isBuiltinSpecifier('./fs')).toBe(false);
  });

  it('serializes __wywPreval functions as stubs and symbols as registered symbols', () => {
    const serialized = overTheWire(
      codec.serializePreval({
        callback: () => 'value',
        token: Symbol.for('wyw-token'),
      })
    );

    expect(typeof codec.deserializeValue(serialized.callback)).toBe('function');
    expect(codec.deserializeValue(serialized.token)).toBe(
      Symbol.for('wyw-token')
    );
  });
});
