import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import { EventEmitter } from '../utils/EventEmitter';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

// The first transform pays the eval runner cold start.
const E2E_TIMEOUT = 30_000;

const transformWithTheme = async (themeCode: string) => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-namespace-property-value-'));
  const entry = join(root, 'entry.js');

  // Computed exports keep tokens.js out of the statically evaluatable fast
  // path, so its evaluated exports depend on the import record collected
  // for theme.js.
  writeFileSync(
    join(root, 'tokens.js'),
    [
      'const base = 16;',
      "export const primary = 'red' + base;",
      "export const secondary = 'blue' + base;",
    ].join('\n')
  );
  writeFileSync(join(root, 'theme.js'), themeCode);
  writeFileSync(
    entry,
    [
      "import { css } from 'test-css-processor';",
      "import { theme } from './theme.js';",
      'export const style = css`',
      '  color: ${theme.colors.primary};',
      '`;',
    ].join('\n')
  );

  const resolver = async (what: string, importer: string) => {
    if (what === 'test-css-processor') {
      return processorFile;
    }

    if (what.startsWith('.')) {
      return resolve(dirname(importer), what);
    }

    return null;
  };

  try {
    return await transform(
      {
        cache: new TransformCacheCollection(),
        eventEmitter: new EventEmitter(
          () => {},
          () => 0,
          () => {}
        ),
        options: {
          filename: entry,
          root,
          pluginOptions: {
            configFile: false,
            eval: { strategy: 'hybrid' },
            tagResolver: (source, tag) =>
              source === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
          },
        },
      },
      readFileSync(entry, 'utf8'),
      resolver
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('transform() namespace import stored in an object property', () => {
  it(
    'evaluates a namespace import kept as an object property value',
    async () => {
      const result = await transformWithTheme(
        [
          "import * as tokens from './tokens.js';",
          'export const theme = { colors: tokens };',
        ].join('\n')
      );

      expect(result.cssText).toContain('color:red16;');
    },
    E2E_TIMEOUT
  );

  it(
    'evaluates a namespace import kept as a shorthand object property',
    async () => {
      const result = await transformWithTheme(
        [
          "import * as colors from './tokens.js';",
          'export const theme = { colors };',
        ].join('\n')
      );

      expect(result.cssText).toContain('color:red16;');
    },
    E2E_TIMEOUT
  );
});
