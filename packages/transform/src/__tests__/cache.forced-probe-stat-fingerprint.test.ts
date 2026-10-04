import fs from 'node:fs';

import { TransformCacheCollection } from '../cache';
import type { IEntrypointDependency } from '../transform/Entrypoint.types';

type MockEntrypoint = {
  dependencies: Map<string, Pick<IEntrypointDependency, 'resolved'>>;
  generation: number;
  initialCode?: string;
  invalidateOnDependencyChange?: Set<string>;
  invalidationDependencies?: Map<
    string,
    Pick<IEntrypointDependency, 'resolved'>
  >;
  name: string;
};

const mockedReadFileSync = jest.spyOn(fs, 'readFileSync');
const mockedStatSync = jest.spyOn(fs, 'statSync');

const stat = (fields: Partial<fs.Stats>) => fields as fs.Stats;

const depName = 'dep.js';
const parentName = 'parent.js';
const parentContent =
  'import { token } from "./dep.js"; export const a = token;';

// An output-affecting dependency is probed by content on every consumer
// check even when its mtime did not move. Many consumers share a few such
// modules, so each of them re-read and re-hashed the same unchanged bytes.
// A complete stat fingerprint (mtime, ctime, size, inode) proves the bytes
// unchanged without reading them; a write cannot preserve ctime.
describe('TransformCacheCollection: forced content probe', () => {
  let cache: TransformCacheCollection<MockEntrypoint>;
  let depContent: string;
  let depStat: fs.Stats;

  afterAll(() => {
    mockedReadFileSync.mockRestore();
    mockedStatSync.mockRestore();
  });

  beforeEach(() => {
    depContent = 'export const token = "red";';
    depStat = stat({ ctimeMs: 500, ino: 7, mtimeMs: 123, size: 27 });
    mockedReadFileSync.mockReset();
    mockedReadFileSync.mockImplementation((path) => {
      if (path === depName) return depContent;
      throw new Error(`Unexpected readFileSync call: ${String(path)}`);
    });
    mockedStatSync.mockReset();
    mockedStatSync.mockImplementation((path) => {
      if (path === depName) return depStat;
      throw new Error(`Unexpected statSync call: ${String(path)}`);
    });

    cache = new TransformCacheCollection<MockEntrypoint>();
    cache.add('entrypoints', depName, {
      name: depName,
      initialCode: depContent,
      dependencies: new Map(),
      generation: 1,
    });
    cache.add('entrypoints', parentName, {
      name: parentName,
      initialCode: parentContent,
      dependencies: new Map([['./dep.js', { resolved: depName }]]),
      invalidateOnDependencyChange: new Set([depName]),
      generation: 1,
    });
    expect(cache.checkFreshness(depName, depName)).toBe(false);
    mockedReadFileSync.mockClear();
  });

  it('does not read a dependency whose stat fingerprint is unchanged', () => {
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(false);
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(false);

    expect(mockedReadFileSync).not.toHaveBeenCalled();
  });

  it('reads a dependency whose ctime moved although its mtime did not', () => {
    depContent = 'export const token = "blue";';
    depStat = stat({ ...depStat, ctimeMs: 501, size: 28 });

    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);

    expect(mockedReadFileSync).toHaveBeenCalledWith(depName, 'utf8');
    expect(cache.get('entrypoints', parentName)).toBeUndefined();
  });

  it('reads a dependency whose stat is incomplete', () => {
    depStat = stat({ mtimeMs: 123 });
    expect(cache.checkFreshness(depName, depName)).toBe(false);
    mockedReadFileSync.mockClear();

    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(false);

    expect(mockedReadFileSync).toHaveBeenCalledWith(depName, 'utf8');
  });

  it.each(['direct', 'dependency'])(
    'detects a same-size edit with unchanged mtime during a normal %s probe',
    (probe) => {
      cache
        .get('entrypoints', parentName)!
        .invalidateOnDependencyChange!.clear();
      depContent = 'export const token = "tan";';
      depStat = stat({ ...depStat, ctimeMs: 501 });

      const changed =
        probe === 'direct'
          ? cache.checkFreshness(depName, depName)
          : cache.invalidateIfChanged(parentName, parentContent);

      expect(changed).toBe(true);
      expect(cache.get('entrypoints', depName)).toBeUndefined();
      expect(mockedReadFileSync).toHaveBeenCalledWith(depName, 'utf8');
    }
  );

  it.each(['direct', 'dependency', 'forced dependency'])(
    'detects sub-millisecond writes with unchanged millisecond stats during a %s probe',
    (probe) => {
      let preciseStat = {
        ctimeMs: 500n,
        ctimeNs: 500000001n,
        ino: 7n,
        mtimeMs: 123n,
        mtimeNs: 123000000n,
        size: 27n,
      };
      mockedStatSync.mockImplementation((path, options) => {
        if (path !== depName) {
          throw new Error(`Unexpected statSync call: ${String(path)}`);
        }
        return (
          options && typeof options === 'object' && options.bigint
            ? preciseStat
            : depStat
        ) as fs.Stats;
      });
      expect(cache.checkFreshness(depName, depName)).toBe(false);
      mockedReadFileSync.mockClear();
      if (probe !== 'forced dependency') {
        cache
          .get('entrypoints', parentName)!
          .invalidateOnDependencyChange!.clear();
      }
      depContent = 'export const token = "tan";';
      preciseStat = { ...preciseStat, ctimeNs: 500000002n };

      const changed =
        probe === 'direct'
          ? cache.checkFreshness(depName, depName)
          : cache.invalidateIfChanged(parentName, parentContent);

      expect(changed).toBe(true);
      expect(cache.get('entrypoints', depName)).toBeUndefined();
      expect(mockedReadFileSync).toHaveBeenCalledWith(depName, 'utf8');
    }
  );
});
