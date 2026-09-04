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

const runNonConvergingTransform = (
  cache: TransformCacheCollection,
  attempts: Attempt[],
  softErrors = false
) =>
  transform(
    {
      asyncResolveKey: 'cache-epoch-retry-test',
      cache,
      options: {
        filename: '/abs/entry.ts',
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
      workflow: createRecoveryWorkflow(attempts),
    } as Parameters<typeof transform>[3]
  );

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
});
