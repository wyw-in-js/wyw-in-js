/* eslint-env jest */
import dedent from 'dedent';

import {
  collectOxcTemplateDependencies,
  evaluateOxcStaticExpression,
  evaluateOxcStaticExpressionAt,
  evaluateOxcStaticOutcome,
  evaluateOxcStaticOutcomeAt,
} from '../collectOxcTemplateDependencies';
import {
  OpaqueReason,
  UnknownReason,
} from '../collectOxcTemplateDependencies/staticOutcome';

const filename = '/source.tsx';

const spanOf = (code: string, expression: string, first = false) => {
  const start = first ? code.indexOf(expression) : code.lastIndexOf(expression);
  return { end: start + expression.length, start };
};

const outcomeAt = (code: string, expression: string, first = false) =>
  evaluateOxcStaticOutcomeAt(code, filename, spanOf(code, expression, first));

describe('static evaluation outcome', () => {
  it.each([
    ['void 0', 'void 0'],
    ['void of an unknown operand', 'void window.innerWidth'],
    ['the global undefined', 'undefined'],
  ])('reports %s as known undefined', (_description, source) => {
    expect(evaluateOxcStaticOutcome(source, filename)).toEqual({
      kind: 'known',
      value: undefined,
    });
  });

  it('reports an object with an undefined property as known', () => {
    const outcome = evaluateOxcStaticOutcome('({ a: undefined })', filename);

    expect(outcome.kind).toBe('known');
    expect(
      outcome.kind === 'known' && Object.keys(outcome.value as object)
    ).toEqual(['a']);
    expect(outcome).toEqual({ kind: 'known', value: { a: undefined } });
  });

  it('reports an array with an undefined element as known', () => {
    expect(evaluateOxcStaticOutcome('[void 0].length', filename)).toEqual({
      kind: 'known',
      value: 1,
    });
  });

  it.each([
    [true, undefined],
    [false, 'red'],
  ])(
    'reports `c ? undefined : x` as known when c is %s',
    (condition, expected) => {
      const code = `const c = ${condition};\nconst x = 'red';\nc ? undefined : x;`;

      expect(outcomeAt(code, 'c ? undefined : x')).toEqual({
        kind: 'known',
        value: expected,
      });
    }
  );

  it.each([
    ["({ a: undefined }).a ?? 'fallback'", 'fallback'],
    ["(true ? undefined : 'x') ?? 'fallback'", 'fallback'],
    ["!undefined ? 'empty' : 'set'", 'empty'],
    ['String(void 0)', 'undefined'],
  ])('uses known undefined in %s', (source, expected) => {
    expect(evaluateOxcStaticOutcome(source, filename)).toEqual({
      kind: 'known',
      value: expected,
    });
  });

  it('passes a known undefined argument to a local function', () => {
    const code = dedent`
      const pick = (value = 'default') => value;
      pick(undefined);
    `;

    expect(outcomeAt(code, 'pick(undefined)')).toEqual({
      kind: 'known',
      value: 'default',
    });
  });

  it('reads a known undefined through a local binding', () => {
    const code = dedent`
      const theme = { accent: undefined };
      theme.accent ?? 'red';
    `;

    expect(outcomeAt(code, "theme.accent ?? 'red'")).toEqual({
      kind: 'known',
      value: 'red',
    });
  });

  it.each([
    ['an arrow function', '() => 1', OpaqueReason.FunctionExpression],
    [
      'a function expression',
      '(function named() {})',
      OpaqueReason.FunctionExpression,
    ],
  ])('reports %s as opaque runtime', (_description, source, reason) => {
    expect(evaluateOxcStaticOutcome(source, filename)).toEqual({
      kind: 'opaque-runtime',
      reason,
    });
  });

  it('reports a declared function value as opaque runtime', () => {
    const code = 'function helper() { return 1; }\nhelper;';

    expect(outcomeAt(code, 'helper')).toEqual({
      kind: 'opaque-runtime',
      reason: OpaqueReason.FunctionValue,
    });
  });

  it('reports a function from the environment as opaque runtime', () => {
    expect(
      evaluateOxcStaticOutcome(
        'helper',
        filename,
        new Map([['helper', () => 1]])
      )
    ).toEqual({ kind: 'opaque-runtime', reason: OpaqueReason.FunctionValue });
  });

  it.each([
    ['object', new Proxy({}, {})],
    ['function', new Proxy(() => 1, {})],
  ])('reports a %s proxy as opaque runtime', (_kind, proxy) => {
    expect(
      evaluateOxcStaticOutcome('value', filename, new Map([['value', proxy]]))
    ).toEqual({ kind: 'opaque-runtime', reason: OpaqueReason.Proxy });
  });

  it('does not report an operation on an opaque operand as opaque', () => {
    expect(evaluateOxcStaticOutcome("(() => 1) ? 'a' : 'b'", filename)).toEqual(
      { kind: 'unknown', reason: UnknownReason.OpaqueOperand }
    );
    expect(evaluateOxcStaticOutcome('({ run: () => 1 })', filename)).toEqual({
      kind: 'unknown',
      reason: UnknownReason.OpaqueOperand,
    });
  });

  it.each([
    [
      'an unresolved global',
      'window.innerWidth;',
      'window.innerWidth',
      UnknownReason.UnresolvedBinding,
    ],
    [
      'an import without a static value',
      "import { color } from './tokens';\ncolor;",
      'color',
      UnknownReason.ImportedBinding,
    ],
    [
      'a lexical read before initialization',
      'value;\nlet value = 1;',
      'value;',
      UnknownReason.TemporalDeadZone,
    ],
    [
      'a mutated primitive binding',
      'let value = 1;\nvalue = 2;\nvalue;',
      'value',
      UnknownReason.Mutation,
    ],
    [
      'a missing own property',
      "const theme = { accent: 'red' };\ntheme.toString;",
      'theme.toString',
      UnknownReason.MissingProperty,
    ],
  ])(
    'reports %s as unknown with a reason',
    (_description, code, expression, reason) => {
      const outcome = outcomeAt(
        code,
        expression.replace(/;$/, ''),
        expression.endsWith(';')
      );

      expect(outcome).toEqual({ kind: 'unknown', reason });
      expect(Object.values(UnknownReason)).toContain(
        outcome.kind === 'unknown' ? outcome.reason : null
      );
    }
  );

  it.each([
    ["process.env.THEME ?? 'light'", 'light'],
    ["process.env['THEME'] || 'light'", 'light'],
    ["process.env.THEME === 'dark'", false],
    ['typeof process.env.THEME', 'undefined'],
  ])('reads a direct process.env read in %s as undefined', (source, value) => {
    expect(evaluateOxcStaticOutcome(source, filename)).toEqual({
      kind: 'known',
      value,
    });
  });

  it.each([
    'process.env.THEME',
    "process.env.THEME ? 'dark' : 'light'",
    "process.env.THEME.mode ?? 'light'",
    "(process.env.THEME) ?? 'light'",
    "String(process.env.THEME) === 'undefined'",
  ])('keeps %s unknown outside the process.env policy', (source) => {
    expect(evaluateOxcStaticOutcome(source, filename)).toEqual({
      kind: 'unknown',
      reason: UnknownReason.BuildTimeEnvironment,
    });
  });

  it('does not extend the process.env policy through a module binding', () => {
    const code = dedent`
      const theme = process.env.THEME;
      theme ?? 'light';
    `;

    expect(outcomeAt(code, "theme ?? 'light'")).toEqual({
      kind: 'unknown',
      reason: UnknownReason.BuildTimeEnvironment,
    });
  });

  it.each([
    ["theme ?? 'light'", 'light'],
    ["theme ? 'dark' : 'light'", null],
  ])(
    'applies the process.env policy to a function-local read in %s',
    (expression, value) => {
      const code = dedent`
        const pick = () => {
          const theme = process.env.THEME;
          return ${expression};
        };
        pick();
      `;

      expect(outcomeAt(code, 'pick()')).toEqual(
        value === null
          ? { kind: 'unknown', reason: UnknownReason.BuildTimeEnvironment }
          : { kind: 'known', value }
      );
    }
  );

  it('keeps the legacy value interface collapsing non-values to undefined', () => {
    expect(evaluateOxcStaticExpression('() => 1', filename)).toBeUndefined();
    expect(
      evaluateOxcStaticExpression('window.innerWidth', filename)
    ).toBeUndefined();
    expect(evaluateOxcStaticExpression('void 0', filename)).toBeUndefined();

    const code = 'function helper() { return 1; }\nhelper;';
    expect(
      typeof evaluateOxcStaticExpressionAt(
        code,
        filename,
        spanOf(code, 'helper')
      )
    ).toBe('function');
  });
});

describe('template path static outcome', () => {
  it('folds a fallback selected by a known undefined property', () => {
    const code = dedent`
      const theme = { accent: undefined };
      const template = tag\`${'${theme.accent ?? "red"}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code).toContain('const _exp = () => ("red");');
    expect(result.staticValues).toEqual([{ name: '_exp', value: 'red' }]);
  });

  it('keeps an undefined interpolation for evaluation', () => {
    const code = dedent`
      const template = tag\`${'${void 0}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code).toContain('void 0');
    expect(result.staticValues).toEqual([]);
  });

  it('keeps process.env conditionals for evaluation', () => {
    const code = dedent`
      const template = tag\`${"${process.env.THEME ? 'dark' : 'light'}"}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code).toContain("process.env.THEME ? 'dark' : 'light'");
    expect(result.staticValues).toEqual([]);
  });
});
