import path from 'path';

import type { Options } from '../types';
import { transform } from '../transform';

const processorFile = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);
const root = path.resolve(__dirname, '__fixtures__', 'output-filename-urls');
const filename = path.join(root, 'src', 'button.js');
const outputFilename = path.join(root, 'dist', 'css', 'button.css');

const code = [
  "import { css } from 'test-css-processor';",
  'export const button = css`',
  '  background: url(./icon.png);',
  '  mask: url("../shared/mask.svg");',
  '  cursor: url(/cursor.cur), auto;',
  '`;',
].join('\n');

const transformCss = async (
  options: Pick<Options, 'outputFilename' | 'preprocessor'>
) => {
  const result = await transform(
    {
      options: {
        filename,
        root,
        prefixer: false,
        pluginOptions: {
          configFile: false,
          tagResolver: (source, tag) =>
            source === 'test-css-processor' && tag === 'css'
              ? processorFile
              : null,
        },
        ...options,
      },
    },
    code,
    async () => null
  );

  return result.cssText?.match(/url\([^)]+\)/g);
};

describe('transform() with outputFilename', () => {
  it('rewrites relative url() paths for the none preprocessor', async () => {
    expect(
      await transformCss({ outputFilename, preprocessor: 'none' })
    ).toEqual([
      'url(../../src/icon.png)',
      'url("../../shared/mask.svg")',
      'url(/cursor.cur)',
    ]);
  });

  it('rewrites the same url() paths as the stylis preprocessor', async () => {
    expect(
      await transformCss({ outputFilename, preprocessor: 'stylis' })
    ).toEqual(await transformCss({ outputFilename, preprocessor: 'none' }));
  });

  it('keeps url() paths of the none preprocessor without outputFilename', async () => {
    expect(await transformCss({ preprocessor: 'none' })).toEqual([
      'url(./icon.png)',
      'url("../shared/mask.svg")',
      'url(/cursor.cur)',
    ]);
  });
});
