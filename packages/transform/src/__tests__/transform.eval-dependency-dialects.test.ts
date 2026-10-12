import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

// The first evaluation spawns the eval runner.
const EVAL_TEST_TIMEOUT = 30_000;

describe('transform evaluates dependencies in every source dialect', () => {
  let root: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'wyw-eval-dialects-')));
    mkdirSync(join(root, 'node_modules', 'react'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'react', 'jsx-runtime.js'),
      'exports.jsx = (type) => ({ type });\nexports.jsxs = exports.jsx;\n'
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const evaluate = async (dependency: string, code: string) => {
    writeFileSync(join(root, dependency), code);
    const entry = join(root, `entry-${dependency}.js`);
    writeFileSync(
      entry,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './${dependency}';

        export const className = css\`color: ${'${color}'};\`;
      `
    );

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
              eval: { strategy: 'execute' },
              // Keeps the JSX of the dependency in the evaluated code.
              features: { dangerousCodeRemover: false },
              // Strip adds this import after the dependency was resolved.
              importOverrides: { 'react/jsx-runtime': { unknown: 'allow' } },
              tagResolver: (source, tag) =>
                source === 'test-css-processor' && tag === 'css'
                  ? processorFile
                  : null,
            },
          },
        },
        readFileSync(entry, 'utf8'),
        async (what, importer) => {
          if (what === 'test-css-processor') return processorFile;
          if (what === 'react/jsx-runtime') {
            return join(root, 'node_modules', 'react', 'jsx-runtime.js');
          }
          return what.startsWith('.') ? resolve(dirname(importer), what) : null;
        }
      );

      return result.cssText;
    } finally {
      disposeEvalBroker(cache);
    }
  };

  it(
    'evaluates a .js dependency with JSX',
    async () => {
      const cssText = await evaluate(
        'jsx-in-js.js',
        dedent`
          const render = () => <div />;
          export const color = typeof render === 'function' ? 'red' : 'blue';
        `
      );

      expect(cssText).toContain('color:red;');
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'evaluates a .cts dependency with type annotations',
    async () => {
      const cssText = await evaluate(
        'typed.cts',
        dedent`
          const color: string = String('green');
          export { color };
        `
      );

      expect(cssText).toContain('color:green;');
    },
    EVAL_TEST_TIMEOUT
  );
});
