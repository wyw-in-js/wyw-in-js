import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';
import type { Entrypoint } from '../transform/Entrypoint';
import type { Services } from '../transform/types';

type Attempt = {
  actionContext: unknown;
  entrypoint: Entrypoint;
  services: Services;
};

const createRecoveryWorkflow = (attempts: Attempt[]) =>
  // eslint-disable-next-line require-yield
  function* recoveryWorkflow(this: {
    actionContext: unknown;
    entrypoint: Entrypoint;
    services: Services;
  }) {
    attempts.push({
      actionContext: this.actionContext,
      entrypoint: this.entrypoint,
      services: this.services,
    });
    const recovery = this.services.cache.startUnknownGraphRecovery(
      this.entrypoint.name,
      new Set(['/abs/missing.ts']),
      this.entrypoint.originalCode,
      this.entrypoint.graphTraversalToken
    );
    recovery.complete();
    throw recovery.abortError;
  };

const runTransformWithWorkflow = (
  cache: TransformCacheCollection,
  workflow: unknown,
  softErrors = false,
  filename = '/abs/entry.ts'
) =>
  transform(
    {
      asyncResolveKey: 'cache-epoch-retry-test',
      cache,
      options: {
        filename,
        root: '/abs',
        pluginOptions: {
          configFile: false,
          features: { globalCache: true, softErrors },
        },
      },
    },
    'export default 1;',
    async () => null,
    {
      workflow,
    } as Parameters<typeof transform>[3]
  );

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
};

const runNonConvergingTransform = (
  cache: TransformCacheCollection,
  attempts: Attempt[],
  softErrors = false
) =>
  runTransformWithWorkflow(cache, createRecoveryWorkflow(attempts), softErrors);

describe('transform cache recovery retries', () => {
  it('retries the whole transform three times and then fails convergence', async () => {
    const cache = new TransformCacheCollection();
    const attempts: Attempt[] = [];
    const acquireKeySalt = jest.spyOn(cache, 'acquireKeySalt');

    try {
      await expect(
        runNonConvergingTransform(cache, attempts)
      ).rejects.toMatchObject({
        code: 'WYW_CACHE_RECOVERY_DID_NOT_CONVERGE',
      });

      expect(attempts).toHaveLength(4);
      expect(new Set(attempts.map(({ services }) => services)).size).toBe(4);
      expect(new Set(attempts.map(({ entrypoint }) => entrypoint)).size).toBe(
        4
      );
      expect(
        new Set(attempts.map(({ actionContext }) => actionContext)).size
      ).toBe(4);
      expect(acquireKeySalt).toHaveBeenCalledTimes(1);
    } finally {
      acquireKeySalt.mockRestore();
      disposeEvalBroker(cache);
    }
  });

  it('applies softErrors only after the recovery budget is exhausted', async () => {
    const cache = new TransformCacheCollection();
    const attempts: Attempt[] = [];
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    try {
      await expect(
        runNonConvergingTransform(cache, attempts, true)
      ).resolves.toMatchObject({ code: 'export default 1;' });
      expect(attempts).toHaveLength(4);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls[0][1]).toMatchObject({
        code: 'WYW_CACHE_RECOVERY_DID_NOT_CONVERGE',
      });
    } finally {
      consoleError.mockRestore();
      disposeEvalBroker(cache);
    }
  });

  it('does not retry an epoch abort owned by another cache', async () => {
    const cache = new TransformCacheCollection();
    const foreignCache = new TransformCacheCollection();
    const foreignEpoch = foreignCache.getCurrentEpoch();
    const recovery = foreignCache.startUnknownGraphRecovery(
      '/abs/foreign.ts',
      new Set(['/abs/missing.ts']),
      'export default 1;',
      foreignCache.createGraphTraversalToken(foreignEpoch)
    );
    recovery.complete();
    const workflow = jest.fn(
      // eslint-disable-next-line require-yield
      function* throwForeignEpochAbort() {
        throw recovery.abortError;
      }
    );

    try {
      await expect(runTransformWithWorkflow(cache, workflow)).rejects.toBe(
        recovery.abortError
      );
      expect(workflow).toHaveBeenCalledTimes(1);
    } finally {
      disposeEvalBroker(cache);
      disposeEvalBroker(foreignCache);
    }
  });

  it('does not retry a user error shaped like an epoch abort', async () => {
    const cache = new TransformCacheCollection();
    const userError = Object.assign(new Error('user epoch-shaped error'), {
      code: 'WYW_CACHE_EPOCH_ABORTED',
      fromEpoch: 0,
      reason: 'unknown-dependency-graph',
      toEpoch: 1,
    });
    const workflow = jest.fn(
      // eslint-disable-next-line require-yield
      function* throwUserError() {
        throw userError;
      }
    );

    try {
      await expect(runTransformWithWorkflow(cache, workflow)).rejects.toBe(
        userError
      );
      expect(workflow).toHaveBeenCalledTimes(1);
    } finally {
      disposeEvalBroker(cache);
    }
  });

  it('does not spend a healthy root retry budget on other roots recoveries', async () => {
    const cache = new TransformCacheCollection();
    let attemptStarted = createDeferred();
    let releaseAttempt = createDeferred();
    let healthyAttempts = 0;
    // eslint-disable-next-line require-yield
    const healthyWorkflow = async function* healthyWorkflow() {
      healthyAttempts += 1;
      const started = attemptStarted;
      const release = releaseAttempt;
      started.resolve();
      await release.promise;
      return { code: 'healthy', sourceMap: null };
    };
    const healthy = runTransformWithWorkflow(
      cache,
      healthyWorkflow as never,
      false,
      '/abs/healthy.ts'
    );

    try {
      for (let recoveryIndex = 0; recoveryIndex < 4; recoveryIndex += 1) {
        // eslint-disable-next-line no-await-in-loop
        await attemptStarted.promise;
        const currentRelease = releaseAttempt;
        attemptStarted = createDeferred();
        releaseAttempt = createDeferred();
        let recovered = false;
        // eslint-disable-next-line require-yield
        const foreignWorkflow = function* foreignWorkflow(this: Attempt) {
          if (!recovered) {
            recovered = true;
            const recovery = cache.startUnknownGraphRecovery(
              this.entrypoint.name,
              new Set(['/abs/foreign-missing.ts']),
              this.entrypoint.originalCode,
              this.entrypoint.graphTraversalToken
            );
            recovery.complete();
            throw recovery.abortError;
          }

          return { code: 'foreign', sourceMap: null };
        };

        // eslint-disable-next-line no-await-in-loop
        await expect(
          runTransformWithWorkflow(
            cache,
            foreignWorkflow,
            false,
            `/abs/foreign-${recoveryIndex}.ts`
          )
        ).resolves.toMatchObject({ code: 'foreign' });
        currentRelease.resolve();
      }

      const outcome = await Promise.race([
        attemptStarted.promise.then(() => ({ kind: 'retry' as const })),
        healthy.then(
          () => ({ kind: 'completed' as const }),
          (error: unknown) => ({ error, kind: 'failed' as const })
        ),
      ]);
      expect(outcome).toEqual({ kind: 'retry' });
      releaseAttempt.resolve();
      await expect(healthy).resolves.toMatchObject({ code: 'healthy' });
      expect(healthyAttempts).toBe(5);
    } finally {
      releaseAttempt.resolve();
      disposeEvalBroker(cache);
    }
  });
});
