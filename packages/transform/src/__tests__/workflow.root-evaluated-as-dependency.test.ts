import fs from 'fs';
import os from 'os';
import path from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
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

type EvalFileGate = <TRes>(fn: () => TRes) => TRes;

class EvalFileGateEmitter extends EventEmitter {
  constructor(private readonly gate: EvalFileGate) {
    super(
      () => {},
      () => 0,
      () => {},
      false
    );
  }

  public perf<TRes>(method: string, fn: () => TRes): TRes {
    if (method === 'transform:evalFile') {
      return this.gate(fn);
    }

    return super.perf(method, fn);
  }
}

// `shared` is a root of its own and also a dependency of `entry`. `entry`
// evaluates first and publishes an evaluated copy of `shared` into the cache.
// `shared` is not superseded by that copy, so its own evaluation must still
// succeed instead of failing on the replaced cache entry.
it('evaluates a root after another root evaluated it as a dependency', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'wyw-root-as-dependency-')
  );
  const tokensFile = path.join(root, 'tokens.ts');
  const sharedFile = path.join(root, 'shared.ts');
  const entryFile = path.join(root, 'entry.ts');

  fs.writeFileSync(tokensFile, `export const colors = { red: 'red' };`);

  // `accent` is not statically evaluable, so `entry` must evaluate `shared`.
  const sharedCode = dedent`
    import { css } from 'test-css-processor';
    import { colors } from './tokens';

    const mix = (color: string) => color + '-mixed';

    export const accent = mix(colors.red);

    export const shared = css\`
      color: \${accent};
    \`;
  `;

  const entryCode = dedent`
    import { css } from 'test-css-processor';
    import { accent } from './shared';

    export const entry = css\`
      background: \${accent};
    \`;
  `;

  fs.writeFileSync(sharedFile, sharedCode);
  fs.writeFileSync(entryFile, entryCode);

  const cache = new TransformCacheCollection();
  const entryEvaluated = createDeferred();

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

  const run = (filename: string, code: string, gate: EvalFileGate) =>
    transform(
      {
        cache,
        eventEmitter: new EvalFileGateEmitter(gate),
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

  const sharedTransform = run(
    sharedFile,
    sharedCode,
    (fn) => entryEvaluated.promise.then(fn) as ReturnType<typeof fn>
  );
  const entryTransform = run(entryFile, entryCode, (fn) => {
    const result = fn();
    Promise.resolve(result).finally(entryEvaluated.resolve);
    return result;
  });

  try {
    const [sharedResult, entryResult] = await Promise.all([
      sharedTransform,
      entryTransform,
    ]);

    expect(sharedResult.cssText).toContain('color:red-mixed');
    expect(entryResult.cssText).toContain('background:red-mixed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
