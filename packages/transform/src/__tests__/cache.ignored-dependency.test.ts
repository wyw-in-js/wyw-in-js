import fs from 'node:fs';

import { TransformCacheCollection } from '../cache';
import type { IEntrypointDependency } from '../transform/Entrypoint.types';

type MockEntrypoint = {
  dependencies: Map<string, Pick<IEntrypointDependency, 'resolved'>>;
  generation: number;
  ignored?: boolean;
  initialCode?: string;
  invalidationDependencies?: Map<
    string,
    Pick<IEntrypointDependency, 'resolved'>
  >;
  name: string;
  transformed?: boolean;
};

const mockedReadFileSync = jest.spyOn(fs, 'readFileSync');
const mockedStatSync = jest.spyOn(fs, 'statSync');

// An asset import (`import bg from './bg.svg'`) creates an entrypoint that the
// ignore rules mark as ignored. The workflow never processes it, so it never
// gets a transform result and `transformed` stays false for its whole life. The
// unknown-graph guard must read that as "nothing to process", not as an
// unfinished graph: otherwise every module importing an asset resets the cache
// on its second check, and nothing can ever complete the asset's graph.
describe('TransformCacheCollection: ignored dependency entrypoint', () => {
  const assetName = 'bg.svg';
  const assetContent = '<svg />';
  const parentName = 'parent.js';
  const parentContent = 'import bg from "./bg.svg"; export { bg };';

  let cache: TransformCacheCollection<MockEntrypoint>;
  let assetContentOnDisk: string;
  let assetMtime: number;

  const publishAsset = (generation: number, ignored = true) => {
    // A child entrypoint is created without loaded code, so the cache reads the
    // asset from disk for its content hash.
    cache.add('entrypoints', assetName, {
      name: assetName,
      initialCode: undefined,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation,
      ignored,
      transformed: false,
    });
  };

  const publishParent = (generation: number) => {
    cache.add('entrypoints', parentName, {
      name: parentName,
      initialCode: parentContent,
      dependencies: new Map([['./bg.svg', { resolved: assetName }]]),
      invalidationDependencies: new Map(),
      generation,
    });
  };

  const checkParent = () =>
    cache.invalidateIfChangedWithDetails(parentName, parentContent, 'loaded');

  afterAll(() => {
    mockedReadFileSync.mockRestore();
    mockedStatSync.mockRestore();
  });

  beforeEach(() => {
    assetContentOnDisk = assetContent;
    assetMtime = 200;
    mockedStatSync.mockReset();
    mockedStatSync.mockImplementation((path) => {
      if (path === assetName) return { mtimeMs: assetMtime } as fs.Stats;
      throw new Error(`Unexpected statSync call: ${String(path)}`);
    });
    mockedReadFileSync.mockReset();
    mockedReadFileSync.mockImplementation((path) => {
      if (path === assetName) return assetContentOnDisk;
      throw new Error(`Unexpected readFileSync call: ${String(path)}`);
    });

    cache = new TransformCacheCollection<MockEntrypoint>();
    publishAsset(1);
    publishParent(1);
  });

  it('treats a live ignored entrypoint as a complete graph', () => {
    expect(checkParent()).toEqual({
      changed: false,
      unknownDependencyGraphs: new Set(),
    });
  });

  it('still detects a change of the asset on disk', () => {
    assetContentOnDisk = '<svg viewBox="0 0 1 1" />';
    assetMtime += 1;

    expect(checkParent()).toEqual({
      changed: true,
      unknownDependencyGraphs: new Set(),
    });
  });

  it('snapshots an evicted ignored entrypoint so it stays known', () => {
    cache.delete('entrypoints', assetName);

    expect(checkParent()).toEqual({
      changed: false,
      unknownDependencyGraphs: new Set(),
    });
  });

  it('keeps an unfinished non-ignored entrypoint unknown', () => {
    cache = new TransformCacheCollection<MockEntrypoint>();
    publishAsset(1, false);
    publishParent(1);

    expect(checkParent()).toEqual({
      changed: true,
      unknownDependencyGraphs: new Set([assetName]),
    });
  });
});
