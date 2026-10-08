import { createHash } from 'node:crypto';

/**
 * SHA-256 digests of source content, hex-encoded. The transform cache uses
 * them to decide freshness; diagnostics may reuse them for their own revision
 * keys. A digest is a pure function of the content, so a memo can only save
 * hashing work and never needs invalidation, only a retention bound.
 */

export type ContentHashMemoLimits = {
  /** Maximum number of retained digests. */
  maxEntries: number;
  /** Content longer than this (in UTF-16 code units) is hashed, not retained. */
  maxEntryCodeUnits: number;
  /**
   * Upper bound on the summed length of retained content. This is an explicit
   * retention bound, not an estimate of the strings' allocated memory.
   */
  maxTotalCodeUnits: number;
};

// Sized for a medium build observed across many roots without repeatedly
// hashing the same revision, while keeping retention bounded.
const DEFAULT_LIMITS: ContentHashMemoLimits = {
  maxEntries: 4_096,
  maxEntryCodeUnits: 64 * 1024,
  maxTotalCodeUnits: 16 * 1024 * 1024,
};

const sha256Hex = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

/** Bounded content → digest memo; the oldest digests are evicted first. */
export class ContentHashMemo {
  private readonly digests = new Map<string, string>();

  private readonly limits: ContentHashMemoLimits;

  private retainedCodeUnits = 0;

  constructor(limits: Partial<ContentHashMemoLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  get size(): number {
    return this.digests.size;
  }

  clear(): void {
    this.digests.clear();
    this.retainedCodeUnits = 0;
  }

  has(content: string): boolean {
    return this.digests.has(content);
  }

  hash(content: string): string {
    const known = this.digests.get(content);
    if (known !== undefined) return known;

    const digest = sha256Hex(content);
    this.remember(content, digest);
    return digest;
  }

  private remember(content: string, digest: string): void {
    const { maxEntries, maxEntryCodeUnits, maxTotalCodeUnits } = this.limits;
    const { length } = content;
    if (length > maxEntryCodeUnits || length > maxTotalCodeUnits) return;

    while (
      this.digests.size > 0 &&
      (this.digests.size >= maxEntries ||
        this.retainedCodeUnits + length > maxTotalCodeUnits)
    ) {
      const oldest = this.digests.keys().next().value!;
      this.digests.delete(oldest);
      this.retainedCodeUnits -= oldest.length;
    }

    this.digests.set(content, digest);
    this.retainedCodeUnits += length;
  }
}

// The shared memo is owned by this module and lives only while at least one
// lease is held: consumers that repeatedly hash the same content (for example
// pipeline diagnostics, which key revisions by the same digests) retain it for
// their lifetime. Without a lease `hashContent` hashes directly.
const sharedMemo = new ContentHashMemo();
let sharedMemoLeases = 0;

/**
 * Keeps the shared digest memo alive until the returned release is called.
 * Release is idempotent; the memo is cleared when the last lease is released.
 */
export const retainContentHashMemo = (): (() => void) => {
  sharedMemoLeases += 1;
  let retained = true;

  return () => {
    if (!retained) return;
    retained = false;
    sharedMemoLeases -= 1;
    if (sharedMemoLeases === 0) {
      sharedMemo.clear();
    }
  };
};

export const hashContent = (content: string): string =>
  sharedMemoLeases === 0 ? sha256Hex(content) : sharedMemo.hash(content);
