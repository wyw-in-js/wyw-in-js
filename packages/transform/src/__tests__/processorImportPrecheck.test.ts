import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import { parseOxc } from '../utils/applyOxcProcessors/shared';
import { getCachedOxcProcessorImports } from '../utils/collectOxcExportsAndImportsCache';
import { isRootWithoutProcessors } from '../utils/processorImportPrecheck';

const processorFile = resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const options = loadWywOptions({
  configFile: false,
  tagResolver: (source, tag) =>
    source === 'test-css-processor' && (tag === 'css' || tag === 'default')
      ? processorFile
      : null,
});

// The files are never read: each case gets its own name so that the parse and
// collection caches of one case are not reused by another.
const root = join(tmpdir(), 'wyw-processor-import-precheck');
const fileFor = (name: string, extension = '.ts') =>
  join(root, `${name}${extension}`);

const lines = (...items: string[]) => items.join('\n');

type Case = [name: string, code: string, expected: boolean];

describe('isRootWithoutProcessors', () => {
  const cases: Case[] = [
    [
      'plain module',
      lines(
        "import { format } from './format';",
        'export const label = format(42);'
      ),
      true,
    ],
    [
      'named processor import',
      lines(
        "import { css } from 'test-css-processor';",
        'export const red = css`color: red;`;'
      ),
      false,
    ],
    [
      'default processor import',
      lines(
        "import css from 'test-css-processor';",
        'export const red = css`color: red;`;'
      ),
      false,
    ],
    [
      'aliased processor import',
      lines(
        "import { css as c } from 'test-css-processor';",
        'export const red = c`color: red;`;'
      ),
      false,
    ],
    [
      'type-only import declaration',
      lines(
        "import type { css } from 'test-css-processor';",
        'export type Tag = typeof css;'
      ),
      true,
    ],
    [
      'type-only import specifier',
      lines(
        "import { type css } from 'test-css-processor';",
        'export type Tag = typeof css;'
      ),
      true,
    ],
    ['side-effect import', "import 'test-css-processor';", true],
    [
      'namespace import of a processor package',
      lines(
        "import * as p from 'test-css-processor';",
        'export const red = p.css`color: red;`;'
      ),
      false,
    ],
    [
      'namespace import of a plain module',
      lines("import * as u from './utils';", 'export const value = u.x;'),
      true,
    ],
    [
      'require inside a function',
      lines(
        'export function make() {',
        "  const { css } = require('test-css-processor');",
        '  return css`color: red;`;',
        '}'
      ),
      false,
    ],
    [
      'require with a space before the call',
      lines(
        "const { css } = require ('test-css-processor');",
        'export const red = css`color: red;`;'
      ),
      false,
    ],
    [
      'require at the top level',
      lines(
        "const { css } = require('test-css-processor');",
        'export const red = css`color: red;`;'
      ),
      false,
    ],
    [
      'require written with an escape',
      lines(
        "const { css } = r\\u0065quire('test-css-processor');",
        'export const red = css`color: red;`;'
      ),
      false,
    ],
    [
      'imported name written with an escape',
      lines(
        "import { c\\u0073s } from 'test-css-processor';",
        'export const red = css`color: red;`;'
      ),
      false,
    ],
    [
      'word require in a comment',
      lines(
        "// Nothing here calls require('test-css-processor').",
        "import { format } from './format';",
        'export const label = format(42);'
      ),
      true,
    ],
    [
      'processor import inside declare module',
      lines(
        "declare module 'x' {",
        "  import { css } from 'test-css-processor';",
        '}',
        'export const label = 42;'
      ),
      false,
    ],
    [
      'processor import inside a block',
      lines(
        '{',
        "  import { css } from 'test-css-processor';",
        '}',
        'export const label = 42;'
      ),
      false,
    ],
    [
      'processor import inside a function',
      lines(
        'export function make() {',
        "  import { css } from 'test-css-processor';",
        '}'
      ),
      false,
    ],
    ['explicit __wywPreval export', 'export const __wywPreval = {};', false],
    ['syntax error', "import { from 'test-css-processor';", false],
    [
      'dynamic import and import.meta next to a plain import',
      lines(
        "import { format } from './format';",
        "export const lazy = () => import('./lazy');",
        'export const url = import.meta.url;',
        'export const label = format(42);'
      ),
      true,
    ],
    [
      'import whose name contains the word require as a part',
      lines(
        "import { requireAuth } from './auth';",
        'export const guard = requireAuth();'
      ),
      true,
    ],
  ];

  it.each(cases)('answers for %s', (name, code, expected) => {
    expect(isRootWithoutProcessors(code, fileFor(name), options)).toBe(
      expected
    );
  });

  it('answers from the top-level imports without walking the module', () => {
    const plain = {
      code: lines(
        "import { format } from './format';",
        "import type { Theme } from './theme';",
        'export const label = (theme: Theme) => format(theme);'
      ),
      filename: fileFor('fast path plain module'),
    };
    const styled = {
      code: lines(
        "import { css } from 'test-css-processor';",
        "import { format } from './format';",
        'export const red = css`color: ${format(1)};`;'
      ),
      filename: fileFor('fast path processor module'),
    };

    expect(isRootWithoutProcessors(plain.code, plain.filename, options)).toBe(
      true
    );
    expect(isRootWithoutProcessors(styled.code, styled.filename, options)).toBe(
      false
    );

    expect(
      getCachedOxcProcessorImports(
        parseOxc(plain.code, plain.filename),
        plain.code
      )
    ).toBeNull();
    expect(
      getCachedOxcProcessorImports(
        parseOxc(styled.code, styled.filename),
        styled.code
      )
    ).toBeNull();
  });

  const walkedCases: [name: string, code: string][] = [
    [
      'word require in a comment',
      lines(
        '// Loaded without require on purpose.',
        "import { format } from './format';",
        'export const label = format(42);'
      ),
    ],
    [
      'unicode escape in the text',
      lines(
        "import { format } from './format';",
        "export const label = format('\\u00e9');"
      ),
    ],
    [
      'namespace import',
      lines("import * as u from './utils';", 'export const value = u.x;'),
    ],
    [
      'import inside declare module',
      lines(
        "import { format } from './format';",
        "declare module 'x' {",
        "  import { css } from 'test-css-processor';",
        '}',
        'export const label = format(42);'
      ),
    ],
    [
      'dynamic import',
      lines(
        "import { format } from './format';",
        "export const lazy = () => import('./lazy');",
        'export const label = format(42);'
      ),
    ],
  ];

  it.each(walkedCases)(
    'walks the module when its top-level imports may not be all it imports: %s',
    (name, code) => {
      const filename = fileFor(`walked ${name}`);

      isRootWithoutProcessors(code, filename, options);

      expect(
        getCachedOxcProcessorImports(parseOxc(code, filename), code)
      ).not.toBeNull();
    }
  );
});
