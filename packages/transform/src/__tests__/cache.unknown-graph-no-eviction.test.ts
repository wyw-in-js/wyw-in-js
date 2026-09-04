import fs from 'node:fs';

import { TransformCacheCollection } from '../cache';
import type { IEntrypointDependency } from '../transform/Entrypoint.types';

type MockEntrypoint = {
  dependencies: Map<string, Pick<IEntrypointDependency, 'resolved'>>;
  generation: number;
  initialCode?: string;
  isProcessing?: boolean;
  invalidationDependencies?: Map<
    string,
    Pick<IEntrypointDependency, 'resolved'>
  >;
  name: string;
  processingStarted?: boolean;
  transformed?: boolean;
};

const mockedReadFileSync = jest.spyOn(fs, 'readFileSync');
const mockedStatSync = jest.spyOn(fs, 'statSync');

// A shared cache serves many concurrent transforms. While one of them is still
// processing a module, another transform's dependency check can walk into that
// module's partially filled dependency map and find a transitive graph it
// cannot verify yet. That is an *unknown* graph, not a *changed* one: the
// check must report it (the caller decides whether to fail closed), but it
// must not evict the modules on the path. Evicting a module that is still
// processing is unrecoverable: it never gets a dependency snapshot, its
// transform result lands on an object the cache no longer holds, and every
// later check finds a once-published module without a graph.
describe('TransformCacheCollection: unknown graphs do not evict', () => {
  const parentName = 'parent.js';
  const parentContent = 'import { token } from "./mid.js"; console.log(token);';
  const midName = 'mid.js';
  const midContent = 'export { token } from "./leaf.js";';
  const leafName = 'leaf.js';
  const leafContent = 'export const token = "red";';

  let cache: TransformCacheCollection<MockEntrypoint>;
  let leafContentOnDisk: string;
  let leafMtime: number;

  const publish = (
    name: string,
    content: string,
    dependencies: MockEntrypoint['dependencies'],
    state: Partial<MockEntrypoint> = {},
    generation = 1
  ) => {
    cache.add('entrypoints', name, {
      name,
      initialCode: content,
      dependencies,
      invalidationDependencies: new Map(),
      generation,
      ...state,
    });
  };

  const inFlight = {
    isProcessing: true,
    processingStarted: true,
    transformed: false,
  };

  const checkParent = () =>
    cache.invalidateIfChangedWithDetails(parentName, parentContent, 'loaded');

  afterAll(() => {
    mockedReadFileSync.mockRestore();
    mockedStatSync.mockRestore();
  });

  beforeEach(() => {
    leafContentOnDisk = leafContent;
    leafMtime = 200;
    mockedStatSync.mockReset();
    mockedStatSync.mockImplementation((path) => {
      if (path === midName) return { mtimeMs: 123 } as fs.Stats;
      if (path === leafName) return { mtimeMs: leafMtime } as fs.Stats;
      throw new Error(`Unexpected statSync call: ${String(path)}`);
    });
    mockedReadFileSync.mockReset();
    mockedReadFileSync.mockImplementation((path) => {
      if (path === midName) return midContent;
      if (path === leafName) return leafContentOnDisk;
      throw new Error(`Unexpected readFileSync call: ${String(path)}`);
    });

    cache = new TransformCacheCollection<MockEntrypoint>();

    // Static reads seeded fs hashes and mtimes for both modules.
    cache.invalidateIfChanged(midName, midContent, undefined, 'fs');
    cache.invalidateIfChanged(leafName, leafContent, undefined, 'fs');

    // Both modules are being processed by concurrent transforms: no transform
    // result yet, no snapshot from an earlier complete generation.
    publish(leafName, leafContent, new Map(), inFlight);
    publish(
      midName,
      midContent,
      new Map([['./leaf.js', { resolved: leafName }]]),
      inFlight
    );
    publish(
      parentName,
      parentContent,
      new Map([['./mid.js', { resolved: midName }]])
    );
  });

  it('reports the unfinished graphs without evicting the modules on the path', () => {
    expect(checkParent()).toEqual({
      changed: true,
      unknownDependencyGraphs: new Set([midName, leafName]),
    });

    expect(cache.get('entrypoints', midName)).toBeDefined();
    expect(cache.get('entrypoints', leafName)).toBeDefined();
    expect(cache.get('entrypoints', parentName)).toBeDefined();
  });

  it('accepts the graph once the in-flight modules publish their results', () => {
    checkParent();

    publish(leafName, leafContent, new Map(), {}, 2);
    publish(
      midName,
      midContent,
      new Map([['./leaf.js', { resolved: leafName }]]),
      {},
      2
    );

    expect(checkParent()).toEqual({
      changed: false,
      unknownDependencyGraphs: new Set(),
    });
  });

  it('does not evict an in-flight root whose dependency graph is only unknown', () => {
    // checkFreshness and the Entrypoint constructor check a file as the root
    // of its own graph and discard the unknown-graph details.
    expect(
      cache.invalidateIfChanged(midName, midContent, undefined, 'fs')
    ).toBe(true);

    expect(cache.get('entrypoints', midName)).toBeDefined();
  });

  it('still evicts the whole path when a transitive leaf changed on disk', () => {
    publish(leafName, leafContent, new Map(), {}, 2);
    publish(
      midName,
      midContent,
      new Map([['./leaf.js', { resolved: leafName }]]),
      {},
      2
    );
    leafContentOnDisk = 'export const token = "blue";';
    leafMtime += 1;

    expect(checkParent()).toEqual({
      changed: true,
      unknownDependencyGraphs: new Set(),
    });

    expect(cache.get('entrypoints', leafName)).toBeUndefined();
    expect(cache.get('entrypoints', midName)).toBeUndefined();
    expect(cache.get('entrypoints', parentName)).toBeUndefined();
  });

  it('still evicts an in-flight module whose own dependency changed on disk', () => {
    leafContentOnDisk = 'export const token = "blue";';
    leafMtime += 1;

    expect(checkParent().changed).toBe(true);

    expect(cache.get('entrypoints', leafName)).toBeUndefined();
    expect(cache.get('entrypoints', midName)).toBeUndefined();
    expect(cache.get('entrypoints', parentName)).toBeUndefined();
  });
});
