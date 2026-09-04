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

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { promise, resolve };
};

const resolveWithExtensions = (candidate: string) => {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs'];
  for (const ext of extensions) {
    const withExt = `${candidate}${ext}`;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }

  return null;
};

// Static preeval resolves a value imported through another file with an
// analysis root entrypoint for that file (Entrypoint.createRoot(importer,
// [imported]) in resolveDependency). Two concurrent transforms that resolve
// different exports of the same barrel create competing analysis roots, and
// the second supersedes the first. resolveImports aborts for the superseded
// root, but the transform that issued it is not superseded itself, so no abort
// handler restarts anything: the loader call fails with "AbortError:
// superseded". resolveDependency must continue on the superseding generation.
it('survives a superseded analysis root of another file during static preeval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-analysis-root-'));
  const helpersFile = path.join(root, 'helpers.ts');
  const tokensFile = path.join(root, 'tokens.ts');
  const aFile = path.join(root, 'a.ts');
  const bFile = path.join(root, 'b.ts');

  fs.writeFileSync(
    helpersFile,
    dedent`
      export const red = 'red';
      export const blue = 'blue';
    `
  );
  fs.writeFileSync(
    tokensFile,
    dedent`
      export { red as tokenA, blue as tokenB } from './helpers';
    `
  );

  const aCode = dedent`
    import { css } from 'test-css-processor';
    import { tokenA } from './tokens';

    export const a = css\`
      color: \${tokenA};
    \`;
  `;
  const bCode = dedent`
    import { css } from 'test-css-processor';
    import { tokenB } from './tokens';

    export const b = css\`
      color: \${tokenB};
    \`;
  `;

  fs.writeFileSync(aFile, aCode);
  fs.writeFileSync(bFile, bCode);

  const cache = new TransformCacheCollection();
  const helpersResolveStarted = createDeferred();
  const helpersResolveUnblocked = createDeferred();
  let blockedHelpersResolve = false;

  const asyncResolve = async (what: string, importer: string) => {
    if (what === 'test-css-processor') {
      return processorFile;
    }

    if (what.startsWith('.') || path.isAbsolute(what)) {
      const resolved = resolveWithExtensions(
        path.resolve(path.dirname(importer), what)
      );

      if (resolved) {
        if (
          !blockedHelpersResolve &&
          importer === tokensFile &&
          resolved === helpersFile
        ) {
          // a.ts resolves './helpers' from tokens.ts on its analysis root.
          // Hold it until b.ts has created its own analysis root for
          // tokens.ts, which supersedes the one a.ts is resolving on. (The
          // successor shares the pending resolve task, so b.ts never issues a
          // second resolve for it.)
          blockedHelpersResolve = true;
          helpersResolveStarted.resolve();
          await helpersResolveUnblocked.promise;
        }

        return resolved;
      }
    }

    throw new Error(
      `Unexpected resolve ${JSON.stringify(what)} from ${importer}`
    );
  };

  const run = (filename: string, code: string) =>
    transform(
      {
        cache,
        options: {
          filename,
          root,
          pluginOptions: {
            configFile: false,
            tagResolver: (source, tag) => {
              if (source === 'test-css-processor' && tag === 'css') {
                return processorFile;
              }

              return null;
            },
            babelOptions: {
              babelrc: false,
              configFile: false,
              presets: [
                ['@babel/preset-env', { loose: true }],
                '@babel/preset-react',
                '@babel/preset-typescript',
              ],
            },
          },
        },
      },
      code,
      asyncResolve
    );

  const analysisRootOnly = () =>
    cache.get('entrypoints', tokensFile)?.only ?? [];

  const aTransform = run(aFile, aCode);
  await helpersResolveStarted.promise;
  expect(analysisRootOnly()).toEqual(['red']);

  const bTransform = run(bFile, bCode);
  const deadline = Date.now() + 2000;
  while (!analysisRootOnly().includes('blue') && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => {
      setTimeout(r, 5);
    });
  }
  expect(analysisRootOnly()).toEqual(['blue', 'red']);
  helpersResolveUnblocked.resolve();

  try {
    const [aResult, bResult] = await Promise.all([aTransform, bTransform]);

    expect(aResult.cssText).toContain('color:red');
    expect(bResult.cssText).toContain('color:blue');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
