import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';
import { Entrypoint } from '../transform/Entrypoint';
import { AbortError } from '../transform/actions/AbortError';
import { EntrypointEvictedError } from '../transform/actions/EntrypointEvictedError';
import { baseHandlers } from '../transform/generators';

const processorFile = path.join(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);
const code =
  "import { css } from 'test-css-processor'; export const cls = css`color: red;`;";

it.each(['collect', 'extract'] as const)(
  'retries the supplied root after eviction during %s',
  async (stage) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-evicted-root-'));
    const filename = path.join(root, 'entry.ts');
    fs.writeFileSync(filename, code);
    const cache = new TransformCacheCollection();
    let attempts = 0;
    try {
      const result = await transform(
        {
          cache,
          options: {
            filename,
            root,
            pluginOptions: {
              configFile: false,
              tagResolver: () => processorFile,
              babelOptions: { babelrc: false, configFile: false },
            },
          },
        },
        code,
        async () => processorFile,
        {
          [stage]: function* handler(...args) {
            const stageResult = yield* baseHandlers[stage].apply(this, args);
            attempts += 1;
            if (attempts === 1) cache.invalidateForFile(filename);
            return stageResult;
          },
        }
      );
      expect(attempts).toBe(2);
      expect(result.code).not.toContain('css`');
      expect(result.cssText).toContain('color:red');
    } finally {
      disposeEvalBroker(cache);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

it.each(['eviction', 'replacement'] as const)(
  'bounds root retries and rejects foreign publications (%s)',
  async (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-evicted-root-'));
    const filename = path.join(root, 'entry.ts');
    fs.writeFileSync(filename, code);
    const cache = new TransformCacheCollection();
    let attempts = 0;
    try {
      await expect(
        transform(
          {
            cache,
            options: {
              filename,
              root,
              pluginOptions: {
                configFile: false,
                tagResolver: () => processorFile,
                babelOptions: { babelrc: false, configFile: false },
              },
            },
          },
          code,
          async () => processorFile,
          {
            collect: function* handler(...args) {
              const result = yield* baseHandlers.collect.apply(this, args);
              attempts += 1;
              if (mode === 'eviction') cache.invalidateForFile(filename);
              else {
                cache.invalidateForFile(filename);
                Entrypoint.createRoot(
                  this.services,
                  filename,
                  ['__wywPreval'],
                  'export const replacement = true;'
                );
              }
              return result;
            },
          }
        )
      ).rejects.toBeInstanceOf(
        mode === 'eviction' ? EntrypointEvictedError : AbortError
      );
      expect(attempts).toBe(mode === 'eviction' ? 4 : 1);
    } finally {
      disposeEvalBroker(cache);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
