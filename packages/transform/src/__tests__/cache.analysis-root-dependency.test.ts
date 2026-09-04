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

  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs']) {
    const withExt = `${candidate}${ext}`;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }

  return null;
};

// Static preeval follows a re-export chain with an analysis root per hop
// (Entrypoint.createRoot(hop, [imported]) in resolveDependency). Each root is
// published to the cache, only resolves imports and never starts processing,
// so its graph never completes. The importing module lists every hop as an
// invalidation dependency; a freshness check of that module must verify the
// hops by content hash instead of reporting their graphs as unknown, which
// would reset the whole cache on the first re-check of every such module.
it('keeps a known graph across analysis roots of a re-export chain', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-analysis-chain-'));
  const helpersFile = path.join(root, 'helpers.ts');
  const subFile = path.join(root, 'sub.ts');
  const tokensFile = path.join(root, 'tokens.ts');
  const aFile = path.join(root, 'a.ts');

  fs.writeFileSync(helpersFile, `export const red = 'red';\n`);
  fs.writeFileSync(subFile, `export { red } from './helpers';\n`);
  fs.writeFileSync(tokensFile, `export { red as tokenA } from './sub';\n`);
  const aCode = dedent`
    import { css } from 'test-css-processor';
    import { tokenA } from './tokens';

    export const a = css\`
      color: \${tokenA};
    \`;
  `;
  fs.writeFileSync(aFile, aCode);

  const cache = new TransformCacheCollection();
  const asyncResolve = async (what: string, importer: string) => {
    if (what === 'test-css-processor') {
      return processorFile;
    }

    const resolved = resolveWithExtensions(
      path.resolve(path.dirname(importer), what)
    );
    if (!resolved) {
      throw new Error(
        `Unexpected resolve ${JSON.stringify(what)} from ${importer}`
      );
    }

    return resolved;
  };

  const run = () =>
    transform(
      {
        cache,
        options: {
          filename: aFile,
          root,
          pluginOptions: {
            configFile: false,
            tagResolver: (source, tag) =>
              source === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
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
      aCode,
      asyncResolve
    );

  try {
    const first = await run();
    expect(first.cssText).toContain('color:red');

    const tokensRoot = cache.get('entrypoints', tokensFile);
    expect(tokensRoot).toBeDefined();
    expect(tokensRoot?.transformed).toBe(false);
    expect(
      [
        ...(cache.get('entrypoints', aFile)?.invalidationDependencies.keys() ??
          []),
      ].sort()
    ).toEqual([helpersFile, subFile, tokensFile].sort());

    expect(cache.invalidateIfChangedWithDetails(aFile, aCode)).toEqual({
      changed: false,
      unknownDependencyGraphs: new Set(),
    });
    expect(cache.get('entrypoints', aFile)).toBeDefined();

    const second = await run();
    expect(second.cssText).toContain('color:red');
    expect(cache.get('entrypoints', tokensFile)).toBe(tokensRoot);

    // A change behind the chain is still a change for a.ts.
    fs.writeFileSync(helpersFile, `export const red = 'blue';\n`);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(helpersFile, later, later);

    expect(cache.invalidateIfChangedWithDetails(aFile, aCode).changed).toBe(
      true
    );
    const third = await run();
    expect(third.cssText).toContain('color:blue');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
