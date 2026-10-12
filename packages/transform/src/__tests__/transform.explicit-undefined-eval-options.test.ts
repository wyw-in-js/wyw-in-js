import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

// The first evaluation spawns the eval runner.
const EVAL_TEST_TIMEOUT = 30_000;

describe('transform with eval options set to undefined', () => {
  let root: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'wyw-undefined-eval-')));
    writeFileSync(
      join(root, 'theme.js'),
      "export const color = String('teal');\n"
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it(
    'resolves imports during evaluation with the default resolver',
    async () => {
      const entry = join(root, 'entry.js');
      const code = dedent`
        import { css } from 'test-css-processor';
        import { color } from './theme';

        export const className = css\`color: ${'${color}'};\`;
      `;
      writeFileSync(entry, code);

      const cache = new TransformCacheCollection();
      try {
        const result = await transform(
          {
            cache,
            options: {
              filename: entry,
              root,
              pluginOptions: {
                configFile: false,
                eval: {
                  errors: undefined,
                  require: undefined,
                  resolver: undefined,
                  strategy: 'execute',
                },
                tagResolver: (source, tag) =>
                  source === 'test-css-processor' && tag === 'css'
                    ? processorFile
                    : null,
              },
            },
          },
          code,
          async (what, importer) => {
            if (what === 'test-css-processor') return processorFile;
            return what.startsWith('.')
              ? `${resolve(dirname(importer), what)}.js`
              : null;
          }
        );

        expect(result.cssText).toContain('color:teal;');
      } finally {
        disposeEvalBroker(cache);
      }
    },
    EVAL_TEST_TIMEOUT
  );
});
