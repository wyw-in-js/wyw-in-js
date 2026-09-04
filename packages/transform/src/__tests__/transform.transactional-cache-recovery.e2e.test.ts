import fs from 'fs';
import os from 'os';
import path from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker, EvalBroker } from '../eval/broker';
import { transform } from '../transform';
import { baseHandlers } from '../transform/generators';

const processorFile = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
};

const resolveWithExtensions = (candidate: string) => {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs']) {
    const withExtension = `${candidate}${extension}`;
    if (fs.existsSync(withExtension) && fs.statSync(withExtension).isFile()) {
      return withExtension;
    }
  }

  return null;
};

it('restarts a whole transform after an unrelated recovery aborts its blocked LOAD', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-transactional-recovery-'))
  );
  const activeFile = path.join(root, 'active.ts');
  const slowFile = path.join(root, 'slow.ts');
  const recoveryFile = path.join(root, 'recovery.ts');
  const recoveryDependencyFile = path.join(root, 'recovery-dependency.ts');

  const activeCode = dedent`
    import { css } from 'test-css-processor';
    import { color } from './slow';

    export const active = css\`
      color: \${color};
    \`;
  `;
  const recoveryCode = dedent`
    import { css } from 'test-css-processor';
    import { color } from './recovery-dependency';

    export const recovery = css\`
      color: \${color};
    \`;
  `;

  fs.writeFileSync(activeFile, activeCode);
  fs.writeFileSync(slowFile, `export const color = 'disk';\n`);
  fs.writeFileSync(recoveryFile, recoveryCode);
  fs.writeFileSync(recoveryDependencyFile, `export const color = 'blue';\n`);

  const cache = new TransformCacheCollection();
  const firstSlowLoadStarted = createDeferred();
  const releaseFirstSlowLoad = createDeferred();
  const firstSlowLoadReturned = createDeferred();
  let slowLoadCount = 0;
  const customLoader = jest.fn(async (id: string) => {
    if (id !== slowFile) {
      return null;
    }

    slowLoadCount += 1;
    if (slowLoadCount === 1) {
      firstSlowLoadStarted.resolve();
      await releaseFirstSlowLoad.promise;
      firstSlowLoadReturned.resolve();
      return { code: `export const color = 'stale';` };
    }

    return { code: `export const color = 'fresh';` };
  });
  const asyncResolve = async (what: string, importer: string) => {
    if (what === 'test-css-processor') {
      return processorFile;
    }

    if (what.startsWith('.') || path.isAbsolute(what)) {
      const resolved = resolveWithExtensions(
        path.resolve(path.dirname(importer), what)
      );
      if (resolved) {
        return resolved;
      }
    }

    throw new Error(
      `Unexpected resolve ${JSON.stringify(what)} from ${importer}`
    );
  };
  const pluginOptions = {
    configFile: false as const,
    tagResolver: (source: string, tag: string) =>
      source === 'test-css-processor' && tag === 'css' ? processorFile : null,
    eval: {
      customLoader,
      strategy: 'execute' as const,
    },
    babelOptions: {
      babelrc: false,
      configFile: false,
      presets: [
        ['@babel/preset-env', { loose: true }],
        '@babel/preset-typescript',
      ],
    },
  };

  const run = (
    filename: string,
    customHandlers: Parameters<typeof transform>[3] = {}
  ) =>
    transform(
      {
        asyncResolveKey: 'transactional-cache-recovery-test:v1',
        cache,
        options: { filename, root, pluginOptions },
      },
      fs.readFileSync(filename, 'utf8'),
      asyncResolve,
      customHandlers
    );

  const activeAttempts: Array<{ actionContext: unknown; entrypoint: object }> =
    [];
  const observedWorkflow = function* observedWorkflow(this: unknown) {
    const action = this as {
      actionContext: unknown;
      entrypoint: { name: string };
    };
    if (action.entrypoint.name === activeFile) {
      activeAttempts.push({
        actionContext: action.actionContext,
        entrypoint: action.entrypoint,
      });
    }

    return yield* baseHandlers.workflow.call(this as never);
  };
  const originalEvaluate = EvalBroker.prototype.evaluate;
  let observedBroker: EvalBroker | undefined;
  const evaluateSpy = jest
    .spyOn(EvalBroker.prototype, 'evaluate')
    .mockImplementation(function captureBroker(...args) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      observedBroker = this;
      return originalEvaluate.apply(this, args);
    });
  let activeTransform: ReturnType<typeof run> | undefined;
  let recoveryTransform: ReturnType<typeof run> | undefined;

  try {
    // Build one complete root, then model the production state that starts an
    // unknown-graph recovery: its completed graph owner is still cached, but
    // the dependency entrypoint and retained snapshots have been evicted.
    const warmRecovery = await run(recoveryFile);
    expect(warmRecovery.cssText).toContain('color:blue');
    const cachedRecovery = cache.get('entrypoints', recoveryFile);
    expect(cachedRecovery).toBeDefined();
    expect(
      [...cachedRecovery!.dependencies.values()].some(
        ({ resolved }) => resolved === recoveryDependencyFile
      )
    ).toBe(true);
    cache.clear('entrypoints');
    cache.add('entrypoints', recoveryFile, cachedRecovery!);

    activeTransform = run(activeFile, { workflow: observedWorkflow });
    // Keep a rejection handler attached while the recovery below aborts the
    // first broker generation synchronously.
    activeTransform.catch(() => undefined);
    await firstSlowLoadStarted.promise;

    const lifecycleBeforeRecovery = cache.getLifecycleVersion();
    recoveryTransform = run(recoveryFile);

    const [activeResult, recoveryResult] = await Promise.all([
      activeTransform,
      recoveryTransform,
    ]);

    expect(cache.getLifecycleVersion()).toBe(lifecycleBeforeRecovery + 1);
    expect(recoveryResult.cssText).toContain('color:blue');
    expect(activeResult.cssText).toContain('color:fresh');
    expect(activeResult.cssText).not.toContain('color:stale');
    expect(slowLoadCount).toBe(2);

    // Retrying only broker.evaluate() or recursively restarting workflow is
    // insufficient: the retry must own a fresh root and ActionContext.
    expect(activeAttempts).toHaveLength(2);
    expect(activeAttempts[1].entrypoint).not.toBe(activeAttempts[0].entrypoint);
    expect(activeAttempts[1].actionContext).not.toBe(
      activeAttempts[0].actionContext
    );

    expect(observedBroker).toBeDefined();
    const privateBroker = observedBroker as unknown as {
      loadCache: {
        peek: (id: string) => { code: string } | undefined;
      };
    };
    const freshPrepared = privateBroker.loadCache.peek(slowFile);
    expect(freshPrepared?.code).toContain(`color = 'fresh'`);

    // The loader from the retired generation finishes after the replacement
    // transform committed. Its stale result must not replace broker state.
    releaseFirstSlowLoad.resolve();
    await firstSlowLoadReturned.promise;
    await new Promise<void>((resolveImmediate) => {
      setImmediate(resolveImmediate);
    });

    expect(privateBroker.loadCache.peek(slowFile)).toBe(freshPrepared);
    expect(privateBroker.loadCache.peek(slowFile)?.code).not.toContain('stale');
  } finally {
    releaseFirstSlowLoad.resolve();
    await Promise.allSettled(
      [activeTransform, recoveryTransform].filter(
        (promise): promise is Promise<unknown> => promise !== undefined
      )
    );
    evaluateSpy.mockRestore();
    disposeEvalBroker(cache);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
