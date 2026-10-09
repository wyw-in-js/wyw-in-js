import fs from 'node:fs';

import { TransformCacheCollection } from '../cache';
import * as contentHash from '../utils/contentHash';

type MockEntrypoint = {
  dependencies: Map<string, { resolved: string }>;
  generation: number;
  name: string;
  originalCode: string;
};

describe('TransformCacheCollection: source hash reuse', () => {
  const rootName = 'root.js';
  const leafName = 'leaf.js';
  const rootCode = 'export { token } from "./leaf.js";';
  const initialLeafCode = 'export const token = "red";';

  let cache: TransformCacheCollection<MockEntrypoint>;
  let leafCode: string;
  let leafMtime: number;
  let hashContent: jest.SpyInstance;
  let readFileSync: jest.SpyInstance;
  let statSync: jest.SpyInstance;

  beforeEach(() => {
    leafCode = initialLeafCode;
    leafMtime = 100;
    hashContent = jest.spyOn(contentHash, 'hashContent');
    readFileSync = jest.spyOn(fs, 'readFileSync').mockImplementation((name) => {
      if (name === rootName) return rootCode;
      if (name === leafName) return leafCode;
      throw new Error(`Unexpected readFileSync call: ${String(name)}`);
    });
    statSync = jest.spyOn(fs, 'statSync').mockImplementation((name) => {
      if (name === rootName) return { mtimeMs: 100 } as fs.Stats;
      if (name === leafName) return { mtimeMs: leafMtime } as fs.Stats;
      throw new Error(`Unexpected statSync call: ${String(name)}`);
    });

    cache = new TransformCacheCollection<MockEntrypoint>();
    cache.add('entrypoints', leafName, {
      dependencies: new Map(),
      generation: 1,
      name: leafName,
      originalCode: leafCode,
    });
    cache.add('entrypoints', rootName, {
      dependencies: new Map([['./leaf.js', { resolved: leafName }]]),
      generation: 1,
      name: rootName,
      originalCode: rootCode,
    });
    // Both channels have accepted this revision before the measured probe.
    cache.invalidateIfChanged(rootName, rootCode, undefined, 'loaded');
    hashContent.mockClear();
  });

  afterEach(() => {
    hashContent.mockRestore();
    readFileSync.mockRestore();
    statSync.mockRestore();
  });

  it.each(['fs', 'loaded'] as const)(
    'hashes an unchanged %s source once while preserving its graph',
    (source) => {
      expect(
        cache.invalidateIfChangedWithDetails(rootName, rootCode, source)
      ).toEqual({ changed: false, unknownDependencyGraphs: new Set() });

      expect(hashContent).toHaveBeenCalledTimes(1);
      expect(hashContent).toHaveBeenCalledWith(rootCode);
      expect(cache.get('entrypoints', rootName)).toBeDefined();
      expect(cache.get('entrypoints', leafName)).toBeDefined();
    }
  );

  it('hashes changed dependency bytes separately and invalidates its consumer', () => {
    leafCode = 'export const token = "blue";';
    leafMtime += 1;

    expect(
      cache.invalidateIfChangedWithDetails(rootName, rootCode, 'fs')
    ).toEqual({ changed: true, unknownDependencyGraphs: new Set() });

    expect(hashContent).toHaveBeenCalledTimes(2);
    expect(hashContent).toHaveBeenCalledWith(rootCode);
    expect(hashContent).toHaveBeenCalledWith(leafCode);
    expect(cache.get('entrypoints', rootName)).toBeUndefined();
    expect(cache.get('entrypoints', leafName)).toBeUndefined();
  });
});
