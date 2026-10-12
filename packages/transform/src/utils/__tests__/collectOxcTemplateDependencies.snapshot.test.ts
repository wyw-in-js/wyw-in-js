/* eslint-env jest */
import dedent from 'dedent';
import { runInNewContext } from 'vm';

import {
  collectOxcExpressionDependencies,
  collectOxcTemplateDependencies,
} from '../collectOxcTemplateDependencies';

const filename = '/snapshot.tsx';
const unsafeSnapshotMessage =
  'local snapshot depends on executed side effects that cannot be safely hoisted';

describe('collectOxcTemplateDependencies local snapshot replay', () => {
  it('replays only statements that contribute to the local snapshot', () => {
    const code = dedent`
      import { heavy } from './heavy';

      function Component() {
        globalThis.__unrelatedSideEffect += 1;
        const source = { width: 304 };
        function dormant() {
          heavy();
        }
        const alias = source;
        alias.width = 400;
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);
    const replay = result.code.slice(
      0,
      result.code.indexOf('function Component')
    );

    expect(replay).toContain('const source = { width: 304 }');
    expect(replay).toContain('const alias = source');
    expect(replay).toContain('alias.width = 400');
    expect(replay).not.toContain('__unrelatedSideEffect');
    expect(replay).not.toContain('function dormant');
    expect(replay).not.toContain('heavy()');
    expect(result.code.match(/heavy\(\)/g)).toHaveLength(1);
  });

  it('includes relevant mutations after destructuring', () => {
    const code = dedent`
      function Component() {
        const source = { nested: { value: 1 } };
        const { nested } = source;
        nested.value = 2;
        const template = tag\`${'${nested.value}'}\`;
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);
    const replay = result.code.slice(
      0,
      result.code.indexOf('function Component')
    );

    expect(replay).toContain('const { nested } = source');
    expect(replay).toContain('nested.value = 2');
    expect(result.staticValueCandidates).toEqual([]);
  });

  it('includes a local class that carries the mutated source', () => {
    const code = dedent`
      function Component() {
        const source = { width: 304 };
        class Holder {
          static value = source;
        }
        Holder.value.width = 400;
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);
    const replay = result.code.slice(
      0,
      result.code.indexOf('function Component')
    );

    expect(replay).toContain('class Holder');
    expect(replay).toContain('static value = source');
    expect(replay).toContain('Holder.value.width = 400');
    expect(result.staticValueCandidates).toEqual([]);
  });

  it('replays a stable local used by a destructuring default lazily', () => {
    const code = dedent`
      function Component() {
        let fallback = 304;
        const { width = fallback } = {};
        const template = tag\`${'${width}'}\`;
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);
    const replay = result.code.slice(
      0,
      result.code.indexOf('function Component')
    );

    expect(replay).toContain('let fallback = 304');
    expect(replay).toContain('const { width = fallback } = {}');
    expect(replay).toContain('const _exp = () => (_snapshot().width)');
  });

  it('isolates destructured bindings that collide with root bindings', () => {
    const code = dedent`
      const width = 10;
      function Component() {
        const source = { width: 304 };
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, false);

    const replay = result.code.slice(
      0,
      result.code.indexOf('function Component')
    );

    expect(replay).toContain('const { width } = source');
    expect(replay).toContain('const _exp = () => (_snapshot().width)');
    expect(replay).not.toContain('let { width');
  });

  it('allocates distinct snapshots for destructuring in sibling functions', () => {
    const code = dedent`
      function First() {
        const source = { width: 304 };
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      }
      function Second() {
        const source = { width: 400 };
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, false);

    expect(result.code).toContain('const _exp = () => (_snapshot().width)');
    expect(result.code).toContain('const _exp2 = () => (_snapshot2().width)');
    expect(result.code).not.toContain('let { width');
  });

  it('keeps shorthand defaults and their local references inside the snapshot', () => {
    const code = dedent`
      function Component() {
        let fallback = 304;
        let source = {};
        const { width = fallback } = source;
        const template = tag\`${'${width}'}\`;
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, false);

    const replay = result.code.slice(
      0,
      result.code.indexOf('function Component')
    );

    expect(replay).toContain('const { width = fallback } = source');
    expect(replay).toContain('const _exp = () => (_snapshot().width)');
  });

  it.each([
    [
      'a nullish object pattern',
      dedent`
        function Component() {
          const { value } = null;
          const template = tag\`${'${value}'}\`;
        }
      `,
    ],
    [
      'a non-iterable array pattern',
      dedent`
        function Component() {
          const [value] = {};
          const template = tag\`${'${value}'}\`;
        }
      `,
    ],
    [
      'a sibling-binding TDZ',
      dedent`
        function Component() {
          const { value = typeof later, later = 1 } = {};
          const template = tag\`${'${value}'}\`;
        }
      `,
    ],
  ])('does not execute %s while the function is dormant', (_name, code) => {
    const result = collectOxcTemplateDependencies(code, filename, false);

    expect(() => runInNewContext(result.code)).not.toThrow();
    expect(result.code).toContain('const _exp = () => (_snapshot().value)');
  });

  it.each([
    ['disabled', false],
    ['enabled', true],
  ])(
    'fails closed instead of memoizing a function-local object across invocations when evaluation is %s',
    (_name, evaluate) => {
      const code = dedent`
        function Component() {
          const { x } = { x: { invocation: 0 } };
          tag\`${'${x}'}\`;
          return x;
        }
      `;

      expect(() =>
        collectOxcTemplateDependencies(code, filename, evaluate)
      ).toThrow(unsafeSnapshotMessage);
    }
  );

  it.each(
    [
      ['a literal undefined', '', '{ f: undefined }'],
      [
        'a constant holding undefined',
        'const none = undefined;',
        '{ f: none }',
      ],
      [
        'a conditional that may be undefined',
        'let flag = true;',
        '{ f: flag ? undefined : 1 }',
      ],
      ['a missing member', 'const empty = {};', '{ f: empty.missing }'],
    ].flatMap(([source, setup, value]) =>
      [
        ['disabled', false],
        ['enabled', true],
      ].map(([mode, evaluate]) => [source, mode, setup, value, evaluate])
    )
  )(
    'fails closed when a destructuring default object replaces %s when evaluation is %s',
    (_source, _mode, setup, value, evaluate) => {
      const code = dedent`
        function Component() {
          ${setup}
          const { f = () => {} } = ${value};
          tag\`${'${f}'}\`;
        }
      `;

      expect(() =>
        collectOxcTemplateDependencies(code, filename, evaluate as boolean)
      ).toThrow(unsafeSnapshotMessage);
    }
  );

  it.each([
    ['disabled', false],
    ['enabled', true],
  ])(
    'fails closed when an array destructuring default object replaces a constant holding undefined when evaluation is %s',
    (_name, evaluate) => {
      const code = dedent`
        function Component() {
          const none = undefined;
          const [f = () => {}] = [none];
          tag\`${'${f}'}\`;
        }
      `;

      expect(() =>
        collectOxcTemplateDependencies(code, filename, evaluate)
      ).toThrow(unsafeSnapshotMessage);
    }
  );

  it.each([
    ['disabled', false],
    ['enabled', true],
  ])(
    'accepts a primitive that a destructuring default never replaces when evaluation is %s',
    (_name, evaluate) => {
      const code = dedent`
        function Component() {
          const one = 1;
          const { f = () => {} } = { f: one };
          tag\`${'${f}'}\`;
        }
      `;

      expect(() =>
        collectOxcTemplateDependencies(code, filename, evaluate)
      ).not.toThrow();
    }
  );

  it.each([
    ['disabled', false],
    ['enabled', true],
  ])(
    'fails closed instead of letting a processor mutate a replay object while the invocation-local binding stays unchanged when evaluation is %s',
    (_name, evaluate) => {
      const code = dedent`
        function Component() {
          const { x } = { x: { value: 1 } };
          tag\`${'${x}'}\`;
          return x.value;
        }
      `;

      expect(() =>
        collectOxcTemplateDependencies(code, filename, evaluate)
      ).toThrow(unsafeSnapshotMessage);
    }
  );

  it.each([
    ['disabled', false],
    ['enabled', true],
  ])(
    'fails closed instead of redirecting an invocation-local assignment into shared snapshot storage when evaluation is %s',
    (_name, evaluate) => {
      const code = dedent`
        function Component() {
          let { width } = { width: 1 };
          tag\`${'${width}:${(width = 2)}:${width}'}\`;
          return width;
        }
      `;

      expect(() =>
        collectOxcTemplateDependencies(code, filename, evaluate)
      ).toThrow(unsafeSnapshotMessage);
    }
  );

  it.each(
    [
      ['simple assignment', 'width = 2'],
      ['compound assignment', 'width += 1'],
      ['logical assignment', 'width ||= 2'],
      ['postfix update', 'width++'],
      ['prefix update', '++width'],
      ['object destructuring assignment', '({ width } = { width: 2 })'],
      ['array destructuring assignment', '[width] = [2]'],
    ].flatMap(([operation, expression]) =>
      [
        ['disabled', false],
        ['enabled', true],
      ].map(([mode, evaluate]) => [operation, mode, expression, evaluate])
    )
  )(
    'fails closed for a snapshot-local %s when evaluation is %s',
    (_operation, _mode, expression, evaluate) => {
      const code = dedent`
        function Component() {
          let { width } = { width: 1 };
          tag\`${'${'}${expression}}\`;
        }
      `;

      expect(() =>
        collectOxcTemplateDependencies(code, filename, evaluate)
      ).toThrow(unsafeSnapshotMessage);
    }
  );

  it.each(
    [
      ['returned callback', '() => (width = 2)'],
      [
        'callback returned by a synchronous IIFE',
        '(() => () => (width = 2))()',
      ],
      ['async IIFE', '(async () => (width = 2))()'],
      ['generator IIFE', '(function* () { width = 2; })()'],
      [
        'callback containing a for-of assignment',
        '() => { for (width of [2]) {} }',
      ],
      [
        'callback containing a for-in assignment',
        '() => { for (width in { two: 1 }) {} }',
      ],
    ].flatMap(([operation, expression]) =>
      [
        ['disabled', false],
        ['enabled', true],
      ].map(([mode, evaluate]) => [operation, mode, expression, evaluate])
    )
  )(
    'keeps a snapshot-local write in a deferred %s on the strict path when evaluation is %s',
    (_operation, _mode, expression, evaluate) => {
      const code = dedent`
        function Component() {
          let { width } = { width: 1 };
          tag\`${'${'}${expression}}\`;
          return width;
        }
      `;

      expect(() =>
        collectOxcTemplateDependencies(code, filename, evaluate)
      ).toThrow(unsafeSnapshotMessage);
    }
  );

  it('retains a top-level destructured object alias in the executable helper while carrying static metadata', () => {
    const code = dedent`
      const source = { x: { value: 1 } };
      const { x } = source;
      tag\`${'${x}'}\`;
      globalThis.__observed = source.x.value;
    `;
    const result = collectOxcTemplateDependencies(code, filename, true);
    const sandbox: Record<string, unknown> = {
      tag: (_strings: TemplateStringsArray, value: { value: number }) => {
        const mutableValue = value;
        mutableValue.value = 2;
      },
    };

    runInNewContext(result.code, sandbox);

    expect(sandbox.__observed).toBe(2);
    expect(result.code).toContain('const _exp = () => (x)');
    expect(result.staticValues).toEqual([
      { name: '_exp', value: { value: 1 } },
    ]);
  });

  it('retains shallow object-rest aliases in the executable helper while carrying static metadata', () => {
    const code = dedent`
      const source = { nested: { v: 1 } };
      const { ...rest } = source;
      tag\`${'${rest}'}\`;
      globalThis.__observed = source.nested.v;
    `;
    const result = collectOxcTemplateDependencies(code, filename, true);
    const sandbox: Record<string, unknown> = {
      tag: (
        _strings: TemplateStringsArray,
        value: { nested: { v: number } }
      ) => {
        const mutableValue = value;
        mutableValue.nested.v = 2;
      },
    };

    runInNewContext(result.code, sandbox);

    expect(sandbox.__observed).toBe(2);
    expect(result.code).toContain('const _exp = () => (rest)');
    expect(result.staticValues).toEqual([
      { name: '_exp', value: { nested: { v: 1 } } },
    ]);
  });

  it.each([
    [
      'the binding',
      'width',
      dedent`
        function Component() {
          let { width } = { width: 1 };
          tag\`${'${width}'}\`;
          width = 2;
          tag\`${'${width}'}\`;
        }
      `,
    ],
    [
      'a nested projected value',
      'nested.width',
      dedent`
        function Component() {
          let { nested } = { nested: { width: 1 } };
          tag\`${'${nested.width}'}\`;
          nested.width = 2;
          tag\`${'${nested.width}'}\`;
        }
      `,
    ],
  ])(
    'uses a position-specific snapshot after mutating %s',
    (_name, expression, code) => {
      const target = `tag\`\${${expression}}\``;
      let offset = 0;
      const targetStarts = code
        .split(target)
        .slice(0, -1)
        .map((part) => {
          offset += part.length;
          const start = offset;
          offset += target.length;
          return start;
        });
      const expressionOffset = 'tag`${'.length;
      const result = collectOxcExpressionDependencies(
        code,
        filename,
        false,
        targetStarts.map((start) => ({
          end: start + expressionOffset + expression.length,
          start: start + expressionOffset,
        })),
        undefined,
        targetStarts.map((start) => ({
          end: start + target.length,
          start,
        }))
      );
      const values: unknown[] = [];

      runInNewContext(`${result.code}\nComponent();`, {
        tag: (_strings: TemplateStringsArray, value: unknown) => {
          values.push(value);
        },
      });

      expect(values).toEqual([1, 2]);
      expect(result.code).toContain('const _snapshot2 = (() => {');
    }
  );

  it.each([
    [
      'a mutated default',
      dedent`
        function Component() {
          let fallback = 304;
          fallback = 400;
          const { width = fallback } = {};
          const template = tag\`${'${width}'}\`;
        }
      `,
      'fallback = 400',
    ],
    [
      'a mutated computed key',
      dedent`
        function Component() {
          let key = 'a';
          key = 'b';
          const { [key]: width } = { a: 304, b: 400 };
          const template = tag\`${'${width}'}\`;
        }
      `,
      "key = 'b'",
    ],
  ])('replays %s at the declaration snapshot', (_name, code, mutation) => {
    const result = collectOxcTemplateDependencies(code, filename, true);
    const replay = result.code.slice(
      0,
      result.code.indexOf('function Component')
    );

    expect(replay).toContain(mutation);
    expect(result.staticValueCandidates).toEqual([]);
  });

  it.each([
    [
      'a parameter default',
      dedent`
        function Component(fallback) {
          const { width = fallback } = {};
          const template = tag\`${'${width}'}\`;
        }
      `,
    ],
    [
      'a parameter computed key',
      dedent`
        function Component(key) {
          const { [key]: width } = { a: 304 };
          const template = tag\`${'${width}'}\`;
        }
      `,
    ],
    [
      'a this-dependent computed key',
      dedent`
        function Component() {
          const { [this.key]: width } = { a: 304 };
          const template = tag\`${'${width}'}\`;
        }
      `,
    ],
    [
      'a new.target-dependent computed key',
      dedent`
        function Component() {
          const { [new.target?.key]: width } = { a: 304 };
          const template = tag\`${'${width}'}\`;
        }
      `,
    ],
  ])('fails closed for %s', (_name, code) => {
    expect(() => collectOxcTemplateDependencies(code, filename, true)).toThrow(
      unsafeSnapshotMessage
    );
  });

  it('replays a reaching assignment pattern instead of a bare declaration', () => {
    const code = dedent`
      function Component() {
        let width;
        ({ width = 304 } = {});
        const template = tag\`${'${width}'}\`;
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);
    const replay = result.code.slice(
      0,
      result.code.indexOf('function Component')
    );

    expect(replay).toContain('let width');
    expect(replay).toContain('({ width = 304 } = {})');
    expect(result.staticValueCandidates).toEqual([]);
  });

  it('preserves duplicate target writes in source order while replaying an assignment pattern', () => {
    const code = dedent`
      function Component() {
        let width;
        ({ first: width, second: width } = { first: 304, second: 400 });
        const template = tag\`${'${width}'}\`;
      }
    `;
    const result = collectOxcTemplateDependencies(code, filename, true);
    const replay = result.code.slice(
      0,
      result.code.indexOf('function Component')
    );
    const values: unknown[] = [];

    runInNewContext(`${result.code}\nComponent();`, {
      tag: (_strings: TemplateStringsArray, value: unknown) => {
        values.push(value);
      },
    });

    expect(values).toEqual([400]);
    expect(replay).toContain(
      '({ first: width, second: width } = { first: 304, second: 400 })'
    );
  });

  it.todo(
    'preserves nested computed-key and default evaluation order in snapshot replay',
    () => {
      const code = dedent`
      function Component() {
        let order = 0;
        const {
          [(order = order * 10 + 1, 'outer')]: {
            [(order = order * 10 + 3, 'inner')]: width =
              (order = order * 10 + 4, order)
          } = (order = order * 10 + 2, {})
        } = {};
        const template = tag\`${'${width}'}\`;
      }
    `;
      const result = collectOxcTemplateDependencies(code, filename, true);
      const values: unknown[] = [];

      runInNewContext(`${result.code}\nComponent();`, {
        tag: (_strings: TemplateStringsArray, value: unknown) => {
          values.push(value);
        },
      });

      expect(values).toEqual([1234]);
    }
  );

  it('fails closed when replay would observe mutable outer state too early', () => {
    const code = dedent`
      let seed = 304;
      function Component() {
        const source = { width: seed };
        const alias = source;
        alias.width += 1;
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      }
      seed = 399;
    `;

    expect(() => collectOxcTemplateDependencies(code, filename, true)).toThrow(
      unsafeSnapshotMessage
    );
  });

  it('fails closed for function-context syntax such as new.target', () => {
    const code = dedent`
      function Component() {
        const source = { width: new.target ? 400 : 304 };
        source.width += 0;
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      }
    `;

    expect(() => collectOxcTemplateDependencies(code, filename, true)).toThrow(
      unsafeSnapshotMessage
    );
  });

  it('fails closed when omitted later declarations affect TDZ resolution', () => {
    const code = dedent`
      const later = 100;
      function Component() {
        const source = { width: 1 };
        function read() {
          return later;
        }
        source.width = read();
        const { width } = source;
        const template = tag\`${'${width}'}\`;
        const later = 304;
      }
    `;

    expect(() => collectOxcTemplateDependencies(code, filename, true)).toThrow(
      unsafeSnapshotMessage
    );
  });

  it('fails closed when an outer source can change before the function runs', () => {
    const code = dedent`
      const source = { width: 304 };
      function Component() {
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      }
      source.width = 400;
      Component();
    `;

    expect(() => collectOxcTemplateDependencies(code, filename, true)).toThrow(
      unsafeSnapshotMessage
    );
  });

  it.each(['undefined', 'NaN', 'Infinity'])(
    'does not treat a shadowed %s binding as an immutable intrinsic',
    (name) => {
      const code = dedent`
        let ${name} = 304;
        function Component() {
          const source = { width: ${name} };
          source.width += 0;
          const { width } = source;
          const template = tag\`${'${width}'}\`;
        }
        ${name} = 400;
        Component();
      `;

      expect(() =>
        collectOxcTemplateDependencies(code, filename, true)
      ).toThrow(unsafeSnapshotMessage);
    }
  );

  it.each([
    [
      'Object.prototype',
      dedent`
        function Component() {
          const { width = 304 } = {};
          const template = tag\`${'${width}'}\`;
        }
        Object.prototype.width = 400;
        Component();
      `,
    ],
    [
      'Array.prototype iteration',
      dedent`
        function Component() {
          const [width] = [304];
          const template = tag\`${'${width}'}\`;
        }
        Array.prototype[Symbol.iterator] = function* iterator() {
          yield 400;
        };
        Component();
      `,
    ],
  ])('fails closed when later code changes %s semantics', (_name, code) => {
    expect(() => collectOxcTemplateDependencies(code, filename, true)).toThrow(
      unsafeSnapshotMessage
    );
  });

  it('fails closed when a function runs before an outer lexical declaration', () => {
    const code = dedent`
      function Component() {
        const source = { width: later };
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      }
      Component();
      const later = 400;
    `;

    expect(() => collectOxcTemplateDependencies(code, filename, true)).toThrow(
      unsafeSnapshotMessage
    );
  });

  it.each([
    [
      'an array for-of binding',
      dedent`
        for (const [value] of [[1]]) {
          const template = tag\`${'${value}'}\`;
        }
      `,
    ],
    [
      'an object for-of binding',
      dedent`
        for (const { value } of [{ value: 1 }]) {
          const template = tag\`${'${value}'}\`;
        }
      `,
    ],
    [
      'a catch binding',
      dedent`
        try {
          throw { value: 1 };
        } catch ({ value }) {
          const template = tag\`${'${value}'}\`;
        }
      `,
    ],
  ])('fails closed for %s', (_name, code) => {
    expect(() =>
      collectOxcTemplateDependencies(code, filename, true)
    ).toThrow();
  });
});
