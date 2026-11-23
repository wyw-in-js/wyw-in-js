import { decodeGlobals, encodeGlobals } from '@wyw-in-js/shared';

describe('eval.globals serialization', () => {
  it('does not treat user data marker-like keys as encoded payload', () => {
    const input = {
      __wyw_function: 'user-value',
      __wyw_symbol: 'user-symbol',
      nested: {
        __wyw_function: { source: 'not-a-function' },
      },
    };

    const encoded = encodeGlobals(input);
    const decoded = decodeGlobals(encoded);

    expect(decoded).toEqual(input);
  });

  it('fails with actionable message for native functions', () => {
    expect(() =>
      encodeGlobals({
        fn: Math.max,
      })
    ).toThrow(
      '[wyw-in-js] eval.globals contains an unsupported function at eval.globals.fn.'
    );
    expect(() =>
      encodeGlobals({
        fn: Math.max,
      })
    ).toThrow('Native and bound functions are not supported');
  });

  it('fails with actionable message for bound functions', () => {
    const source = function source() {
      return 1;
    };
    const bound = Function.prototype.bind.call(source, null) as () => number;

    expect(() =>
      encodeGlobals({
        fn: bound,
      })
    ).toThrow(
      '[wyw-in-js] eval.globals contains an unsupported function at eval.globals.fn.'
    );
    expect(() =>
      encodeGlobals({
        fn: bound,
      })
    ).toThrow('Native and bound functions are not supported');
  });

  it('reports path when encoded function source is corrupted', () => {
    const corrupted = {
      nested: {
        fn: {
          __wyw_eval_global: {
            signature: 'wyw-eval-global',
            version: 1,
            kind: 'function',
            source: 'function () {',
          },
        },
      },
    };

    expect(() => decodeGlobals(corrupted)).toThrow(
      '[wyw-in-js] Failed to restore eval.globals function at eval.globals.nested.fn.'
    );
  });

  it('fails with actionable message for Date values', () => {
    expect(() =>
      encodeGlobals({
        releasedAt: new Date(0),
      })
    ).toThrow(
      '[wyw-in-js] eval.globals contains an unsupported non-plain object at eval.globals.releasedAt (Date).'
    );
  });

  it('fails with actionable message for Map values', () => {
    expect(() =>
      encodeGlobals({
        nested: {
          mapping: new Map([['a', 1]]),
        },
      })
    ).toThrow(
      '[wyw-in-js] eval.globals contains an unsupported non-plain object at eval.globals.nested.mapping (Map).'
    );
  });
});
