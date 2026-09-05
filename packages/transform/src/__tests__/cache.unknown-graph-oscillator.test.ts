import fs from 'node:fs';

import { TransformCacheCollection } from '../cache';
import type { IEntrypointDependency } from '../transform/Entrypoint.types';

type MockEntrypoint = {
  dependencies: Map<string, Pick<IEntrypointDependency, 'resolved'>>;
  generation: number;
  hasTransformResult?: boolean;
  initialCode?: string;
  isProcessing?: boolean;
  invalidateOnDependencyChange?: Set<string>;
  invalidationDependencies?: Map<
    string,
    Pick<IEntrypointDependency, 'resolved'>
  >;
  name: string;
  transformed?: boolean;
};

const mockedReadFileSync = jest.spyOn(fs, 'readFileSync');
const mockedStatSync = jest.spyOn(fs, 'statSync');

// An evicted processing entrypoint has no trustworthy mutable dependency map.
// Until a complete graph is restored, cache checks must remain conservative:
// treating the file's own hash as sufficient can hide a changed transitive
// dependency. A completed Entrypoint lifecycle can publish a safe snapshot.
describe('TransformCacheCollection: unknown dependency graph', () => {
  const depName = 'dep.js';
  const depContent = 'export { token } from "./leaf.js";';
  const leafName = 'leaf.js';
  const leafContent = 'export const token = "red";';
  const parentName = 'parent.js';
  const parentContent = 'import { token } from "./dep.js"; console.log(token);';

  let cache: TransformCacheCollection<MockEntrypoint>;
  let parentDependencies: MockEntrypoint['dependencies'];
  let leafContentOnDisk: string;
  let leafMtime: number;

  const reArmParent = (generation: number) => {
    cache.add('entrypoints', parentName, {
      name: parentName,
      initialCode: parentContent,
      dependencies: parentDependencies,
      invalidationDependencies: new Map(),
      generation,
    });
  };

  const publishCompleteGraph = (
    filename: string,
    initialCode: string,
    dependencies: MockEntrypoint['dependencies'],
    generation = 1
  ) => {
    cache.add('entrypoints', filename, {
      name: filename,
      initialCode,
      dependencies,
      invalidationDependencies: new Map(),
      generation,
    });
    cache.delete('entrypoints', filename);
  };

  const restoreDepGraph = () => {
    publishCompleteGraph(
      depName,
      depContent,
      new Map([['./leaf.js', { resolved: leafName }]])
    );
  };

  afterAll(() => {
    mockedReadFileSync.mockRestore();
    mockedStatSync.mockRestore();
  });

  beforeEach(() => {
    leafContentOnDisk = leafContent;
    leafMtime = 200;
    mockedStatSync.mockReset();
    mockedStatSync.mockImplementation((path) => {
      if (path === depName) return { mtimeMs: 123 } as fs.Stats;
      if (path === leafName) return { mtimeMs: leafMtime } as fs.Stats;
      throw new Error(`Unexpected statSync call: ${String(path)}`);
    });
    mockedReadFileSync.mockReset();
    mockedReadFileSync.mockImplementation((path) => {
      if (path === depName) return depContent;
      if (path === leafName) return leafContentOnDisk;
      throw new Error(`Unexpected readFileSync call: ${String(path)}`);
    });

    cache = new TransformCacheCollection<MockEntrypoint>();
    parentDependencies = new Map([['./dep.js', { resolved: depName }]]);
    reArmParent(1);

    cache.invalidateIfChanged(leafName, leafContent, undefined, 'fs');
    // A completed leaf entrypoint publishes an explicitly empty graph. A
    // content hash alone cannot prove that an evicted module has no imports.
    publishCompleteGraph(leafName, leafContent, new Map());
    cache.add('entrypoints', depName, {
      name: depName,
      initialCode: depContent,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 1,
      isProcessing: true,
    });
    cache.invalidateIfChanged(depName, depContent, undefined, 'fs');
    cache.delete('entrypoints', depName);
  });

  it('stays conservative until a complete graph is restored', () => {
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);

    reArmParent(2);
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);

    restoreDepGraph();
    reArmParent(3);
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(false);
  });

  it('does not publish an unfinished graph before processing starts', () => {
    cache.add('entrypoints', depName, {
      name: depName,
      initialCode: depContent,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 2,
      transformed: false,
    });
    cache.delete('entrypoints', depName);

    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);
  });

  it.each(['exports', 'barrelManifests'] as const)(
    'does not mistake auxiliary %s dependencies for a complete graph',
    (cacheName) => {
      cache.setCacheDependencies(cacheName, depName, [leafName]);

      expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);
    }
  );

  it('detects a changed transitive leaf after graph repair', () => {
    restoreDepGraph();
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(false);

    leafContentOnDisk = 'export const token = "blue";';
    leafMtime += 1;
    reArmParent(2);

    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);
    expect(mockedReadFileSync).toHaveBeenCalledWith(leafName, 'utf8');
  });

  it('retains forced content checks in a complete dependency snapshot', () => {
    cache.add('entrypoints', leafName, {
      name: leafName,
      initialCode: leafContent,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 2,
    });
    cache.add('entrypoints', depName, {
      name: depName,
      initialCode: depContent,
      dependencies: new Map(),
      invalidationDependencies: new Map([
        ['./leaf.js', { resolved: leafName }],
      ]),
      invalidateOnDependencyChange: new Set([leafName]),
      generation: 2,
    });
    cache.delete('entrypoints', depName);

    // Keep the mtime unchanged: the retained marker must force a content hash
    // check for dependencies whose bytes affect generated output.
    leafContentOnDisk = 'export const token = "blue";';

    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);
    expect(mockedReadFileSync).toHaveBeenCalledWith(leafName, 'utf8');
  });

  it('does not reuse a normal memo result for a forced content check', () => {
    const ordinaryName = 'ordinary.js';
    const ordinaryContent = 'export { token } from "./leaf.js";';
    const forcedName = 'forced.js';
    const forcedContent = 'export { token } from "./leaf.js";';

    mockedStatSync.mockImplementation((path) => {
      if (path === ordinaryName || path === forcedName) {
        return { mtimeMs: 300 } as fs.Stats;
      }
      if (path === leafName) return { mtimeMs: leafMtime } as fs.Stats;
      throw new Error(`Unexpected statSync call: ${String(path)}`);
    });
    mockedReadFileSync.mockImplementation((path) => {
      if (path === ordinaryName) return ordinaryContent;
      if (path === forcedName) return forcedContent;
      if (path === leafName) return leafContentOnDisk;
      throw new Error(`Unexpected readFileSync call: ${String(path)}`);
    });

    cache = new TransformCacheCollection<MockEntrypoint>();
    cache.invalidateIfChanged(leafName, leafContent, undefined, 'fs');
    cache.add('entrypoints', leafName, {
      name: leafName,
      initialCode: leafContent,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 1,
    });

    cache.invalidateIfChanged(ordinaryName, ordinaryContent, undefined, 'fs');
    cache.add('entrypoints', ordinaryName, {
      name: ordinaryName,
      initialCode: ordinaryContent,
      dependencies: new Map([['./leaf.js', { resolved: leafName }]]),
      invalidationDependencies: new Map(),
      generation: 1,
    });

    cache.invalidateIfChanged(forcedName, forcedContent, undefined, 'fs');
    cache.add('entrypoints', forcedName, {
      name: forcedName,
      initialCode: forcedContent,
      dependencies: new Map(),
      invalidationDependencies: new Map([
        ['./leaf.js', { resolved: leafName }],
      ]),
      invalidateOnDependencyChange: new Set([leafName]),
      generation: 1,
    });

    cache.add('entrypoints', parentName, {
      name: parentName,
      initialCode: parentContent,
      dependencies: new Map([
        ['./ordinary.js', { resolved: ordinaryName }],
        ['./forced.js', { resolved: forcedName }],
      ]),
      invalidationDependencies: new Map(),
      generation: 1,
    });

    // Both paths reach the same live leaf at the same mtime. The ordinary path
    // memoizes "unchanged" first; the forced path must still hash the bytes.
    leafContentOnDisk = 'export const token = "blue";';

    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);
    expect(mockedReadFileSync).toHaveBeenCalledWith(leafName, 'utf8');
  });

  it('uses the last complete graph while a replacement is still processing', () => {
    restoreDepGraph();
    cache.add('entrypoints', depName, {
      name: depName,
      initialCode: depContent,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 2,
      isProcessing: true,
    });

    leafContentOnDisk = 'export const token = "blue";';
    leafMtime += 1;

    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);
  });

  it('uses the last complete graph before a replacement starts processing', () => {
    restoreDepGraph();
    cache.add('entrypoints', depName, {
      name: depName,
      initialCode: depContent,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 2,
      transformed: false,
    });

    leafContentOnDisk = 'export const token = "blue";';
    leafMtime += 1;

    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);
  });

  it('keeps the last complete graph when a replacement is evicted mid-processing', () => {
    cache.add('entrypoints', depName, {
      name: depName,
      initialCode: depContent,
      dependencies: new Map([['./leaf.js', { resolved: leafName }]]),
      invalidationDependencies: new Map(),
      generation: 2,
    });
    cache.delete('entrypoints', depName);

    cache.add('entrypoints', depName, {
      name: depName,
      initialCode: depContent,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 3,
      isProcessing: true,
    });
    cache.delete('entrypoints', depName);

    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(false);

    leafContentOnDisk = 'export const token = "blue";';
    leafMtime += 1;
    reArmParent(4);
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);
  });

  it('snapshots a complete graph before a direct replacement', () => {
    cache.add('entrypoints', depName, {
      name: depName,
      initialCode: depContent,
      dependencies: new Map([['./leaf.js', { resolved: leafName }]]),
      invalidationDependencies: new Map(),
      generation: 2,
    });

    // Deferred supersede replaces the cache entry directly, without delete().
    cache.add('entrypoints', depName, {
      name: depName,
      initialCode: depContent,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 3,
      hasTransformResult: false,
    });
    cache.delete('entrypoints', depName);

    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(false);

    leafContentOnDisk = 'export const token = "blue";';
    leafMtime += 1;
    reArmParent(4);
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);
  });

  it('opens a cold replacement epoch and rejects the retired epoch', () => {
    const oldEpoch = cache.getCurrentEpoch();
    const recoveryToken = cache.createGraphTraversalToken(oldEpoch);
    const transition = cache.startUnknownGraphRecovery(
      parentName,
      new Set([depName]),
      parentContent,
      recoveryToken
    );
    transition.complete();

    expect(
      cache.invalidateIfChangedWithDetails(
        parentName,
        parentContent,
        'loaded',
        undefined,
        cache.getCurrentEpoch()
      ).unknownDependencyGraphs
    ).toEqual(new Set());
    expect(() =>
      cache.invalidateIfChangedWithDetails(
        parentName,
        parentContent,
        'loaded',
        undefined,
        oldEpoch
      )
    ).toThrow(transition.abortError);
  });

  it('rejects an epoch traversal token from another cache', () => {
    const otherCache = new TransformCacheCollection<MockEntrypoint>();
    const foreignToken = otherCache.createGraphTraversalToken(
      otherCache.getCurrentEpoch()
    );

    expect(() =>
      cache.invalidateIfChangedWithDetails(
        parentName,
        parentContent,
        'loaded',
        foreignToken
      )
    ).toThrow(/wrong owner/);
  });

  it('rejects stale freshness checks before they mutate replacement state', () => {
    const oldEpoch = cache.getCurrentEpoch();
    const transition = cache.startUnknownGraphRecovery(
      parentName,
      new Set([depName]),
      parentContent,
      cache.createGraphTraversalToken(oldEpoch)
    );
    transition.complete();

    const replacement = {
      name: parentName,
      initialCode: parentContent,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 2,
      hasTransformResult: true,
    };
    cache.add('entrypoints', parentName, replacement);

    expect(() =>
      cache.invalidateIfChangedWithDetails(
        parentName,
        'export const changed = true;',
        'loaded',
        undefined,
        oldEpoch
      )
    ).toThrow(transition.abortError);
    expect(cache.get('entrypoints', parentName)).toBe(replacement);
  });
});
