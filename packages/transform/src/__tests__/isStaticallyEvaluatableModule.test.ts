import { isStaticallyEvaluatableModule } from '../transform/isStaticallyEvaluatableModule';

describe('isStaticallyEvaluatableModule', () => {
  it.each([
    ['a side-effect import', "import './polyfill';\nexport const a = 1;"],
    [
      'an empty named import',
      "import {} from './polyfill';\nexport const a = 1;",
    ],
    ['a value import', "import { b } from './b';\nexport const a = 1;"],
    [
      'mixed type and value specifiers',
      "import { type B, c } from './b';\nexport const a = 1;",
    ],
  ])('rejects a module with %s', (_, code) => {
    expect(isStaticallyEvaluatableModule(code, 'module.ts')).toBe(false);
  });

  it.each([
    ['an import type declaration', "import type { B } from './b';"],
    ['only type specifiers', "import { type B, type C } from './b';"],
  ])('accepts a module with %s', (_, importStatement) => {
    expect(
      isStaticallyEvaluatableModule(
        `${importStatement}\nexport const a = 1;`,
        'module.ts'
      )
    ).toBe(true);
  });
});
