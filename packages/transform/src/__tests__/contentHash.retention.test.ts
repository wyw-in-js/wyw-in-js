import { createHash } from 'crypto';

import {
  ContentHashMemo,
  hashContent,
  retainContentHashMemo,
} from '../utils/contentHash';

// The default bound on the length of content whose digest is retained.
const MAX_RETAINED_CODE_UNITS = 64 * 1024;

const sha256Hex = (content: string) =>
  createHash('sha256').update(content).digest('hex');

const contentOfLength = (length: number, seed: string) =>
  `${seed}:`.padEnd(length, 'x');

describe('content hash retention', () => {
  it('retains the digest of content up to 64K code units and no longer', () => {
    const memo = new ContentHashMemo();
    const atBound = contentOfLength(MAX_RETAINED_CODE_UNITS, 'at-bound');
    const overBound = contentOfLength(MAX_RETAINED_CODE_UNITS + 1, 'over');

    expect(atBound).toHaveLength(MAX_RETAINED_CODE_UNITS);
    expect(overBound).toHaveLength(MAX_RETAINED_CODE_UNITS + 1);

    expect(memo.hash(atBound)).toBe(sha256Hex(atBound));
    expect(memo.hash(overBound)).toBe(sha256Hex(overBound));

    expect(memo.has(atBound)).toBe(true);
    expect(memo.has(overBound)).toBe(false);
    expect(memo.size).toBe(1);
  });

  it('hashes content over the bound to the same digest on every call under a lease', () => {
    const release = retainContentHashMemo();
    const overBound = contentOfLength(MAX_RETAINED_CODE_UNITS + 1, 'leased');
    const expected = sha256Hex(overBound);

    try {
      expect(hashContent(overBound)).toBe(expected);
      expect(hashContent(overBound)).toBe(expected);
      expect(hashContent(overBound)).toBe(expected);
    } finally {
      release();
    }

    expect(hashContent(overBound)).toBe(expected);
  });
});
