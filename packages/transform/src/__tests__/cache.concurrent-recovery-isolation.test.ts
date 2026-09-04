import fs from 'node:fs';

import { TransformCacheCollection } from '../cache';

type MockEntrypoint = {
  dependencies: Map<string, { resolved: string | null }>;
  generation: number;
  initialCode?: string;
  invalidateOnDependencyChange?: Set<string>;
  invalidationDependencies?: Map<string, { resolved: string | null }>;
  name: string;
};

const entrypoint = (
  name: string,
  extra: Partial<MockEntrypoint> = {}
): MockEntrypoint => ({
  name,
  dependencies: new Map(),
  invalidationDependencies: new Map(),
  generation: 1,
  ...extra,
});

const recover = (
  cache: TransformCacheCollection<MockEntrypoint>,
  filename: string,
  unknown: string[] = ['missing.linaria.ts']
) =>
  cache.beginUnknownGraphRecovery(
    filename,
    new Set(unknown),
    'export const a = 1;',
    cache.createGraphTraversalToken()
  );

// A bundler loader keeps one TransformCacheCollection per compiler and runs
// loader calls concurrently, so one module's fail-closed recovery used to fail
// every transform in flight with an error naming a file they never referenced.
describe('TransformCacheCollection: concurrent recovery isolation', () => {
  it('poisons only the file whose graph was incomplete', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const versionBefore = cache.getLifecycleVersion();

    recover(cache, 'recovering.tsx');

    expect(cache.getRecoveryError('recovering.tsx', versionBefore)).toMatchObject(
      { name: 'UnknownDependencyGraphResetError' }
    );
    expect(cache.getRecoveryError('unrelated.tsx', versionBefore)).toBeNull();
  });

  it('does not hand an unrelated generation a lifecycle error', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const versionBefore = cache.getLifecycleVersion();

    recover(cache, 'recovering.tsx');

    expect(cache.getLifecycleError(versionBefore)).toBeNull();
  });

  it('lets the recovering traversal rebuild the file it recovered', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const recoveryToken = cache.createGraphTraversalToken();
    cache.beginUnknownGraphRecovery(
      'recovering.tsx',
      new Set(['missing.linaria.ts']),
      'export const a = 1;',
      recoveryToken
    );
    const versionAfter = cache.getLifecycleVersion();

    expect(
      cache.getRecoveryError('recovering.tsx', versionAfter, recoveryToken)
    ).toBeNull();
    // Any other traversal must not publish it while the graph is incomplete.
    expect(
      cache.getRecoveryError('recovering.tsx', versionAfter, {})
    ).toMatchObject({ name: 'UnknownDependencyGraphResetError' });
  });

  it('still clears cached entrypoints so the next check rebuilds them', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    cache.add('entrypoints', 'other.tsx', entrypoint('other.tsx'));

    recover(cache, 'recovering.tsx');

    expect(cache.get('entrypoints', 'other.tsx')).toBeUndefined();
  });

  it('forgets recovery errors when the cache namespace changes', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    // A null -> salt transition migrates keys and keeps the cache; only a real
    // namespace change clears it.
    cache.setKeySalt('first');
    const versionBefore = cache.getLifecycleVersion();
    recover(cache, 'recovering.tsx');

    cache.setKeySalt('second');

    expect(cache.getRecoveryError('recovering.tsx', versionBefore)).toBeNull();
  });

  it('keeps a recovery per file when several files recover', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const versionBefore = cache.getLifecycleVersion();

    recover(cache, 'a.tsx', ['a-missing.ts']);
    recover(cache, 'b.tsx', ['b-missing.ts']);

    expect(cache.getRecoveryError('a.tsx', versionBefore)?.message).toContain(
      'a-missing.ts'
    );
    expect(cache.getRecoveryError('b.tsx', versionBefore)?.message).toContain(
      'b-missing.ts'
    );
  });
});

// SAFETY_ANALYSIS.md test matrix item 6: a loader can return new content for an
// unchanged filesystem mtime. Recovery scoping must not weaken that.
describe('TransformCacheCollection: loader content at unchanged mtime', () => {
  const leaf = 'leaf.js';
  const parent = 'parent.js';
  const parentCode = 'import { c } from "./leaf.js";';

  const mockedStatSync = jest.spyOn(fs, 'statSync');
  const mockedReadFileSync = jest.spyOn(fs, 'readFileSync');

  afterAll(() => {
    mockedStatSync.mockRestore();
    mockedReadFileSync.mockRestore();
  });

  it('treats new loaded content at an unchanged mtime as a change', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    mockedStatSync.mockReturnValue({ mtimeMs: 500 } as fs.Stats);

    cache.invalidateIfChanged(leaf, 'export const c = "red";', undefined, 'fs');
    cache.add('entrypoints', leaf, entrypoint(leaf));

    expect(cache.invalidateIfChanged(leaf, 'export const c = "blue";')).toBe(
      true
    );
    expect(cache.get('entrypoints', leaf)).toBeUndefined();
  });

  it('detects a changed dependency behind an unchanged mtime', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    let leafOnDisk = 'export const c = "red";';
    mockedStatSync.mockImplementation(
      () => ({ mtimeMs: 500 }) as unknown as fs.Stats
    );
    mockedReadFileSync.mockImplementation((() => leafOnDisk) as never);

    cache.checkFreshness(leaf, leaf);
    cache.add('entrypoints', leaf, entrypoint(leaf));
    cache.add(
      'entrypoints',
      parent,
      entrypoint(parent, {
        initialCode: parentCode,
        invalidationDependencies: new Map([['./leaf.js', { resolved: leaf }]]),
        invalidateOnDependencyChange: new Set([leaf]),
      })
    );

    leafOnDisk = 'export const c = "blue";';

    expect(
      cache.invalidateIfChangedWithDetails(parent, parentCode, 'loaded').changed
    ).toBe(true);
    expect(mockedReadFileSync).toHaveBeenCalledWith(leaf, 'utf8');
  });
});
