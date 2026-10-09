import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';
import { EventEmitter } from '../utils/EventEmitter';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

// Blank lines, a line that starts with `const `, and a `,\n}` sequence: each
// of them used to be rewritten by text-level normalisation of prepared code.
const literalValue = ['line1', '', '', 'const x = 1,', '}', 'end,', '  }'].join(
  '\n'
);
const literalSource = `\`${literalValue}\``;

const createEvalCounter = () => {
  let evalFileCalls = 0;
  const eventEmitter = new EventEmitter(
    (labels, type) => {
      if (type === 'start' && labels.method === 'transform:evalFile') {
        evalFileCalls += 1;
      }
    },
    () => 0,
    () => {}
  );

  return { eventEmitter, getEvalFileCalls: () => evalFileCalls };
};

const runTransform = async (
  files: Record<string, string>,
  eventEmitter: EventEmitter
) => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-eval-literals-'));
  const cache = new TransformCacheCollection();
  Object.entries(files).forEach(([name, code]) => {
    writeFileSync(join(root, name), code);
  });
  const entryFile = join(root, 'entry.js');

  try {
    return await transform(
      {
        cache,
        eventEmitter,
        options: {
          filename: entryFile,
          root,
          pluginOptions: {
            configFile: false,
            eval: { strategy: 'execute' },
            tagResolver: (source, tag) =>
              source === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
          },
        },
      },
      readFileSync(entryFile, 'utf8'),
      async (what, importer) => {
        if (what === 'test-css-processor') {
          return processorFile;
        }

        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }

        return null;
      }
    );
  } finally {
    disposeEvalBroker(cache);
    rmSync(root, { recursive: true, force: true });
  }
};

const cssUsage = [
  'export const className = css`',
  '  --text: ${JSON.stringify(text)};',
  '  --other: ${JSON.stringify(other)};',
  '`;',
];

const expectVerbatimLiterals = (cssText: string | undefined) => {
  const expected = JSON.stringify(literalValue);
  expect(cssText).toContain(`--text:${expected};`);
  expect(cssText).toContain(`--other:${expected};`);
};

describe('eval keeps string and template literal contents intact', () => {
  it('evaluates template literals of the root module verbatim', async () => {
    const counter = createEvalCounter();
    const result = await runTransform(
      {
        'entry.js': [
          "import { css } from 'test-css-processor';",
          `const text = ${literalSource};`,
          `export const other = ${literalSource};`,
          ...cssUsage,
        ].join('\n'),
      },
      counter.eventEmitter
    );

    expect(counter.getEvalFileCalls()).toBeGreaterThan(0);
    expectVerbatimLiterals(result.cssText);
  });

  it('evaluates template literals of an imported module verbatim', async () => {
    const counter = createEvalCounter();
    const result = await runTransform(
      {
        'dep.js': [
          `const text = ${literalSource};`,
          `export const other = ${literalSource};`,
          'export { text };',
        ].join('\n'),
        'entry.js': [
          "import { css } from 'test-css-processor';",
          "import { other, text } from './dep';",
          ...cssUsage,
        ].join('\n'),
      },
      counter.eventEmitter
    );

    expect(counter.getEvalFileCalls()).toBeGreaterThan(0);
    expectVerbatimLiterals(result.cssText);
  });
});
