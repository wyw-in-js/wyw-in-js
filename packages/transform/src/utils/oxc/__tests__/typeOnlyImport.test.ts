/* eslint-env jest */
import type { ImportDeclaration } from 'oxc-parser';

import { parseOxcProgram } from '../parse';
import { isTypeOnlyImport, isTypeOnlyImportSpecifier } from '../typeOnlyImport';

const parseImport = (code: string): ImportDeclaration => {
  const [statement] = parseOxcProgram(code, 'imports.ts', 'module').body;
  if (statement?.type !== 'ImportDeclaration') {
    throw new Error(`Expected an import declaration: ${code}`);
  }

  return statement;
};

describe('isTypeOnlyImport', () => {
  it.each([
    ["import type { A } from './a';", true],
    ["import type A from './a';", true],
    ["import type * as A from './a';", true],
    ["import { type A, type B } from './a';", true],
    ["import './polyfill';", false],
    ["import {} from './polyfill';", false],
    ["import { A } from './a';", false],
    ["import { type A, B } from './a';", false],
    ["import A, { type B } from './a';", false],
    ["import * as A from './a';", false],
  ])('%s -> %s', (code, expected) => {
    expect(isTypeOnlyImport(parseImport(code))).toBe(expected);
  });
});

describe('isTypeOnlyImportSpecifier', () => {
  it.each([
    ["import A, { type B, C } from './a';", [false, true, false]],
    ["import type A from './a';", [true]],
    ["import type { A, B } from './a';", [true, true]],
  ])('%s -> %j', (code, expected) => {
    const declaration = parseImport(code);

    expect(
      declaration.specifiers.map((specifier) =>
        isTypeOnlyImportSpecifier(declaration, specifier)
      )
    ).toEqual(expected);
  });
});
