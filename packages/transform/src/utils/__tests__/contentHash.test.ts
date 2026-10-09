import { createHash } from 'node:crypto';

import {
  ContentHashMemo,
  hashContent,
  retainContentHashMemo,
} from '../contentHash';

const sha256Hex = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

const samples = [
  '',
  'plain ascii',
  'nul\0byte',
  'emoji 👋',
  'export const greeting = "γειά 👋";',
  // A lone surrogate is encoded as U+FFFD; the digest must stay the one the
  // cache has always stored for such content.
  '\ud800',
  'x'.repeat(70_000),
];

describe('hashContent', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the SHA-256 hex digest of the UTF-8 content', () => {
    for (const content of samples) {
      expect(hashContent(content)).toBe(sha256Hex(content));
    }
    // Pinned digests: freshness keys must not change encoding or algorithm.
    expect(hashContent('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(hashContent('\ud800')).toBe(hashContent('�'));
  });

  it('bypasses the memo when nobody retains it', () => {
    const memoHash = jest.spyOn(ContentHashMemo.prototype, 'hash');

    expect(hashContent('no lease')).toBe(sha256Hex('no lease'));
    expect(memoHash).not.toHaveBeenCalled();
  });

  it('serves the same digests through the memo while it is retained', () => {
    const memoHash = jest.spyOn(ContentHashMemo.prototype, 'hash');
    const release = retainContentHashMemo();
    try {
      for (const content of [...samples, ...samples]) {
        expect(hashContent(content)).toBe(sha256Hex(content));
      }
      expect(memoHash).toHaveBeenCalledTimes(samples.length * 2);
    } finally {
      release();
    }

    memoHash.mockClear();
    expect(hashContent('after release')).toBe(sha256Hex('after release'));
    expect(memoHash).not.toHaveBeenCalled();
  });

  it('clears the memo when the last lease is released', () => {
    const memoClear = jest.spyOn(ContentHashMemo.prototype, 'clear');
    const releaseFirst = retainContentHashMemo();
    const releaseSecond = retainContentHashMemo();

    releaseFirst();
    releaseFirst();
    expect(memoClear).not.toHaveBeenCalled();

    releaseSecond();
    expect(memoClear).toHaveBeenCalledTimes(1);
    releaseSecond();
    expect(memoClear).toHaveBeenCalledTimes(1);
  });
});

describe('ContentHashMemo', () => {
  it('remembers digests and returns them for equal content', () => {
    const memo = new ContentHashMemo();
    const content = 'export const a = 1;';

    expect(memo.has(content)).toBe(false);
    expect(memo.hash(content)).toBe(sha256Hex(content));
    expect(memo.has(content)).toBe(true);
    expect(memo.hash(`${content}`)).toBe(sha256Hex(content));
    expect(memo.size).toBe(1);
  });

  it('does not retain content above the per-entry bound', () => {
    const memo = new ContentHashMemo({ maxEntryCodeUnits: 4 });

    expect(memo.hash('12345')).toBe(sha256Hex('12345'));
    expect(memo.has('12345')).toBe(false);
    expect(memo.hash('1234')).toBe(sha256Hex('1234'));
    expect(memo.has('1234')).toBe(true);
  });

  it('evicts the oldest digests beyond the entry bound', () => {
    const memo = new ContentHashMemo({ maxEntries: 2 });

    memo.hash('a');
    memo.hash('b');
    memo.hash('c');

    expect(memo.has('a')).toBe(false);
    expect(memo.has('b')).toBe(true);
    expect(memo.has('c')).toBe(true);
    expect(memo.size).toBe(2);
  });

  it('evicts the oldest digests beyond the retained code-unit bound', () => {
    const memo = new ContentHashMemo({ maxTotalCodeUnits: 6 });

    memo.hash('aaa');
    memo.hash('bb');
    memo.hash('cccc');

    expect(memo.has('aaa')).toBe(false);
    expect(memo.has('bb')).toBe(true);
    expect(memo.has('cccc')).toBe(true);

    memo.hash('dddd');
    expect(memo.has('bb')).toBe(false);
    expect(memo.has('cccc')).toBe(false);
    expect(memo.has('dddd')).toBe(true);
    expect(memo.size).toBe(1);
  });

  it('forgets every digest on clear', () => {
    const memo = new ContentHashMemo();

    memo.hash('a');
    memo.hash('b');
    memo.clear();

    expect(memo.size).toBe(0);
    expect(memo.has('a')).toBe(false);
    expect(memo.hash('a')).toBe(sha256Hex('a'));
  });
});
