/**
 * `T` without the `undefined` its entries may hold. A record keeps its index
 * signature as is: an optional index signature would add `undefined` back.
 */
export type DefinedEntries<T> = string extends keyof T
  ? { [K in keyof T]: Exclude<T[K], undefined> }
  : { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * Copies the entries of an options object whose value is not `undefined`.
 * Options are merged by spreading, and an option set to `undefined` means
 * "not set": it must not replace a default or a value from the config file.
 */
export const omitUndefined = <T extends object>(
  value: T | null | undefined
): DefinedEntries<T> => {
  const defined: Record<string, unknown> = {};
  if (value) {
    Object.entries(value).forEach(([key, entry]) => {
      if (entry !== undefined) {
        defined[key] = entry;
      }
    });
  }

  return defined as DefinedEntries<T>;
};
