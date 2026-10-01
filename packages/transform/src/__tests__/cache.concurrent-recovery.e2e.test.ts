import fs from 'fs';
import os from 'os';
import path from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';

const processorFile = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const resolveWithExtensions = (candidate: string) => {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const withExt = `${candidate}${ext}`;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }
  return null;
};

// Issue 422: a bundler loader keeps one TransformCacheCollection per compiler
// and runs loader calls concurrently. A fail-closed recovery for one module
// used to fail every transform in flight with an error naming another file.
it('keeps concurrent transforms alive when one file recovers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-conc-'));
  const tokens = path.join(root, 'tokens.ts');
  fs.writeFileSync(tokens, `export const c = 'red';\n`);

  const files: string[] = [];
  for (let i = 0; i < 6; i++) {
    const f = path.join(root, `m${i}.ts`);
    fs.writeFileSync(
      f,
      dedent`
        import { css } from 'test-css-processor';
        export const s${i} = css\`
          color: red;
        \`;
      `
    );
    files.push(f);
  }

  const cache = new TransformCacheCollection();
  const asyncResolve = async (what: string, importer: string) => {
    if (what === 'test-css-processor') return processorFile;
    const r = resolveWithExtensions(path.resolve(path.dirname(importer), what));
    if (!r) throw new Error(`resolve ${what} from ${importer}`);
    return r;
  };

  const run = (f: string) =>
    transform(
      {
        cache,
        options: {
          filename: f,
          root,
          pluginOptions: {
            configFile: false,
            tagResolver: (source: string, tag: string) =>
              source === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
            babelOptions: {
              babelrc: false,
              configFile: false,
              presets: [
                ['@babel/preset-env', { loose: true }],
                '@babel/preset-typescript',
              ],
            },
          },
        },
      },
      fs.readFileSync(f, 'utf8'),
      asyncResolve
    );

  try {
    // Warm the shared cache one file at a time, so the concurrent pass below
    // starts from cached entrypoints rather than a cold build.
    await files.reduce<Promise<unknown>>(
      (previous, f) => previous.then(() => run(f)),
      Promise.resolve()
    );

    // A fail-closed recovery for an unrelated phantom file lands while six
    // transforms are in flight on the shared cache.
    const started = files.map((f) => run(f));
    // Recovery for a phantom file, owned by no in-flight transform.
    cache.beginUnknownGraphRecovery(
      path.join(root, 'phantom.tsx'),
      new Set([path.join(root, 'missing.linaria.ts')]),
      'export const x = 1;',
      cache.createGraphTraversalToken()
    );
    const results = await Promise.allSettled(started);

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toEqual([]);
    expect(
      results.filter(
        (r) =>
          r.status === 'fulfilled' &&
          (r as PromiseFulfilledResult<{ cssText?: string }>).value.cssText
      )
    ).toHaveLength(files.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
