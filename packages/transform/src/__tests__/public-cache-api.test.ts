import {
  CACHE_EPOCH_ABORTED,
  CACHE_KEY_SALT_BUSY,
  CACHE_RECOVERY_DID_NOT_CONVERGE,
  CacheEpochAbortedError,
  CacheKeySaltBusyError,
  CacheRecoveryConvergenceError,
  isCacheEpochAbortedError,
  isCacheKeySaltBusyError,
  isCacheRecoveryConvergenceError,
  TransformCacheCollection,
} from '../index';
import type { CacheRecoveryReason } from '../index';

describe('public transform cache API', () => {
  it('exports the errors that can escape transform', () => {
    const cache = new TransformCacheCollection();
    const lifecycleVersion = cache.getLifecycleVersion();
    const reason: CacheRecoveryReason = 'unknown-dependency-graph';
    const cause = new Error('cache recovery');
    const aborted = new CacheEpochAbortedError(0, 1, reason, cause);
    const busy = new CacheKeySaltBusyError();
    const convergence = new CacheRecoveryConvergenceError(
      '/entry.ts',
      1,
      aborted
    );

    expect(cache.getRecoveryError('/entry.ts', lifecycleVersion)).toBeNull();
    expect(
      cache.getScopedRecoveryError(lifecycleVersion, new Set(['/entry.ts']))
    ).toBeUndefined();
    expect(aborted.code).toBe(CACHE_EPOCH_ABORTED);
    expect(busy.code).toBe(CACHE_KEY_SALT_BUSY);
    expect(convergence.code).toBe(CACHE_RECOVERY_DID_NOT_CONVERGE);
    expect(isCacheEpochAbortedError(aborted)).toBe(true);
    expect(isCacheKeySaltBusyError(busy)).toBe(true);
    expect(isCacheRecoveryConvergenceError(convergence)).toBe(true);
  });
});
