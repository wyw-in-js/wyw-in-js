import { isCacheEpochAbortedError } from './CacheEpochAbortedError';
import { isCacheKeySaltBusyError } from './CacheKeySaltBusyError';
import { isCacheRecoveryConvergenceError } from './CacheRecoveryConvergenceError';

const cacheRecoveryFenceErrors = new WeakSet<object>();

/** @internal Marks an error produced by a transactional lifecycle fence. */
export const markCacheRecoveryFenceError = <T>(error: T): T => {
  if (
    (typeof error === 'object' && error !== null) ||
    typeof error === 'function'
  ) {
    cacheRecoveryFenceErrors.add(error);
  }

  return error;
};

/** @internal Lifecycle fence failures must never enter user catch continuations. */
export const isCacheRecoveryFenceError = (error: unknown): boolean =>
  ((typeof error === 'object' && error !== null) ||
    typeof error === 'function') &&
  cacheRecoveryFenceErrors.has(error);

export const isCacheRecoveryControlError = (error: unknown): boolean => {
  if (
    isCacheEpochAbortedError(error) ||
    isCacheKeySaltBusyError(error) ||
    isCacheRecoveryConvergenceError(error)
  ) {
    return true;
  }

  if (error === null || typeof error !== 'object') {
    return false;
  }

  const code = String((error as { code?: unknown }).code);
  return (
    code === 'WYW_SUPERSEDE_STORM' ||
    code === 'WYW_UNKNOWN_DEPENDENCY_GRAPH_RESET'
  );
};
