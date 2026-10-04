import fs from 'fs';
import os from 'os';
import path from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import type { Entrypoint } from '../transform/Entrypoint';

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

  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const withExt = `${candidate}${ext}`;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }

  return null;
};

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

const waitFor = (predicate: () => boolean, attempts = 1000): Promise<void> =>
  predicate() || attempts === 0
    ? Promise.resolve()
    : tick().then(() => waitFor(predicate, attempts - 1));

// Two roots import different exports of one shared module. The first root is
// held while the shared module resolves its own import; the second root widens
// the shared module in the meantime and supersedes the generation the first
// root is waiting on. The first root must continue on the successor instead of
// failing with the shared module's supersede.
it('continues on a dependency superseded by another root while it resolves', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-foreign-supersede-'));
  const tokensFile = path.join(root, 'tokens.ts');
  const sharedFile = path.join(root, 'shared.ts');
  const firstFile = path.join(root, 'first.ts');
  const secondFile = path.join(root, 'second.ts');

  fs.writeFileSync(
    tokensFile,
    `export const colors = { red: 'red', blue: 'blue' };`
  );

  // `two` is not statically evaluable, so a root that needs it processes the
  // shared module through the evaluator and widens its requested exports.
  const sharedCode = dedent`
    import { colors } from './tokens';

    const mix = (color: string) => color + '-mixed';

    export const one = colors.red;
    export const two = mix(colors.blue);
  `;

  const firstCode = dedent`
    import { css } from 'test-css-processor';
    import { one } from './shared';

    export const first = css\`
      color: \${one};
    \`;
  `;

  const secondCode = dedent`
    import { css } from 'test-css-processor';
    import { two } from './shared';

    export const second = css\`
      color: \${two};
    \`;
  `;

  fs.writeFileSync(sharedFile, sharedCode);
  fs.writeFileSync(firstFile, firstCode);
  fs.writeFileSync(secondFile, secondCode);

  const cache = new TransformCacheCollection();
  const sharedResolvingTokens = createDeferred();
  const releaseShared = createDeferred();
  let held = false;

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

    if (!held && importer === sharedFile && resolved === tokensFile) {
      held = true;
      sharedResolvingTokens.resolve();
      await releaseShared.promise;
    }

    return resolved;
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
            tagResolver: (source, tag) =>
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
      code,
      asyncResolve
    );

  const sharedOnly = () =>
    (cache.get('entrypoints', sharedFile) as Entrypoint | undefined)?.only ??
    [];

  const firstTransform = run(firstFile, firstCode);
  await sharedResolvingTokens.promise;
  const heldShared = cache.get('entrypoints', sharedFile) as Entrypoint;
  expect(heldShared.supersededWith).toBeNull();

  const secondTransform = run(secondFile, secondCode);
  await waitFor(() => sharedOnly().includes('two'));
  expect(sharedOnly()).toContain('two');
  expect(heldShared.supersededWith).not.toBeNull();
  releaseShared.resolve();

  try {
    const [firstResult, secondResult] = await Promise.all([
      firstTransform,
      secondTransform,
    ]);

    expect(firstResult.cssText).toContain('color:red');
    expect(secondResult.cssText).toContain('color:blue-mixed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
