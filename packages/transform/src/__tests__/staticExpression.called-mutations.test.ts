import { parseSync } from 'oxc-parser';

import { findExportTarget } from '../transform/generators/resolveStaticOxcValues/exportTargets';
import { collectStaticExpressionDependencies } from '../transform/generators/resolveStaticOxcValues/staticExpressionDependencies';
import { evaluateOxcStaticExpressionAt } from '../utils/collectOxcTemplateDependencies';

// Each case declares module-level bindings, may change them from code that a
// top-level statement runs, and reads the result as `V`. `value` is what plain
// JavaScript gives for `V` after the module runs.
const changedCases: [name: string, source: string, value: unknown][] = [
  [
    'a called function declaration',
    'let n = 0; function init() { n += 5; } init();',
    5,
  ],
  [
    'an update in a called function',
    'let n = 0; function bump() { n++; } bump();',
    1,
  ],
  [
    'a plain assignment in a called function',
    'let n = 0; function init() { n = 5; } init();',
    5,
  ],
  [
    'a called arrow function',
    'let n = 0; const init = () => { n += 1; }; init();',
    1,
  ],
  [
    'a called function expression',
    'let n = 0; const init = function () { n -= 1; }; init();',
    -1,
  ],
  [
    'a class constructor',
    'let n = 0; class C { constructor() { n += 1; } } new C();',
    1,
  ],
  [
    'a class field initializer',
    'let n = 0; class C { f = (n += 1); } new C();',
    1,
  ],
  [
    'a method called on a local object',
    'let n = 0; const o = { init() { n += 1; } }; o.init();',
    1,
  ],
  [
    'a function called by another function',
    'let n = 0; function a() { n += 1; } function b() { a(); } b();',
    1,
  ],
  [
    'a callback passed to a call',
    'let n = 0; [1].forEach(() => { n += 1; });',
    1,
  ],
];

const changedObjectCases: [name: string, source: string, value: unknown][] = [
  [
    'a property write in a called function',
    'const o = { x: 1 }; function init() { o.x = 5; } init();',
    5,
  ],
  [
    'a property write in a callback',
    'const o = { x: 1 }; [1].forEach(() => { o.x = 5; });',
    5,
  ],
  [
    'a mutating method in a called function',
    'const o = { x: [1] }; function init() { o.x.push(2); } init();',
    [1, 2],
  ],
  [
    'an object passed to a call inside a called function',
    'const o = { x: 1 }; function set(t) { t.x = 5; } function init() { set(o); } init();',
    5,
  ],
  [
    'an object passed to a call inside a callback',
    'const o = { x: 1 }; function set(t) { t.x = 5; } [1].forEach(() => set(o));',
    5,
  ],
];

const unchangedCases: [name: string, source: string, value: unknown][] = [
  [
    'a binding that no function changes',
    'let n = 3; let m = 0; function init() { m += 1; } init();',
    3,
  ],
  [
    'a parameter with the same name',
    'let n = 3; function f(n) { n += 1; return n; } f(1);',
    3,
  ],
  [
    'a local with the same name',
    'let n = 3; function f() { let n = 0; n += 1; return n; } f();',
    3,
  ],
  [
    'a nested local with the same name',
    'let n = 3; function f() { let n = 0; const g = () => { n += 1; }; g(); return n; } f();',
    3,
  ],
  [
    'a function that only reads the binding',
    'let n = 3; function get() { return n; } get();',
    3,
  ],
  [
    'a function that writes the binding but that nothing calls',
    'let n = 3; function grow() { n += 1; }',
    3,
  ],
];

const unchangedObjectCases: [name: string, source: string, value: unknown][] = [
  [
    'an object that functions only read',
    'const o = { x: 3 }; function get() { return o.x; } get();',
    3,
  ],
  [
    'an object that only an uncalled setter writes',
    'const o = { x: 3 }; function set(v) { o.x = v; }',
    3,
  ],
  [
    'an object with a same-named parameter that is written',
    'const o = { x: 3 }; function f(o) { o.x = 5; } f({ x: 1 });',
    3,
  ],
];

