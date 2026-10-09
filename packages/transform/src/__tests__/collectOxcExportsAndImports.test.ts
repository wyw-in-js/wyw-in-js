/* eslint-env jest */
import { readFileSync } from 'fs';
import { join } from 'path';

import { globSync } from 'glob';

import {
  collectOxcExportsAndImports,
  type OxcCollectedState,
} from '../utils/collectOxcExportsAndImports';
import { collectOxcImportMap, toOxcImportMap } from '../utils/oxcImportMap';

const fixturesFolder = join(
  __dirname,
  '__fixtures__',
  'collectExportsAndImports'
);

type ComparableResults = {
  exports: { exported: string; local: unknown }[];
  imports: { imported: string; source: string }[];
  reexports: { exported: string; imported: string; source: string }[];
};

const sortByImport = (
  a: { imported: string; source: string },
  b: { imported: string; source: string }
): number =>
  a.imported === b.imported
    ? a.source.localeCompare(b.source)
    : a.imported.localeCompare(b.imported);

const evaluateLocal = (value: string): unknown => {
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }

  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }

  return value;
};

const comparable = (result: OxcCollectedState): ComparableResults => ({
  exports: Object.entries(result.exports)
    .map(([exported, local]) => ({
      exported,
      local: evaluateLocal(local.code),
    }))
    .sort((a, b) => a.exported.localeCompare(b.exported)),
  imports: result.imports
    .map(({ imported, source }) => ({ imported, source }))
    .sort(sortByImport),
  reexports: result.reexports
    .map(({ exported, imported, source }) => ({ exported, imported, source }))
    .sort(sortByImport),
});

const runFixture = (relativePath: string): ComparableResults => {
  const filename = join(fixturesFolder, relativePath);
  return comparable(
    collectOxcExportsAndImports(readFileSync(filename, 'utf-8'), filename)
  );
};

