export const CACHE_KEY_SALT_BUSY = 'WYW_CACHE_KEY_SALT_BUSY';

export class CacheKeySaltBusyError extends Error {
  public readonly code = CACHE_KEY_SALT_BUSY;

  public readonly name = 'CacheKeySaltBusyError';

  constructor() {
    super(
      '[wyw-in-js] Cannot change the transform cache key while another transform is using it.'
    );
  }
}

export const isCacheKeySaltBusyError = (
  value: unknown
): value is CacheKeySaltBusyError =>
  value instanceof CacheKeySaltBusyError ||
  (value !== null &&
    typeof value === 'object' &&
    (value as { code?: unknown }).code === CACHE_KEY_SALT_BUSY);
