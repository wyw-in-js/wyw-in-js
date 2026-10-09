import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';
import { Entrypoint } from '../transform/Entrypoint';
import { baseHandlers } from '../transform/generators';
import type { AllHandlers } from '../transform/types';

const processorFile = path.join(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);
const code =
  "import { css } from 'test-css-processor'; export const cls = css`color: red;`;";

const transformWithSupersede = async (
  createHandlers: (
    supersede: (services: Entrypoint['services']) => void
  ) => Partial<AllHandlers<'sync'>>
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-superseded-root-'));
  const filename = path.join(root, 'entry.ts');
  fs.writeFileSync(filename, code);
  const cache = new TransformCacheCollection();
  let supersedes = 0;
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
      createHandlers((services) => {
        if (supersedes > 0) return;
        supersedes += 1;
        // A concurrent transform needs another export of the same module,
        // so the cache publishes a wider generation of the root.
        Entrypoint.createRoot(services, filename, ['__wywPreval', 'cls'], code);
      })
    );
    return { result, supersedes };
  } finally {
    disposeEvalBroker(cache);
    fs.rmSync(root, { recursive: true, force: true });
  }
};

it('restarts the root when a wider generation supersedes it during evaluation', async () => {
  const { result, supersedes } = await transformWithSupersede(
    (supersede) =>
      ({
        evalFile: async function* handler(
          this: { services: Entrypoint['services'] },
          ...args: unknown[]
        ) {
          supersede(this.services);
          return yield* (
            baseHandlers.evalFile as (...a: unknown[]) => AsyncGenerator
          ).apply(this, args);
        },
      }) as unknown as Partial<AllHandlers<'sync'>>
  );

  expect(supersedes).toBe(1);
  expect(result.code).not.toContain('css`');
  expect(result.cssText).toContain('color:red');
});

it('restarts the root when a wider generation supersedes it during collect', async () => {
  const { result, supersedes } = await transformWithSupersede((supersede) => ({
    collect: function* handler(...args) {
      supersede(this.services);
      return yield* baseHandlers.collect.apply(this, args);
    },
  }));

  expect(supersedes).toBe(1);
  expect(result.code).not.toContain('css`');
  expect(result.cssText).toContain('color:red');
});
