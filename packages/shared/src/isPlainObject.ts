/**
 * Checks for an object literal, an `Object.create(null)` object, or a plain
 * object created in another realm (e.g. returned from a `vm` context, whose
 * `Object.prototype` is not ours but has a `null` prototype itself).
 * Arrays, functions and class instances (`Date`, `Map`, …) are rejected.
 */
export const isPlainObject = (
  value: unknown
): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype === null || prototype === Object.prototype) {
    return true;
  }

  return Object.getPrototypeOf(prototype) === null;
};

/**
 * Prepares a value for `JSON.stringify`-based hashing: plain objects get
 * their keys sorted recursively, so key order does not change the hash.
 * Anything else is left to `JSON.stringify` (including `toJSON`).
 */
export const canonicalizeForHash = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForHash(item));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeForHash(value[key])])
    );
  }

  return value;
};
