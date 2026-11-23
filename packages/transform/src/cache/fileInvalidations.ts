import { stripQueryAndHash } from '@wyw-in-js/shared';

/** Invalidations of files, and which of them consumers have already seen. */
export class FileInvalidations {
  private readonly consumedVersions = new Map<string, number>();

  /**
   * Files invalidated through `invalidateForFile`, e.g. by a dev server. Kept
   * until the freshness state is reset, like the change versions: no later
   * read proves that every earlier consumer saw the recorded disk bytes. Not
   * even a read of the bytes the file had when it was invalidated does: an
   * edit read by a new importer in between may have been reverted.
   */
  private readonly explicitFiles = new Set<string>();

  private readonly versions = new Map<string, number>();

  public clear(): void {
    this.consumedVersions.clear();
    this.explicitFiles.clear();
    this.versions.clear();
  }

  public consume(filename: string): boolean {
    const version = this.versions.get(stripQueryAndHash(filename));
    if (version === undefined) return false;

    const consumedVersion = this.consumedVersions.get(filename) ?? 0;
    if (consumedVersion >= version) return false;

    this.consumedVersions.set(filename, version);
    return true;
  }

  public isExplicit(filename: string): boolean {
    return this.explicitFiles.has(stripQueryAndHash(filename));
  }

  /** A new version for `consume`: every eviction, and lifecycle recovery. */
  public mark(filename: string): void {
    const key = stripQueryAndHash(filename);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  /** Records an `invalidateForFile` call; see `explicitFiles`. */
  public markExplicit(filename: string): void {
    this.explicitFiles.add(stripQueryAndHash(filename));
  }
}
