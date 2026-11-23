/* eslint-env jest */

import { deserializeValue, serializePreval } from '@wyw-in-js/shared';

import { createPrevalPayload } from '../prevalPayload';

const filename = '/project/src/entry.tsx';

describe('createPrevalPayload', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('creates a static-only payload when eval is skipped', () => {
    const payload = createPrevalPayload({
      filename,
      strategy: 'static',
      staticDependencies: ['/project/src/tokens.ts'],
      staticValues: new Map([['_exp', 'red']]),
    });

    expect(payload.dependencies).toEqual(['/project/src/tokens.ts']);
    expect(payload.values).toEqual(new Map([['_exp', 'red']]));
    expect(payload.sources).toEqual(new Map([['_exp', 'static']]));
  });

  it.each(['test', 'staging', 'production'])(
    'uses evaluated values and dependencies exclusively for execute with NODE_ENV=%s',
    (nodeEnv) => {
      process.env.NODE_ENV = nodeEnv;
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const payload = createPrevalPayload({
        evalDependencies: ['/project/src/eval-only.ts'],
        evalValues: new Map([['_exp', 'eval-red']]),
        filename,
        staticDependencies: ['/project/src/static-only.ts'],
        staticValues: new Map([
          ['_exp', 'static-red'],
          ['_exp2', 'static-blue'],
        ]),
        strategy: 'execute',
      });

      expect(warn).not.toHaveBeenCalled();
      expect(payload.dependencies).toEqual(['/project/src/eval-only.ts']);
      expect(payload.values).toEqual(new Map([['_exp', 'eval-red']]));
      expect(payload.sources).toEqual(new Map([['_exp', 'eval']]));
    }
  );

  it('uses static values and dependencies exclusively for static', () => {
    const payload = createPrevalPayload({
      evalDependencies: ['/project/src/eval-only.ts'],
      evalValues: new Map([
        ['_exp', 'eval-red'],
        ['_exp2', 'eval-blue'],
      ]),
      filename,
      staticDependencies: ['/project/src/static-only.ts'],
      staticValues: new Map([['_exp2', 'static-blue']]),
      strategy: 'static',
    });

    expect(payload.dependencies).toEqual(['/project/src/static-only.ts']);
    expect(payload.values).toEqual(new Map([['_exp2', 'static-blue']]));
    expect(payload.sources).toEqual(new Map([['_exp2', 'static']]));
  });

  it('combines hybrid values and records static precedence on overlap', () => {
    const payload = createPrevalPayload({
      evalDependencies: ['/project/src/eval-only.ts'],
      evalValues: new Map([
        ['_exp', 'eval-red'],
        ['_exp2', 'eval-blue'],
      ]),
      filename,
      staticDependencies: [
        '/project/src/static-only.ts',
        '/project/src/eval-only.ts',
      ],
      staticValues: new Map([['_exp2', 'eval-blue']]),
      strategy: 'hybrid',
    });

    expect(payload.dependencies).toEqual([
      '/project/src/eval-only.ts',
      '/project/src/static-only.ts',
    ]);
    expect(payload.values).toEqual(
      new Map([
        ['_exp', 'eval-red'],
        ['_exp2', 'eval-blue'],
      ])
    );
    expect(payload.sources).toEqual(
      new Map([
        ['_exp', 'eval'],
        ['_exp2', 'static'],
      ])
    );
  });

  it('throws on hybrid disagreement outside production', () => {
    process.env.NODE_ENV = 'test';

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([['_exp', 'eval-red']]),
        filename,
        staticValues: new Map([['_exp', 'static-red']]),
        strategy: 'hybrid',
      })
    ).toThrow('[wyw-in-js] PrevalPayload disagreement');
  });

  it('treats values that throw during comparison as disagreements', () => {
    process.env.NODE_ENV = 'test';
    const evaluated = {};
    Object.defineProperty(evaluated, 'unavailable', {
      enumerable: true,
      get() {
        throw new Error('unavailable eval field');
      },
    });

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([['_exp', evaluated]]),
        filename,
        staticValues: new Map([['_exp', { unavailable: 'static' }]]),
        strategy: 'hybrid',
      })
    ).toThrow('[wyw-in-js] PrevalPayload disagreement');
  });

  it('treats accessor-based metadata as a disagreement', () => {
    process.env.NODE_ENV = 'test';
    const evaluated = {};
    Object.defineProperty(evaluated, '__wyw_meta', {
      enumerable: true,
      get() {
        throw new Error('unavailable eval metadata');
      },
    });

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([['_exp', evaluated]]),
        filename,
        staticValues: new Map([
          ['_exp', { __wyw_meta: { className: 'a_1', extends: null } }],
        ]),
        strategy: 'hybrid',
      })
    ).toThrow('[wyw-in-js] PrevalPayload disagreement');
  });

  it('treats an unavailable nested extends value as a disagreement', () => {
    process.env.NODE_ENV = 'test';
    const meta = { className: 'a_1' };
    Object.defineProperty(meta, 'extends', {
      enumerable: true,
      get() {
        throw new Error('unavailable extends value');
      },
    });

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([['_exp', { __wyw_meta: meta }]]),
        filename,
        staticValues: new Map([
          ['_exp', { __wyw_meta: { className: 'a_1', extends: null } }],
        ]),
        strategy: 'hybrid',
      })
    ).toThrow('[wyw-in-js] PrevalPayload disagreement');
  });

  it('warns and keeps static precedence on hybrid disagreement in production', () => {
    process.env.NODE_ENV = 'production';
    const warnings: string[] = [];
    const payload = createPrevalPayload({
      emitWarning: (message) => warnings.push(message),
      evalValues: new Map([['_exp', 'eval-red']]),
      filename,
      staticValues: new Map([['_exp', 'static-red']]),
      strategy: 'hybrid',
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('PrevalPayload disagreement');
    expect(payload.values).toEqual(new Map([['_exp', 'static-red']]));
    expect(payload.sources).toEqual(new Map([['_exp', 'static']]));
  });

  it('warns once and keeps static precedence when a value cannot be formatted', () => {
    process.env.NODE_ENV = 'production';
    const warnings: string[] = [];
    const evaluated = {};
    Object.defineProperties(evaluated, {
      unavailable: {
        enumerable: true,
        get() {
          throw new Error('unavailable eval field');
        },
      },
      toString: {
        get() {
          throw new Error('cannot format eval value');
        },
      },
    });
    const staticValue = { unavailable: 'static' };

    const payload = createPrevalPayload({
      emitWarning: (message) => warnings.push(message),
      evalValues: new Map([['_exp', evaluated]]),
      filename,
      staticValues: new Map([['_exp', staticValue]]),
      strategy: 'hybrid',
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('eval: <unprintable>');
    expect(payload.values.get('_exp')).toBe(staticValue);
    expect(payload.sources.get('_exp')).toBe('static');
  });

  it('warns and keeps static precedence when metadata access is unsafe', () => {
    process.env.NODE_ENV = 'production';
    const warnings: string[] = [];
    const evaluated = {};
    Object.defineProperty(evaluated, '__wyw_meta', {
      enumerable: true,
      get() {
        throw new Error('unavailable eval metadata');
      },
    });
    const staticValue = {
      __wyw_meta: { className: 'a_1', extends: null },
    };

    const payload = createPrevalPayload({
      emitWarning: (message) => warnings.push(message),
      evalValues: new Map([['_exp', evaluated]]),
      filename,
      staticValues: new Map([['_exp', staticValue]]),
      strategy: 'hybrid',
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('PrevalPayload disagreement');
    expect(payload.values.get('_exp')).toBe(staticValue);
    expect(payload.sources.get('_exp')).toBe('static');
  });

  it('treats an evaluated component stub and a static opaque null as agreement', () => {
    process.env.NODE_ENV = 'test';
    const warnings: string[] = [];
    const stub = () => {};

    const payload = createPrevalPayload({
      emitWarning: (message) => warnings.push(message),
      evalValues: new Map([['_exp', stub]]),
      filename,
      staticNullWYWMetaExtendsHelpers: ['_exp'],
      staticValues: new Map([['_exp', null]]),
      strategy: 'hybrid',
    });

    expect(warnings).toHaveLength(0);
    expect(payload.values).toEqual(new Map([['_exp', null]]));
    expect(payload.sources).toEqual(new Map([['_exp', 'static']]));
  });

  it('still reports an unproven function after eval IPC against a static null', () => {
    process.env.NODE_ENV = 'test';
    const styledLike = Object.assign(() => {}, {
      __wyw_meta: { className: 'x', extends: null },
    });
    const evaluated = deserializeValue(
      serializePreval({ styledLike }).styledLike
    );

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([['_exp', evaluated]]),
        filename,
        staticValues: new Map([['_exp', null]]),
        strategy: 'hybrid',
      })
    ).toThrow('[wyw-in-js] PrevalPayload disagreement');
  });

  it('treats equal __wyw_meta chains with differently spelled opaque ends as agreement', () => {
    process.env.NODE_ENV = 'test';
    const warnings: string[] = [];
    const evaluated = {
      displayName: 'StyledLink',
      __wyw_meta: { className: 'StyledLink_s1', extends: () => {} },
    };
    const resolved = {
      __wyw_meta: { className: 'StyledLink_s1', extends: null },
    };

    const payload = createPrevalPayload({
      emitWarning: (message) => warnings.push(message),
      evalValues: new Map([['_exp7', evaluated]]),
      filename,
      staticValues: new Map([['_exp7', resolved]]),
      strategy: 'hybrid',
    });

    expect(warnings).toHaveLength(0);
    expect(payload.values.get('_exp7')).toBe(resolved);
    expect(payload.sources.get('_exp7')).toBe('static');
  });

  it('does not treat an explicit null displayName as an omitted displayName', () => {
    process.env.NODE_ENV = 'test';

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([
          [
            '_exp',
            {
              displayName: 'StyledLink',
              __wyw_meta: { className: 'StyledLink_s1', extends: () => {} },
            },
          ],
        ]),
        filename,
        staticValues: new Map([
          [
            '_exp',
            {
              displayName: null,
              __wyw_meta: { className: 'StyledLink_s1', extends: null },
            },
          ],
        ]),
        strategy: 'hybrid',
      })
    ).toThrow('[wyw-in-js] PrevalPayload disagreement');
  });

  it('treats nested equal __wyw_meta chains as agreement', () => {
    process.env.NODE_ENV = 'test';
    const evaluated = {
      displayName: 'Outer',
      __wyw_meta: {
        className: 'Outer_o1',
        extends: {
          displayName: 'Inner',
          __wyw_meta: { className: 'Inner_i1', extends: () => {} },
        },
      },
    };
    const resolved = {
      __wyw_meta: {
        className: 'Outer_o1',
        extends: { __wyw_meta: { className: 'Inner_i1', extends: null } },
      },
    };

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([['_exp', evaluated]]),
        filename,
        staticValues: new Map([['_exp', resolved]]),
        strategy: 'hybrid',
      })
    ).not.toThrow();
  });

  it('treats matching metadata chains deeper than 32 nodes as agreement', () => {
    process.env.NODE_ENV = 'test';
    const buildChain = (end: unknown, withDisplayNames: boolean) => {
      let value = end;
      for (let index = 0; index < 64; index += 1) {
        value = {
          ...(withDisplayNames ? { displayName: `Styled${index}` } : {}),
          __wyw_meta: { className: `class_${index}`, extends: value },
        };
      }
      return value;
    };

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([['_exp', buildChain(() => {}, true)]]),
        filename,
        staticValues: new Map([['_exp', buildChain(null, false)]]),
        strategy: 'hybrid',
      })
    ).not.toThrow();
  });

  it('still reports metadata values with differing extra fields', () => {
    process.env.NODE_ENV = 'test';

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([
          [
            '_exp',
            {
              variant: 'red',
              __wyw_meta: { className: 'a_1', extends: () => {} },
            },
          ],
        ]),
        filename,
        staticValues: new Map([
          [
            '_exp',
            {
              variant: 'blue',
              __wyw_meta: { className: 'a_1', extends: null },
            },
          ],
        ]),
        strategy: 'hybrid',
      })
    ).toThrow('[wyw-in-js] PrevalPayload disagreement');
  });

  it('still reports inherited metadata values', () => {
    process.env.NODE_ENV = 'test';
    const evaluated = Object.create({
      __wyw_meta: { className: 'a_1', extends: () => {} },
    });

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([['_exp', evaluated]]),
        filename,
        staticValues: new Map([
          ['_exp', { __wyw_meta: { className: 'a_1', extends: null } }],
        ]),
        strategy: 'hybrid',
      })
    ).toThrow('[wyw-in-js] PrevalPayload disagreement');
  });

  it('still reports a function carrying metadata inside a chain', () => {
    process.env.NODE_ENV = 'test';
    const styledLike = Object.assign(() => {}, {
      __wyw_meta: { className: 'inner_1', extends: null },
    });

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([
          [
            '_exp',
            {
              __wyw_meta: { className: 'outer_1', extends: styledLike },
            },
          ],
        ]),
        filename,
        staticValues: new Map([
          [
            '_exp',
            {
              __wyw_meta: {
                className: 'outer_1',
                extends: {
                  __wyw_meta: { className: 'inner_1', extends: null },
                },
              },
            },
          ],
        ]),
        strategy: 'hybrid',
      })
    ).toThrow('[wyw-in-js] PrevalPayload disagreement');
  });

  it('still reports __wyw_meta chains whose class names differ', () => {
    process.env.NODE_ENV = 'test';

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([
          ['_exp', { __wyw_meta: { className: 'a_1', extends: () => {} } }],
        ]),
        filename,
        staticValues: new Map([
          ['_exp', { __wyw_meta: { className: 'a_2', extends: null } }],
        ]),
        strategy: 'hybrid',
      })
    ).toThrow('[wyw-in-js] PrevalPayload disagreement');
  });

  it('still reports __wyw_meta chains of different length', () => {
    process.env.NODE_ENV = 'test';

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([
          [
            '_exp',
            {
              __wyw_meta: {
                className: 'a_1',
                extends: { __wyw_meta: { className: 'b_1', extends: null } },
              },
            },
          ],
        ]),
        filename,
        staticValues: new Map([
          ['_exp', { __wyw_meta: { className: 'a_1', extends: null } }],
        ]),
        strategy: 'hybrid',
      })
    ).toThrow('[wyw-in-js] PrevalPayload disagreement');
  });

  it('still reports an evaluated function carrying __wyw_meta against a static null', () => {
    process.env.NODE_ENV = 'test';
    const styledLike = Object.assign(() => {}, {
      __wyw_meta: { className: 'x', extends: null },
    });

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([['_exp', styledLike]]),
        filename,
        staticValues: new Map([['_exp', null]]),
        strategy: 'hybrid',
      })
    ).toThrow('[wyw-in-js] PrevalPayload disagreement');
  });

  it('still reports an evaluated object against a static null', () => {
    process.env.NODE_ENV = 'test';
    const lazyLike = { $$typeof: Symbol.for('react.lazy') };

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([['_exp', lazyLike]]),
        filename,
        staticValues: new Map([['_exp', null]]),
        strategy: 'hybrid',
      })
    ).toThrow('[wyw-in-js] PrevalPayload disagreement');
  });

  it('deduplicates selected dependencies in hybrid mode', () => {
    const payload = createPrevalPayload({
      evalDependencies: ['/project/src/shared.ts'],
      filename,
      staticDependencies: ['/project/src/shared.ts'],
      strategy: 'hybrid',
    });

    expect(payload.dependencies).toEqual(['/project/src/shared.ts']);
  });
});
