import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

const transformSource = async (
  code: string,
  strategy: 'execute' | 'hybrid'
) => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-eval-new-target-'));
  const entryFile = join(root, 'entry.js');
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
            eval: { strategy },
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

describe.each(['execute', 'hybrid'] as const)(
  'new.target in evaluated code (%s strategy)',
  (strategy) => {
    it('keeps a constructor statement that reads new.target', async () => {
      const result = await transformSource(
        dedent`
          import { css } from 'test-css-processor';

          function Color(v) {
            this.v = new.target ? v : 'blue';
          }

          export const cls = css\`color: ${'${new Color("red").v}'};\`;
        `,
        strategy
      );

      expect(result.cssText).toContain('color:red');
    }, 30_000);

    it('keeps a new.target guard that redirects a plain call to new', async () => {
      const result = await transformSource(
        dedent`
          import { css } from 'test-css-processor';

          function Color(v) {
            if (!new.target) return new Color(v);
            this.v = v;
          }

          export const cls = css\`color: ${'${Color("red").v}'};\`;
        `,
        strategy
      );

      expect(result.cssText).toContain('color:red');
    }, 30_000);

    it('keeps the new.target statements of an Error subclass', async () => {
      const result = await transformSource(
        dedent`
          import { css } from 'test-css-processor';

          class ValidationError extends Error {
            constructor(message) {
              super(message);
              this.name = new.target.name;
              Object.setPrototypeOf(this, new.target.prototype);
            }
          }

          const error = new ValidationError('invalid');
          const kind = error instanceof ValidationError ? error.name : 'unknown';

          export const cls = css\`--kind: ${'${kind}'};\`;
        `,
        strategy
      );

      expect(result.cssText).toContain('--kind:ValidationError');
    }, 30_000);
  }
);
