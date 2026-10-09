import vm from 'vm';

import { canonicalizeForHash, isPlainObject } from '../isPlainObject';

describe('isPlainObject', () => {
  it('accepts object literals and null-prototype objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it('accepts plain objects created in another realm', () => {
    const foreign = vm.runInNewContext('({ a: 1 })');

    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    expect(isPlainObject(foreign)).toBe(true);
  });

  it('rejects primitives, arrays, functions and class instances', () => {
    class Box {
      value = 1;
    }

    [
      null,
      undefined,
      0,
      'a',
      true,
      Symbol('s'),
      [],
      vm.runInNewContext('[]'),
      () => {},
      new Box(),
      new Date(0),
      new Map(),
      /re/,
      Object.create({ inherited: true }),
    ].forEach((value) => {
      expect(isPlainObject(value)).toBe(false);
    });
  });
});

describe('canonicalizeForHash', () => {
  it('sorts plain object keys recursively', () => {
    const left = { b: 1, a: { d: [{ y: 1, x: 2 }], c: 3 } };
    const right = { a: { c: 3, d: [{ x: 2, y: 1 }] }, b: 1 };

    expect(JSON.stringify(canonicalizeForHash(left))).toBe(
      JSON.stringify(canonicalizeForHash(right))
    );
    expect(JSON.stringify(canonicalizeForHash(left))).toBe(
      '{"a":{"c":3,"d":[{"x":2,"y":1}]},"b":1}'
    );
  });

  it('keeps array order', () => {
    expect(canonicalizeForHash([3, 1, 2])).toEqual([3, 1, 2]);
  });

  it('canonicalizes null-prototype and foreign-realm plain objects', () => {
    const nullProto = Object.assign(Object.create(null), { b: 1, a: 2 });
    const foreign = vm.runInNewContext('({ b: 1, a: 2 })');

    expect(JSON.stringify(canonicalizeForHash(nullProto))).toBe(
      '{"a":2,"b":1}'
    );
    expect(JSON.stringify(canonicalizeForHash(foreign))).toBe('{"a":2,"b":1}');
  });

  it('leaves primitives and non-plain objects to JSON semantics', () => {
    const date = new Date(0);

    expect(canonicalizeForHash('a')).toBe('a');
    expect(canonicalizeForHash(null)).toBe(null);
    expect(canonicalizeForHash(date)).toBe(date);
    expect(JSON.stringify(canonicalizeForHash({ at: date }))).not.toBe(
      JSON.stringify(canonicalizeForHash({ at: new Date(1) }))
    );
  });
});
