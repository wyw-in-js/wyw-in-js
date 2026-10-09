import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

const transformSource = async (code: string) => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-var-before-declaration-'));
  const entryFile = join(root, 'entry.js');
  writeFileSync(entryFile, code);

  try {
    return await transform(
      {
        cache: new TransformCacheCollection(),
        options: {
          filename: entryFile,
          root,
          pluginOptions: {
            configFile: false,
            eval: { strategy: 'hybrid' },
            tagResolver: (source: string, tag: string) =>
              source === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
          },
        },
      },
      code,
      async (what: string) =>
        what === 'test-css-processor' ? processorFile : null
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe('a var read before its declaration', () => {
  // Template interpolations are evaluated lazily at the end of the module, so
  // the evaluated value is the one assigned by the later declaration.
  it.each([
    ['a plain interpolation', '${color}'],
    ['a condition', "${color ? color : 'blue'}"],
    ['a negation', "${!color ? 'blue' : color}"],
  ])(
    'keeps the end-of-module value in %s',
    async (_description, value) => {
      const result = await transformSource(dedent`
      import { css } from 'test-css-processor';

      export const className = css\`color: ${value};\`;

      var color = 'red';
    `);

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).not.toContain('blue');
    },
    30_000
  );
});
