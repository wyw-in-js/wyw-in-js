export const CACHE_RECOVERY_DID_NOT_CONVERGE =
  'WYW_CACHE_RECOVERY_DID_NOT_CONVERGE';

export class CacheRecoveryConvergenceError extends Error {
  public readonly code = CACHE_RECOVERY_DID_NOT_CONVERGE;

  public readonly name = 'CacheRecoveryConvergenceError';

  constructor(filename: string, attempts: number, cause: Error) {
    super(
      `[wyw-in-js] Transform cache recovery for ${filename} did not converge after ${attempts} retries.`,
      { cause }
    );
  }
}

export const isCacheRecoveryConvergenceError = (
  value: unknown
): value is CacheRecoveryConvergenceError =>
  value instanceof CacheRecoveryConvergenceError ||
  (value !== null &&
    typeof value === 'object' &&
    (value as { code?: unknown }).code === CACHE_RECOVERY_DID_NOT_CONVERGE);