// Objects passed to calls only inside helpers that nothing runs while the
// module loads; reading them stays static.
const uncalledHelperCases: [
  name: string,
  source: string,
  read: string,
  value: unknown,
][] = [
  [
    'Object.keys in an exported function',
    "const colors = { red: 'red' }; function keys() { return Object.keys(colors); }",
    'colors.red',
    'red',
  ],
  [
    'a local helper in an exported arrow function',
    'const theme = { space: 4 }; function lookup(o, k) { return o[k]; } const get = (k) => lookup(theme, k);',
    'theme.space',
    4,
  ],
  [
    'JSON.stringify in an exported arrow function',
    'const tokens = { gap: 8 }; const all = () => JSON.stringify(tokens);',
    'tokens.gap',
    8,
  ],
];

const resolveDependencyValue = (source: string, read: string) => {
  const code = `${source}\nexport const V = ${read};`;
  const { program } = parseSync('values.js', code);
  const target = findExportTarget(program, 'V');
  if (target?.kind !== 'expression') {
    throw new Error(`Cannot find the expression exported as V in ${code}`);
  }

  return collectStaticExpressionDependencies(program, target);
};

const evaluateSameFileValue = (source: string, read: string) => {
  const code = `${source}\nexport const V = ${read};`;
  const start = code.lastIndexOf(read);
  return evaluateOxcStaticExpressionAt(code, '/values.js', {
    end: start + read.length,
    start,
  });
};

const runModule = (source: string, read: string): unknown =>
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(`${source}\nreturn ${read};`)();

describe('module bindings changed by code that runs inside functions', () => {
  describe('fixtures', () => {
    it.each([...changedCases, ...unchangedCases])(
      'reads the expected value for %s',
      (_, s, value) => {
        expect(runModule(s, 'n')).toEqual(value);
      }
    );

    it.each([...changedObjectCases, ...unchangedObjectCases])(
      'reads the expected value for %s',
      (_, s, value) => {
        expect(runModule(s, 'o.x')).toEqual(value);
      }
    );

    it.each(uncalledHelperCases)(
      'reads the expected value for %s',
      (_, s, read, value) => {
        expect(runModule(s, read)).toEqual(value);
      }
    );
  });

  describe('static resolution of an exported value', () => {
    it.each(changedCases)(
      'does not resolve a binding changed by %s',
      (_, s) => {
        expect(resolveDependencyValue(s, 'n')).toBeNull();
      }
    );

    it.each(changedObjectCases)(
      'does not resolve an object changed by %s',
      (_, s) => {
        expect(resolveDependencyValue(s, 'o.x')).toBeNull();
      }
    );

    it.each(unchangedCases)('resolves %s', (_, s) => {
      expect(resolveDependencyValue(s, 'n')).not.toBeNull();
    });

    it.each(unchangedObjectCases)('resolves %s', (_, s) => {
      expect(resolveDependencyValue(s, 'o.x')).not.toBeNull();
    });

    it.each(uncalledHelperCases)(
      'resolves an object read by %s',
      (_, s, read) => {
        expect(resolveDependencyValue(s, read)).not.toBeNull();
      }
    );
  });

  describe('static evaluation of a same-file expression', () => {
    it.each(changedCases)(
      'does not evaluate a binding changed by %s',
      (_, s) => {
        expect(evaluateSameFileValue(s, 'n')).toBeUndefined();
      }
    );

    it.each(changedObjectCases)(
      'does not evaluate an object changed by %s',
      (_, s) => {
        expect(evaluateSameFileValue(s, 'o.x')).toBeUndefined();
      }
    );

    it.each(unchangedCases)('evaluates %s', (_, s, value) => {
      expect(evaluateSameFileValue(s, 'n')).toEqual(value);
    });

    it.each(unchangedObjectCases)('evaluates %s', (_, s, value) => {
      expect(evaluateSameFileValue(s, 'o.x')).toEqual(value);
    });

    it.each(uncalledHelperCases)(
      'evaluates an object read by %s',
      (_, s, read, value) => {
        expect(evaluateSameFileValue(s, read)).toEqual(value);
      }
    );
  });
});
