import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createParallelTransforms } from '../adapter';
import { createTransformWorkerPool, TransformWorkerPool } from '../pool';
import { findNonTransferableOption } from '../protocol';

const processorFile = resolve(
  __dirname,
  '..',
  '..',
  '__tests__',
  '__fixtures__',
  'test-css-processor.js'
);

describe('transform worker pool', () => {
  let root: string;
  let configFile: string;
  let pool: TransformWorkerPool;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wyw-worker-pool-'));
    configFile = join(root, 'wyw-in-js.config.cjs');
    // Function options reach workers through the config file.
    writeFileSync(
      configFile,
      `module.exports = {
        tagResolver: (source, tag) =>
          source === 'test-css-processor' && tag === 'css'
            ? ${JSON.stringify(processorFile)}
            : null,
      };\n`
    );
    pool = createTransformWorkerPool({ workers: 2 });
  });

  afterEach(async () => {
    await pool.dispose();
    rmSync(root, { force: true, recursive: true });
  });

  const createScope = () =>
    pool.createScope({
      asyncResolveKey: 'test:resolver',
      pluginOptions: { configFile },
      root,
    });

  it('transforms modules in worker threads', async () => {
    const scope = createScope();
    const resolved: string[] = [];
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((name) =>
        scope.transform({
          asyncResolve: async (what) => {
            resolved.push(what);
            return what === 'test-css-processor' ? processorFile : null;
          },
          code: [
            "import { css } from 'test-css-processor';",
            `export const ${name} = css\`color: red;\`;`,
          ].join('\n'),
          filename: join(root, `${name}.ts`),
        })
      )
    );

    results.forEach((result) => {
      expect(result.code).not.toContain('css`');
      expect(result.cssText).toContain('color:red');
    });
  });

  it('proxies module resolution to the calling thread', async () => {
    const scope = createScope();
    const tokens = join(root, 'tokens.ts');
    writeFileSync(tokens, "export const color = 'blue';\n");
    const requests: Array<[string, string]> = [];

    const result = await scope.transform({
      asyncResolve: async (what, importer) => {
        requests.push([what, importer]);
        if (what === 'test-css-processor') return processorFile;
        if (what === './tokens') return tokens;
        return null;
      },
      code: [
        "import { css } from 'test-css-processor';",
        "import { color } from './tokens';",
        'export const cls = css`color: ${color};`;',
      ].join('\n'),
      filename: join(root, 'entry.ts'),
    });

    expect(result.cssText).toContain('color:blue');
    expect(requests).toContainEqual(['./tokens', join(root, 'entry.ts')]);
  });

  it('rejects with the error raised in the worker', async () => {
    const scope = createScope();

    await expect(
      scope.transform({
        asyncResolve: async () => processorFile,
        code: [
          "import { css } from 'test-css-processor';",
          'export const broken = css`color: red;` +;',
        ].join('\n'),
        filename: join(root, 'broken.ts'),
      })
    ).rejects.toThrow();
  });

  it('returns roots without processors unchanged', async () => {
    const scope = createScope();
    const code = 'export const answer: number = 42;';

    const result = await scope.transform({
      asyncResolve: async () => null,
      code,
      filename: join(root, 'plain.ts'),
    });

    expect(result.code).toBe(code);
    expect(result.cssText).toBeUndefined();
  });

  it('fails jobs instead of respawning workers that cannot start', async () => {
    const workerFile = join(root, 'broken-worker.mjs');
    writeFileSync(workerFile, "throw new Error('cannot load');\n");
    const brokenPool = new TransformWorkerPool({
      workerUrl: pathToFileURL(workerFile),
      workers: 2,
    });
    const scope = brokenPool.createScope({
      asyncResolveKey: 'test:resolver',
      pluginOptions: { configFile },
      root,
    });
    const job = {
      asyncResolve: async () => null,
      code: 'export {}',
      filename: join(root, 'never.ts'),
    };

    await expect(scope.transform(job)).rejects.toThrow(
      'transform worker failed to start: cannot load'
    );
    await expect(scope.transform(job)).rejects.toThrow('failed to start');
    await brokenPool.dispose();
  });

  it('finishes running jobs and rejects new ones after disposal', async () => {
    const scope = createScope();
    const running = scope.transform({
      asyncResolve: async () => processorFile,
      code: [
        "import { css } from 'test-css-processor';",
        'export const late = css`color: green;`;',
      ].join('\n'),
      filename: join(root, 'running.ts'),
    });
    const disposed = pool.dispose();

    expect(() =>
      scope.transform({
        asyncResolve: async () => null,
        code: 'export {}',
        filename: join(root, 'late.ts'),
      })
    ).toThrow('disposed');
    expect((await running).cssText).toContain('color:green');
    await disposed;
  });
});

describe('createParallelTransforms', () => {
  const config = (pluginOptions: Record<string, unknown>) => () => ({
    asyncResolveKey: 'test:resolver',
    pluginOptions,
    root: tmpdir(),
  });

  it('is disabled unless requested', () => {
    expect(createParallelTransforms({ parallel: false })).toBeNull();
    expect(createParallelTransforms({ parallel: 0 })).toBeNull();
  });

  it('reports adapter reasons to stay on the calling thread', () => {
    const onFallback = jest.fn();

    expect(
      createParallelTransforms({
        onFallback,
        parallel: true,
        unsupported: 'the debug option is set',
      })
    ).toBeNull();
    expect(onFallback).toHaveBeenCalledWith(
      'Transforms run on the main thread because the debug option is set.'
    );
  });

  it('keeps scopes with function options on the calling thread', async () => {
    const onFallback = jest.fn();
    const parallel = createParallelTransforms({ onFallback, parallel: 1 })!;
    const options = { classNameSlug: () => 'slug' };

    expect(parallel.scope('client', config(options))).toBeNull();
    expect(parallel.scope('ssr', config(options))).toBeNull();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][0]).toContain('`classNameSlug`');
    await parallel.dispose();
  });

  it('creates one worker scope per key', async () => {
    const parallel = createParallelTransforms({ parallel: 1 })!;
    const scope = parallel.scope('client', config({ displayName: true }));

    expect(scope).not.toBeNull();
    expect(parallel.scope('client', config({ displayName: false }))).toBe(
      scope
    );
    expect(parallel.scope('ssr', config({}))).not.toBe(scope);
    await parallel.dispose();
  });
});

describe('findNonTransferableOption', () => {
  it('reports the first function-valued option', () => {
    expect(
      findNonTransferableOption({
        displayName: true,
        eval: { globals: { fn: () => 1 } },
      })
    ).toBe('eval.globals.fn');
  });

  it('accepts plain data and regular expressions', () => {
    expect(
      findNonTransferableOption({
        classNameSlug: '[name]',
        features: { happyDOM: false },
        ignore: /node_modules/,
        importOverrides: { react: { mock: './react.ts' } },
      })
    ).toBeNull();
  });
});
