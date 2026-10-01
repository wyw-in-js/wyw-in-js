import fs from 'fs';
import os from 'os';
import path from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import type { Entrypoint } from '../transform/Entrypoint';
import { EventEmitter } from '../utils/EventEmitter';

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

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

const waitFor = (predicate: () => boolean, attempts = 1000): Promise<void> =>
  predicate() || attempts === 0
    ? Promise.resolve()
    : tick().then(() => waitFor(predicate, attempts - 1));

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

type LoadedModuleGate = <TRes>(id: string, fn: () => TRes) => TRes;

class LoadedModuleGateEmitter extends EventEmitter {
  constructor(private readonly gate: LoadedModuleGate) {
    super(
      () => {},
      () => 0,
      () => {},
      false
    );
  }

  public action<TRes>(
    actionType: string,
    idx: string,
    entrypointRef: string,
    fn: () => TRes
  ): TRes {
    if (actionType === 'eval:loadModule') {
      return this.gate(idx.slice(idx.indexOf('\0') + 1), fn);
    }

    return super.action(actionType, idx, entrypointRef, fn);
  }
}

// `entry` loads `shared` into its evaluation. Before that evaluation
// publishes, `other` widens `shared` and supersedes the generation `entry`
// loaded. `entry` itself is not superseded, so the aborted evaluation must be
// repeated against the current `shared` instead of failing the transform.
it('re-evaluates when a dependency is superseded during evaluation', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'wyw-dependency-replaced-')
  );
  const tokensFile = path.join(root, 'tokens.ts');
  const sharedFile = path.join(root, 'shared.ts');
  const entryFile = path.join(root, 'entry.ts');
  const otherFile = path.join(root, 'other.ts');

  fs.writeFileSync(
    tokensFile,
    `export const colors = { red: 'red', blue: 'blue' };`
  );

  const sharedCode = dedent`
    import { colors } from './tokens';

    const mix = (color: string) => color + '-mixed';

    export const accent = mix(colors.red);
    export const extra = mix(colors.blue);
  `;

  const entryCode = dedent`
    import { css } from 'test-css-processor';
    import { accent } from './shared';

    export const entry = css\`
      color: \${accent};
    \`;
  `;

  const otherCode = dedent`
    import { css } from 'test-css-processor';
    import { extra } from './shared';

    export const other = css\`
      color: \${extra};
    \`;
  `;

  fs.writeFileSync(sharedFile, sharedCode);
  fs.writeFileSync(entryFile, entryCode);
  fs.writeFileSync(otherFile, otherCode);

  const cache = new TransformCacheCollection();
  const sharedLoaded = createDeferred();
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

    return resolved;
  };

  const run = (filename: string, code: string, gate: LoadedModuleGate) =>
    transform(
      {
        cache,
        eventEmitter: new LoadedModuleGateEmitter(gate),
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

  const passThrough: LoadedModuleGate = (_id, fn) => fn();

  const entryTransform = run(entryFile, entryCode, (id, fn) => {
    if (id !== sharedFile || held) {
      return fn();
    }

    held = true;
    return Promise.resolve(fn()).then(async (loaded) => {
      sharedLoaded.resolve();
      await releaseShared.promise;
      return loaded;
    }) as ReturnType<typeof fn>;
  });

  const sharedOnly = () =>
    (cache.get('entrypoints', sharedFile) as Entrypoint | undefined)?.only ??
    [];

  await sharedLoaded.promise;
  const loadedShared = cache.get('entrypoints', sharedFile) as Entrypoint;
  const otherTransform = run(otherFile, otherCode, passThrough);
  await waitFor(() => sharedOnly().includes('extra'));
  expect(loadedShared.supersededWith).not.toBeNull();
  releaseShared.resolve();

  try {
    const [entryResult, otherResult] = await Promise.all([
      entryTransform,
      otherTransform,
    ]);

    expect(entryResult.cssText).toContain('color:red-mixed');
    expect(otherResult.cssText).toContain('color:blue-mixed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
