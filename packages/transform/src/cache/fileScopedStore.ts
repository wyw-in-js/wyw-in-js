import { stripQueryAndHash } from '../utils/parseRequest';

/**
 * Names a store of a `TransformCacheCollection` and carries the type of its
 * entries, so the collection can own entries whose shape it does not know.
 */
export interface FileScopedStoreToken<TValue> {
  readonly name: string;
  /** Never set: only carries the entry type. */
  readonly entryType?: TValue;
}

export const defineFileScopedStore = <TValue>(
  name: string
): FileScopedStoreToken<TValue> => Object.freeze({ name });

/**
 * Entries grouped by the file they were computed for, without query and hash,
 * so that every entry of a file can be forgotten at once when it changes.
 */
export class FileScopedStore<TValue> {
  private readonly files = new Map<string, Map<string, TValue>>();

  public get(filename: string, key: string): TValue | undefined {
    return this.files.get(stripQueryAndHash(filename))?.get(key);
  }

  public set(filename: string, key: string, value: TValue): void {
    const file = stripQueryAndHash(filename);
    let entries = this.files.get(file);
    if (!entries) {
      entries = new Map();
      this.files.set(file, entries);
    }

    entries.set(key, value);
  }

  public delete(filename: string, key: string): void {
    const file = stripQueryAndHash(filename);
    const entries = this.files.get(file);
    if (!entries) return;

    entries.delete(key);
    if (entries.size === 0) {
      this.files.delete(file);
    }
  }

  public forgetFile(filename: string): void {
    this.files.delete(stripQueryAndHash(filename));
  }
}
