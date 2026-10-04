import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import { EventEmitter } from '../utils/EventEmitter';

const processorFile = resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const runTransform = async (filename: string, code: string) => {
  const actions: string[] = [];
  const eventEmitter = new EventEmitter(
    () => {},
    () => 0,
    (_sequenceId, _timestamp, event) => {
      if (event.type === 'actionCreated') {
        actions.push(event.actionType);
      }
    }
  );
  const cache = new TransformCacheCollection();

  const result = await transform(
    {
      cache,
      eventEmitter,
      options: {
        filename,
        root: tmpdir(),
        pluginOptions: {
          configFile: false,
          tagResolver: (source, tag) =>
            source === 'test-css-processor' && tag === 'css'
              ? processorFile
              : null,
        },
      },
    },
    code,
    async (what) => {
      if (what === 'test-css-processor') {
        return processorFile;
      }

      throw new Error(`Unable to resolve ${JSON.stringify(what)}`);
    }
  );

  return { actions, cache, result };
};

describe('roots without processor imports', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wyw-plain-root-'));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it('returns the code without running the preeval pipeline', async () => {
    const filename = join(root, 'plain.ts');
    const code = [
      "import { format } from './format';",
      'export const label = format(42);',
    ].join('\n');

    const { actions, cache, result } = await runTransform(filename, code);

    expect(result.code).toBe(code);
    expect(result.cssText).toBeUndefined();
    expect(actions).toEqual([]);
    expect(cache.get('entrypoints', filename)).toBeUndefined();
  });

  it('keeps processing roots that import a processor', async () => {
    const filename = join(root, 'styles.ts');
    const code = [
      "import { css } from 'test-css-processor';",
      'export const red = css`color: red;`;',
    ].join('\n');

    const { actions, result } = await runTransform(filename, code);

    expect(result.cssText).toContain('color:red');
    expect(actions).toContain('transform');
  });

  it('keeps processing roots with an explicit __wywPreval export', async () => {
    const filename = join(root, 'preval.ts');
    const code = 'export const __wywPreval = {};';

    const { actions } = await runTransform(filename, code);

    expect(actions).toContain('transform');
  });
});