describe('collectOxcExportsAndImports', () => {
  it('builds one dependency map from imports and reexports', () => {
    const code = [
      "import { alpha, beta } from './values';",
      "import './side-effect';",
      "export { alpha, gamma as renamed } from './values';",
      "export * from './wildcard';",
    ].join('\n');
    const expected = [
      ['./values', ['alpha', 'beta', 'gamma']],
      ['./side-effect', ['side-effect']],
      ['./wildcard', ['*']],
    ];

    expect(
      Array.from(
        toOxcImportMap(collectOxcExportsAndImports(code, 'imports.ts'))
      )
    ).toEqual(expected);
    expect(Array.from(collectOxcImportMap(code, 'imports.ts'))).toEqual(
      expected
    );
  });

  it('collects ESM imports, exports, reexports, and type-only statements', () => {
    expect(runFixture('import_named.input.ts').imports).toMatchObject([
      { imported: 'named', source: 'unknown-package' },
    ]);
    expect(runFixture('import_types.input.ts').imports).toEqual([]);
    expect(
      runFixture('export_with_declaration.input.ts').exports
    ).toMatchObject([{ exported: 'a' }, { exported: 'b' }]);
    expect(runFixture('re-export_named.input.ts').reexports).toMatchObject([
      { exported: 'token', imported: 'token', source: 'unknown-package' },
    ]);
    expect(runFixture('re-export_export_all.input.ts').reexports).toMatchObject(
      [{ exported: '*', imported: '*', source: 'unknown-package' }]
    );
  });

  it('preserves namespace import unfolding heuristics', () => {
    expect(
      runFixture(
        'import_wildcard_clear_usage_of_the_imported_namespace.input.ts'
      ).imports
    ).toMatchObject([
      { imported: 'anotherNamed', source: 'unknown-package' },
      { imported: 'named', source: 'unknown-package' },
    ]);

    expect(
      runFixture('import_wildcard_destructed_namespace.input.ts').imports
    ).toMatchObject([{ imported: 'named', source: 'unknown-package' }]);

    expect(
      runFixture(
        'import_wildcard_dynamic_usage_of_the_imported_namespace.input.ts'
      ).imports
    ).toMatchObject([{ imported: '*', source: 'unknown-package' }]);

    expect(
      runFixture(
        'import_wildcard_unclear_usage_of_the_imported_namespace.input.ts'
      ).imports
    ).toMatchObject([{ imported: '*', source: 'unknown-package' }]);
  });

  describe('namespace import used in object and pattern positions', () => {
    const namespaceImports = (body: string) =>
      comparable(
        collectOxcExportsAndImports(
          [`import * as tokens from './tokens';`, body].join('\n'),
          join(fixturesFolder, 'inline-namespace-positions.input.ts')
        )
      ).imports;

    const wholeNamespace = [{ imported: '*', source: './tokens' }];
    const sideEffectOnly = [{ imported: 'side-effect', source: './tokens' }];

    it.each([
      ['an object property value', 'export const theme = { colors: tokens };'],
      [
        'a nested object property value',
        'export const theme = { palette: { colors: tokens } };',
      ],
      ['a shorthand object property', 'export const theme = { tokens };'],
      [
        'a property value that repeats the namespace name as its key',
        'export const theme = { tokens: tokens };',
      ],
      ['an array element', 'export const theme = [tokens];'],
      [
        'the source of a destructuring assignment',
        'let colors; export const pick = () => { ({ colors } = tokens); return colors; };',
      ],
      // Writes reference the existing binding: a pattern target counts the
      // same way as a plain assignment target.
      [
        'the target of a destructuring assignment',
        'export const pick = (x) => { ({ colors: tokens } = x); return x; };',
      ],
      [
        'the target of a plain assignment',
        'export const reset = (x) => { tokens = x; };',
      ],
    ])('treats %s as a use of the whole namespace', (_, body) => {
      expect(namespaceImports(body)).toEqual(wholeNamespace);
    });

    it('collects a destructured declaration from the namespace as named imports', () => {
      expect(
        namespaceImports(
          'export const pick = () => { const { colors: palette } = tokens; return palette; };'
        )
      ).toEqual([{ imported: 'colors', source: './tokens' }]);
    });

    it.each([
      [
        'a declaration pattern that shadows the namespace',
        'export const pick = (x) => { const { colors: tokens } = x; return tokens; };',
      ],
      [
        'a parameter pattern that shadows the namespace',
        'export const pick = ({ colors: tokens }) => tokens;',
      ],
      ['a non-computed object key', 'export const theme = { tokens: 1 };'],
      [
        'a non-computed member property',
        'export const theme = (x) => x.tokens;',
      ],
    ])('does not treat %s as a namespace use', (_, body) => {
      expect(namespaceImports(body)).toEqual(sideEffectOnly);
    });
  });

  it('collects require forms used by the compiled CommonJS corpus', () => {
    expect(runFixture('require_default.input.ts').imports).toMatchObject([
      { imported: 'default', source: 'unknown-package' },
    ]);
    expect(runFixture('require_named.input.ts').imports).toMatchObject([
      { imported: 'named', source: 'unknown-package' },
    ]);
    expect(runFixture('require_renamed.input.ts').imports).toMatchObject([
      { imported: 'named', source: 'unknown-package' },
    ]);
    expect(runFixture('require_deep.input.ts').imports).toMatchObject([
      { imported: 'very', source: 'unknown-package' },
    ]);
    expect(runFixture('require_not_an_import.input.ts').imports).toEqual([]);
  });

  it('collects require-backed namespace reexports from the compiled CommonJS corpus', () => {
    expect(
      runFixture('re-export_named_namespace.input.ts').reexports
    ).toMatchObject([
      { exported: 'ns', imported: '*', source: 'unknown-package' },
    ]);

    globSync(
      join(fixturesFolder, 're-export_named_namespace', '*.input.js')
    ).forEach((filename) => {
      expect(
        comparable(
          collectOxcExportsAndImports(readFileSync(filename, 'utf-8'), filename)
        ).reexports
      ).toEqual(
        expect.arrayContaining([
          { exported: 'ns', imported: '*', source: 'unknown-package' },
        ])
      );
    });
  });

  it('collects bare require side-effect edges and direct require-backed reexports', () => {
    const sideEffect = comparable(
      collectOxcExportsAndImports(
        `require('side-effects-only');`,
        join(fixturesFolder, 'inline-require-side-effects.input.js')
      )
    );
    const defaultReexport = comparable(
      collectOxcExportsAndImports(
        `module.exports = require('unknown-package');`,
        join(fixturesFolder, 'inline-module-exports-require.input.js')
      )
    );
    const namedReexport = comparable(
      collectOxcExportsAndImports(
        `exports.ns = require('unknown-package');`,
        join(fixturesFolder, 'inline-exports-require.input.js')
      )
    );

    expect(sideEffect.imports).toEqual([
      { imported: 'side-effect', source: 'side-effects-only' },
    ]);
    expect(defaultReexport.reexports).toEqual([
      { exported: 'default', imported: '*', source: 'unknown-package' },
    ]);
    expect(namedReexport.reexports).toEqual([
      { exported: 'ns', imported: '*', source: 'unknown-package' },
    ]);
  });

  it('collects mixed ESM reexports', () => {
    expect(runFixture('re-export_mixed_exports.input.ts')).toMatchObject({
      exports: [{ exported: 'default', local: 123 }],
      reexports: [
        {
          exported: '*',
          imported: '*',
          source: './collectExportsAndImports',
        },
        {
          exported: 'isUnnecessaryReactCall',
          imported: 'default',
          source: './isUnnecessaryReactCall',
        },
        {
          exported: 'syncResolve',
          imported: 'syncResolve',
          source: './asyncResolveFallback',
        },
      ],
    });
  });

  it('collects compiled CommonJS mixed reexport fixtures', () => {
    const files = globSync(
      join(fixturesFolder, 're-export_mixed_exports', '*.input.js')
    );

    expect(files.length).toBeGreaterThan(0);
    files.forEach((filename) => {
      const result = comparable(
        collectOxcExportsAndImports(readFileSync(filename, 'utf-8'), filename)
      );

      expect(result.exports).toContainEqual(
        expect.objectContaining({ exported: 'default' })
      );
      expect(result.reexports).toEqual(
        expect.arrayContaining([
          {
            exported: '*',
            imported: '*',
            source: './collectExportsAndImports',
          },
          {
            exported: 'isUnnecessaryReactCall',
            imported: 'default',
            source: './isUnnecessaryReactCall',
          },
          {
            exported: 'syncResolve',
            imported: 'syncResolve',
            source: './asyncResolveFallback',
          },
        ])
      );
    });
  });

  it('collects compiled CommonJS export-star and defineProperty fixtures', () => {
    globSync(
      join(fixturesFolder, 're-export___exportStar', '*.input.js')
    ).forEach((filename) => {
      const result = comparable(
        collectOxcExportsAndImports(readFileSync(filename, 'utf-8'), filename)
      );

      expect(result.reexports).toEqual(
        expect.arrayContaining([
          { exported: '*', imported: '*', source: './moduleA1' },
        ])
      );
    });

    globSync(
      join(
        fixturesFolder,
        'export_with_defineProperty_with_getter',
        '*.input.js'
      )
    ).forEach((filename) => {
      expect(
        comparable(
          collectOxcExportsAndImports(readFileSync(filename, 'utf-8'), filename)
        ).exports
      ).toContainEqual(expect.objectContaining({ exported: 'a' }));
    });
  });
});
