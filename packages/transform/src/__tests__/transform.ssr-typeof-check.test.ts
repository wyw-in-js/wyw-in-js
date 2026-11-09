import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

const transformSource = async (code: string) => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-ssr-typeof-check-'));
  const entryFile = join(root, 'entry.ts');
  const cache = new TransformCacheCollection();
  writeFileSync(entryFile, code);

  try {
    return await transform(
      {
        cache,
        options: {
          filename: entryFile,
          root,
          pluginOptions: {
            configFile: false,
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
    disposeEvalBroker(cache);
    rmSync(root, { force: true, recursive: true });
  }
};

describe('an SSR typeof check', () => {
  // The eval runner defines the browser globals, so only the removal of
  // dangerous code makes evaluation take the server branch of a check.
  it.each([
    ['in parentheses', 'typeof(window)'],
    ['in nested parentheses', 'typeof ((window))'],
    ['under a type assertion', 'typeof (window as any)'],
    ['under a non-null assertion', 'typeof window!'],
    ['under nested TS wrappers', 'typeof (window as any)!'],
    ['of document in parentheses', 'typeof(document)'],
  ])(
    'takes the server branch for a check %s',
    async (_description, check) => {
      const result = await transformSource(dedent`
        import { css } from 'test-css-processor';

        const env = ${check} !== 'undefined' ? 'browser' : 'server';

        export const className = css\`--env: ${'${env}'};\`;
      `);

      expect(result.cssText).toContain('--env:server');
    },
    30_000
  );
});
