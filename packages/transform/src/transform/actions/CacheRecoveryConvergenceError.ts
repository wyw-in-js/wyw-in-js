export const CACHE_RECOVERY_DID_NOT_CONVERGE =
  'WYW_CACHE_RECOVERY_DID_NOT_CONVERGE';

export class CacheRecoveryConvergenceError extends Error {
  public readonly code = CACHE_RECOVERY_DID_NOT_CONVERGE;

  public readonly name = 'CacheRecoveryConvergenceError';

  public readonly ownedRetries: number;

  public readonly totalRetries: number;

  public readonly limit: 'owned' | 'total';

  constructor(
    filename: string,
    attempts: number,
    cause: Error,
    details?: { totalRetries: number; limit: 'owned' | 'total' }
  ) {
    const totalRetries = details?.totalRetries ?? attempts;
    const limit = details?.limit ?? 'owned';
    super(
      limit === 'total'
        ? `[wyw-in-js] Transform cache recovery for ${filename} did not converge after ${totalRetries} total retries (${attempts} owned); other transforms kept retiring its cache epoch.`
        : `[wyw-in-js] Transform cache recovery for ${filename} did not converge after ${attempts} retries.`,
      { cause }
    );
    this.ownedRetries = attempts;
    this.totalRetries = totalRetries;
    this.limit = limit;
  }
}

export const isCacheRecoveryConvergenceError = (
  value: unknown
): value is CacheRecoveryConvergenceError =>
  value instanceof CacheRecoveryConvergenceError ||
  (value !== null &&
    typeof value === 'object' &&
    (value as { code?: unknown }).code === CACHE_RECOVERY_DID_NOT_CONVERGE);
