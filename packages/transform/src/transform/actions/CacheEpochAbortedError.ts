export const CACHE_EPOCH_ABORTED = 'WYW_CACHE_EPOCH_ABORTED';

export type CacheRecoveryReason =
  | 'cache-key-salt-change'
  | 'evaluation-side-effect'
  | 'supersede-storm'
  | 'unknown-dependency-graph';

export class CacheEpochAbortedError extends Error {
  public readonly code = CACHE_EPOCH_ABORTED;

  public readonly name = 'CacheEpochAbortedError';

  constructor(
    public readonly fromEpoch: number,
    public readonly toEpoch: number,
    public readonly reason: CacheRecoveryReason,
    cause: Error,
    /** @internal Stable transform lineage that initiated this recovery. */
    public readonly recoveryOwner?: object
  ) {
    super(
      `[wyw-in-js] Transform cache epoch ${fromEpoch} was replaced by ${toEpoch}; the attempt must restart.`,
      { cause }
    );
  }
}

export const isCacheEpochAbortedError = (
  value: unknown
): value is CacheEpochAbortedError =>
  value instanceof CacheEpochAbortedError ||
  (value !== null &&
    typeof value === 'object' &&
    (value as { code?: unknown }).code === CACHE_EPOCH_ABORTED &&
    typeof (value as { fromEpoch?: unknown }).fromEpoch === 'number' &&
    typeof (value as { toEpoch?: unknown }).toEpoch === 'number');
