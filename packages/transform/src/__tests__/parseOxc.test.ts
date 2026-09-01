/* eslint-env jest */
import {
  isOxcRawTransferAstTypeCompatible,
  parseOxcCached,
} from '../utils/parseOxc';

describe('parseOxcCached', () => {
  it.each([
    {
      acceptedFilename: '/project/jsx-first.tsx',
      code: 'const jsxFirst = <div />;',
      rejectedFilename: '/project/jsx-first.ts',
    },
    {
      acceptedFilename: '/project/type-assertion-first.ts',
      code: 'const typeAssertionFirst = <number>1;',
      rejectedFilename: '/project/type-assertion-first.tsx',
    },
    {
      acceptedFilename: '/project/declaration-first.d.ts',
      code: 'const declarationFirst: string;',
      rejectedFilename: '/project/declaration-first.ts',
    },
    {
      acceptedFilename: '/project/runtime-first.ts',
      code: 'let runtimeFirst = 1;',
      rejectedFilename: '/project/runtime-first.d.ts',
    },
    {
      acceptedFilename: '/project/js-fallback-first.js',
      code: 'const jsFallbackFirst = <div />;',
      rejectedFilename: '/project/js-fallback-first.mjs',
    },
  ])(
    'keeps the grammar for $acceptedFilename separate from $rejectedFilename',
    ({ acceptedFilename, code, rejectedFilename }) => {
      expect(() =>
        parseOxcCached(acceptedFilename, code, 'module')
      ).not.toThrow();
      expect(() => parseOxcCached(rejectedFilename, code, 'module')).toThrow();
    }
  );

  it('shares entries across filenames with equivalent parser semantics', () => {
    const code = 'export const sharedDialectEntry: number = 1;';
    const first = parseOxcCached('/project/first-shared.ts', code, 'module');
    const second = parseOxcCached('/project/second-shared.ts', code, 'module');

    expect(second).toBe(first);
  });

  it('shares the AST but not cache-entry identity across source types', () => {
    const code = 'export const sharedSourceTypeEntry: number = 1;';
    const moduleEntry = parseOxcCached(
      '/project/shared-source-type.ts',
      code,
      'module'
    );
    const unambiguousEntry = parseOxcCached(
      '/project/shared-source-type.ts',
      code,
      'unambiguous'
    );

    expect(unambiguousEntry).not.toBe(moduleEntry);
    expect(unambiguousEntry.program).toBe(moduleEntry.program);
  });
});

describe('raw-transfer compatibility', () => {
  it.each([
    ['js', 'js', true],
    ['jsx', 'js', true],
    ['ts', 'ts', true],
    ['tsx', 'ts', true],
    ['dts', 'ts', true],
    ['ts', 'js', false],
    ['tsx', 'js', false],
    ['dts', 'js', false],
    ['js', 'ts', false],
  ] as const)(
    'classifies language %s with AST type %s',
    (language, astType, expected) => {
      expect(isOxcRawTransferAstTypeCompatible(language, astType)).toBe(
        expected
      );
    }
  );

  it('allows Oxc to select the default AST type', () => {
    expect(isOxcRawTransferAstTypeCompatible('ts', undefined)).toBe(true);
  });
});
