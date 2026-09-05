import fs from 'node:fs';

import { TransformCacheCollection } from '../cache';
import type { BarrelManifest } from '../transform/barrelManifest.types';
import type { IEntrypointDependency } from '../transform/Entrypoint.types';

// Mocking the minimal interface needed by the cache
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

const createErrnoError = (
  code: string,
  message = code
): NodeJS.ErrnoException => {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

const setupCacheWithEntrypoint = (
  filename: string,
  content: string,
  dependencies: MockEntrypoint['dependencies'] = new Map(),
  invalidationDependencies: MockEntrypoint['invalidationDependencies'] = new Map()
): {
  cache: TransformCacheCollection<MockEntrypoint>;
  entrypoint: MockEntrypoint;
} => {
  const cache = new TransformCacheCollection<MockEntrypoint>();
  const entrypoint: MockEntrypoint = {
    name: filename,
    initialCode: content,
    dependencies,
    invalidationDependencies,
    generation: 1,
  };

  cache.add('entrypoints', filename, entrypoint);

  return { cache, entrypoint };
};

describe('TransformCacheCollection', () => {
  afterAll(() => {
    mockedReadFileSync.mockRestore();
    mockedStatSync.mockRestore();
  });

  beforeEach(() => {
    mockedReadFileSync.mockReset();
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('Unexpected readFileSync call.');
    });
    mockedStatSync.mockReset();
    mockedStatSync.mockImplementation(() => {
      throw createErrnoError('ENOENT');
    });
  });

  describe('invalidateIfChanged', () => {
    it('should not invalidate if content is unchanged', () => {
      const filename = 'test.js';
      const content = 'console.log("hello")';
      const { cache } = setupCacheWithEntrypoint(filename, content);

      const invalidated = cache.invalidateIfChanged(filename, content);

      expect(invalidated).toBe(false);
      expect(cache.has('entrypoints', filename)).toBe(true);
    });

    it('stores content hashes for filesystem-loaded entrypoints', () => {
      const filename = 'fs.js';
      const content = 'export const value = 1;';
      const cache = new TransformCacheCollection();

      cache.add('entrypoints', filename, {
        dependencies: new Map(),
        generation: 1,
        initialCode: undefined,
        name: filename,
        originalCode: content,
      } as any);

      const invalidated = cache.invalidateIfChanged(
        filename,
        content,
        undefined,
        'fs'
      );

      expect(invalidated).toBe(false);
      expect(cache.has('entrypoints', filename)).toBe(true);
    });

    it('invalidates if loaded content differs from fs content', () => {
      const filename = 'fs.tsx';
      const fsContent = 'export type Foo = string;';
      const loadedContent = 'export const foo = "string";';
      const { cache } = setupCacheWithEntrypoint(filename, fsContent);

      cache.invalidateIfChanged(filename, fsContent, undefined, 'fs');

      const invalidated = cache.invalidateIfChanged(
        filename,
        loadedContent,
        undefined,
        'loaded'
      );

      expect(invalidated).toBe(true);
      expect(cache.has('entrypoints', filename)).toBe(false);
    });

    it('does not invalidate if loaded content matches fs content', () => {
      const filename = 'fs.tsx';
      const content = 'export const foo = "string";';
      const { cache } = setupCacheWithEntrypoint(filename, content);

      cache.invalidateIfChanged(filename, content, undefined, 'fs');

      const invalidated = cache.invalidateIfChanged(
        filename,
        content,
        undefined,
        'loaded'
      );

      expect(invalidated).toBe(false);
      expect(cache.has('entrypoints', filename)).toBe(true);
    });

    it('invalidates a real edit that returns one channel to the other channel hash', () => {
      const filename = 'fs.tsx';
      const loadedContent = 'export const value = "loaded";';
      const fsContent = 'export const value = "filesystem";';
      const { cache } = setupCacheWithEntrypoint(filename, loadedContent);

      expect(
        cache.invalidateIfChanged(filename, fsContent, undefined, 'fs')
      ).toBe(true);

      cache.add('entrypoints', filename, {
        dependencies: new Map(),
        generation: 2,
        initialCode: undefined,
        invalidationDependencies: new Map(),
        name: filename,
        originalCode: fsContent,
      } as any);

      expect(
        cache.invalidateIfChanged(filename, loadedContent, undefined, 'fs')
      ).toBe(true);
      expect(cache.has('entrypoints', filename)).toBe(false);
    });

    it('invalidates a delayed channel update after stale content was republished', () => {
      const filename = 'fs.tsx';
      const oldContent = 'export const value = "old";';
      const newContent = 'export const value = "new";';
      const { cache } = setupCacheWithEntrypoint(filename, oldContent);

      expect(
        cache.invalidateIfChanged(filename, newContent, undefined, 'fs')
      ).toBe(true);

      cache.add('entrypoints', filename, {
        dependencies: new Map(),
        generation: 2,
        initialCode: oldContent,
        invalidationDependencies: new Map(),
        name: filename,
      } as any);

      expect(
        cache.invalidateIfChanged(filename, newContent, undefined, 'loaded')
      ).toBe(true);
      expect(cache.has('entrypoints', filename)).toBe(false);
    });

    it('should invalidate if content has changed', () => {
      const filename = 'test.js';
      const content = 'console.log("hello")';
      const newContent = 'console.log("world")';
      const { cache } = setupCacheWithEntrypoint(filename, content);

      const invalidated = cache.invalidateIfChanged(filename, newContent);

      expect(invalidated).toBe(true);
      expect(cache.has('entrypoints', filename)).toBe(false);
    });

    it('invalidates barrel manifests together with entrypoints when content changes', () => {
      const filename = 'barrel.ts';
      const content = `export { foo } from './foo';`;
      const newContent = `export { bar } from './bar';`;
      const { cache } = setupCacheWithEntrypoint(filename, content);

      cache.add('barrelManifests', filename, {
        complete: true,
        exports: {},
        kind: 'barrel',
      } satisfies BarrelManifest);

      const invalidated = cache.invalidateIfChanged(filename, newContent);

      expect(invalidated).toBe(true);
      expect(cache.has('entrypoints', filename)).toBe(false);
      expect(cache.has('barrelManifests', filename)).toBe(false);
    });

    it('should invalidate dependency if its content changed', () => {
      const depName = 'dep.js';
      const depContent = 'export const b = 2;';
      const newDepContent = 'export const b = 3;';
      const parentName = 'parent.js';
      const parentContent = 'import { b } from "./dep.js"; console.log(b);';

      const { entrypoint: depEntrypoint } = setupCacheWithEntrypoint(
        depName,
        depContent
      );

      const parentDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([['./dep.js', { resolved: depName }]]);
      const { cache } = setupCacheWithEntrypoint(
        parentName,
        parentContent,
        parentDeps
      );

      // Add the dependency entry to the main cache
      cache.add('entrypoints', depName, depEntrypoint as any);
      cache.invalidateIfChanged(depName, depContent, undefined, 'fs');

      // Mock fs read to return new content for the dependency
      mockedReadFileSync.mockImplementation((path) => {
        if (path === depName) {
          return newDepContent;
        }
        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      const invalidated = cache.invalidateIfChanged(
        parentName,
        parentContent // Parent content itself hasn't changed
      );

      expect(invalidated).toBe(true); // Parent invalidated due to dep change
      expect(cache.has('entrypoints', parentName)).toBe(false); // Parent evicted
      expect(cache.has('entrypoints', depName)).toBe(false); // Dependency invalidated
      expect(mockedReadFileSync).toHaveBeenCalledWith(depName, 'utf8');
    });

    it('does not read unchanged leaf dependency content when mtime is unchanged', () => {
      const depName = 'dep.js';
      const depContent = 'export const b = 2;';
      const parentName = 'parent.js';
      const parentContent = 'import { b } from "./dep.js"; console.log(b);';

      const { entrypoint: depEntrypoint } = setupCacheWithEntrypoint(
        depName,
        depContent
      );

      const parentDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([['./dep.js', { resolved: depName }]]);
      const { cache } = setupCacheWithEntrypoint(
        parentName,
        parentContent,
        parentDeps
      );

      cache.add('entrypoints', depName, depEntrypoint as any);

      mockedStatSync.mockImplementation((path) => {
        if (path === depName) {
          return { mtimeMs: 123 } as fs.Stats;
        }

        throw new Error(`Unexpected statSync call: ${String(path)}`);
      });

      cache.invalidateIfChanged(depName, depContent, undefined, 'fs');

      const invalidated = cache.invalidateIfChanged(parentName, parentContent);

      expect(invalidated).toBe(false);
      expect(cache.has('entrypoints', parentName)).toBe(true);
      expect(cache.has('entrypoints', depName)).toBe(true);
      expect(mockedReadFileSync).not.toHaveBeenCalledWith(depName, 'utf8');
      expect(mockedStatSync).toHaveBeenCalledWith(depName);
    });

    it('does not invalidate an output-affecting dependency when only its entrypoint was evicted', () => {
      const depName = 'dep.js';
      const depContent = 'export const token = "red";';
      const parentName = 'parent.js';
      const parentContent = 'import { token } from "./dep.js"; css`${token}`;';

      const { entrypoint: depEntrypoint } = setupCacheWithEntrypoint(
        depName,
        depContent
      );

      const parentDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([['./dep.js', { resolved: depName }]]);
      const { cache, entrypoint: parentEntrypoint } = setupCacheWithEntrypoint(
        parentName,
        parentContent,
        parentDeps
      );
      parentEntrypoint.invalidateOnDependencyChange = new Set([depName]);

      cache.add('entrypoints', depName, depEntrypoint as any);

      mockedStatSync.mockImplementation((path) => {
        if (path === depName) {
          return { mtimeMs: 123 } as fs.Stats;
        }

        throw new Error(`Unexpected statSync call: ${String(path)}`);
      });
      mockedReadFileSync.mockImplementation((path) => {
        if (path === depName) {
          return depContent;
        }

        throw new Error(`Unexpected readFileSync call: ${String(path)}`);
      });

      expect(cache.checkFreshness(depName, depName)).toBe(false);
      cache.delete('entrypoints', depName);
      mockedReadFileSync.mockClear();

      const invalidated = cache.invalidateIfChanged(parentName, parentContent);

      expect(invalidated).toBe(false);
      expect(cache.has('entrypoints', parentName)).toBe(true);
      expect(mockedReadFileSync).toHaveBeenCalledWith(depName, 'utf8');
    });

    it('memoizes unchanged shared dependency subtrees within one invalidation pass', () => {
      const leafName = 'leaf.js';
      const leafContent = 'export const c = 3;';
      const leftName = 'left.js';
      const leftContent = 'import { c } from "./leaf.js"; export const l = c;';
      const rightName = 'right.js';
      const rightContent =
        'import { c } from "./leaf.js"; export const r = c + 1;';
      const rootName = 'root.js';
      const rootContent =
        'import { l } from "./left.js"; import { r } from "./right.js";';

      const { entrypoint: leafEntrypoint } = setupCacheWithEntrypoint(
        leafName,
        leafContent
      );
      const leftDeps = new Map<string, Pick<IEntrypointDependency, 'resolved'>>(
        [['./leaf.js', { resolved: leafName }]]
      );
      const { entrypoint: leftEntrypoint } = setupCacheWithEntrypoint(
        leftName,
        leftContent,
        leftDeps
      );
      const rightDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([['./leaf.js', { resolved: leafName }]]);
      const { entrypoint: rightEntrypoint } = setupCacheWithEntrypoint(
        rightName,
        rightContent,
        rightDeps
      );
      const rootDeps = new Map<string, Pick<IEntrypointDependency, 'resolved'>>(
        [
          ['./left.js', { resolved: leftName }],
          ['./right.js', { resolved: rightName }],
        ]
      );
      const { cache } = setupCacheWithEntrypoint(
        rootName,
        rootContent,
        rootDeps
      );

      cache.add('entrypoints', leafName, leafEntrypoint as any);
      cache.add('entrypoints', leftName, leftEntrypoint as any);
      cache.add('entrypoints', rightName, rightEntrypoint as any);

      mockedStatSync.mockImplementation((path) => {
        switch (path) {
          case leafName:
            return { mtimeMs: 101 } as fs.Stats;
          case leftName:
            return { mtimeMs: 202 } as fs.Stats;
          case rightName:
            return { mtimeMs: 303 } as fs.Stats;
          default:
            throw new Error(`Unexpected statSync call: ${String(path)}`);
        }
      });

      cache.invalidateIfChanged(leafName, leafContent, undefined, 'fs');
      cache.invalidateIfChanged(leftName, leftContent, undefined, 'fs');
      cache.invalidateIfChanged(rightName, rightContent, undefined, 'fs');

      mockedReadFileSync.mockClear();
      mockedStatSync.mockClear();

      const invalidated = cache.invalidateIfChanged(rootName, rootContent);

      expect(invalidated).toBe(false);
      expect(cache.has('entrypoints', rootName)).toBe(true);
      expect(cache.has('entrypoints', leftName)).toBe(true);
      expect(cache.has('entrypoints', rightName)).toBe(true);
      expect(cache.has('entrypoints', leafName)).toBe(true);
      expect(mockedReadFileSync).not.toHaveBeenCalled();

      const statCalls = mockedStatSync.mock.calls.map(([path]) => path);
      expect(statCalls.filter((path) => path === leafName)).toHaveLength(1);
      expect(statCalls.filter((path) => path === leftName)).toHaveLength(1);
      expect(statCalls.filter((path) => path === rightName)).toHaveLength(1);
    });

    it('should invalidate parent when an invalidation-only dependency changed', () => {
      const depName = 'barrel.js';
      const depContent = 'export { b } from "./leaf.js";';
      const newDepContent = 'export { c } from "./leaf.js";';
      const parentName = 'parent.js';
      const parentContent = 'const value = 1;';

      const { entrypoint: depEntrypoint } = setupCacheWithEntrypoint(
        depName,
        depContent
      );

      const invalidationDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([['./barrel.js', { resolved: depName }]]);
      const { cache } = setupCacheWithEntrypoint(
        parentName,
        parentContent,
        new Map(),
        invalidationDeps
      );

      cache.add('entrypoints', depName, depEntrypoint as any);
      cache.invalidateIfChanged(depName, depContent, undefined, 'fs');

      mockedReadFileSync.mockImplementation((path) => {
        if (path === depName) {
          return newDepContent;
        }
        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      const invalidated = cache.invalidateIfChanged(parentName, parentContent);

      expect(invalidated).toBe(true);
      expect(cache.has('entrypoints', parentName)).toBe(false);
      expect(cache.has('entrypoints', depName)).toBe(false);
      expect(mockedReadFileSync).toHaveBeenCalledWith(depName, 'utf8');
    });

    it('strips ?query/#hash from dependency filenames before reading', () => {
      const depName = 'dep.js';
      const depContent = 'export const b = 2;';
      const parentName = 'parent.js';
      const parentContent = 'import { b } from "./dep.js?raw"; console.log(b);';

      const { entrypoint: depEntrypoint } = setupCacheWithEntrypoint(
        depName,
        depContent
      );

      const parentDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([['./dep.js?raw', { resolved: `${depName}?raw` }]]);
      const { cache } = setupCacheWithEntrypoint(
        parentName,
        parentContent,
        parentDeps
      );

      cache.add('entrypoints', depName, depEntrypoint as any);
      cache.invalidateIfChanged(depName, depContent, undefined, 'fs');

      mockedReadFileSync.mockImplementation((path) => {
        if (path === depName) {
          return depContent;
        }

        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      expect(() =>
        cache.invalidateIfChanged(parentName, parentContent)
      ).not.toThrow();
      expect(mockedReadFileSync).toHaveBeenCalledWith(depName, 'utf8');
      expect(mockedReadFileSync).not.toHaveBeenCalledWith(
        `${depName}?raw`,
        'utf8'
      );
    });

    it('should invalidate recursive dependency if its content changed', () => {
      const leafName = 'leaf.js';
      const leafContent = 'export const c = 3;';
      const newLeafContent = 'export const c = 4;';
      const intermediateName = 'intermediate.js';
      const intermediateContent =
        'import { c } from "./leaf.js"; export const b = c + 1;';
      const rootName = 'root.js';
      const rootContent =
        'import { b } from "./intermediate.js"; console.log(b);';

      // Setup leaf
      const { entrypoint: leafEntrypoint } = setupCacheWithEntrypoint(
        leafName,
        leafContent
      );

      // Setup intermediate
      const intermediateDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([['./leaf.js', { resolved: leafName }]]);
      const { entrypoint: intermediateEntrypoint } = setupCacheWithEntrypoint(
        intermediateName,
        intermediateContent,
        intermediateDeps
      );

      // Setup root
      const rootDeps = new Map<string, Pick<IEntrypointDependency, 'resolved'>>(
        [['./intermediate.js', { resolved: intermediateName }]]
      );
      const { cache } = setupCacheWithEntrypoint(
        rootName,
        rootContent,
        rootDeps
      );

      // Add all to the main cache
      cache.add('entrypoints', leafName, leafEntrypoint as any);
      cache.add('entrypoints', intermediateName, intermediateEntrypoint as any);
      cache.invalidateIfChanged(leafName, leafContent, undefined, 'fs');

      // Mock fs read to return new content for the leaf dependency
      mockedReadFileSync.mockImplementation((path) => {
        if (path === leafName) {
          return newLeafContent;
        }
        if (path === intermediateName) {
          // intermediate content hasn't actually changed on disk
          return intermediateContent;
        }
        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      const invalidated = cache.invalidateIfChanged(
        rootName,
        rootContent // Root content itself hasn't changed
      );

      expect(invalidated).toBe(true); // Root invalidated due to transitive dep change
      expect(cache.has('entrypoints', rootName)).toBe(false); // Root evicted
      expect(cache.has('entrypoints', intermediateName)).toBe(false); // Intermediate evicted
      expect(cache.has('entrypoints', leafName)).toBe(false); // Leaf dependency invalidated
      expect(mockedReadFileSync).toHaveBeenCalledWith(intermediateName, 'utf8');
      expect(mockedReadFileSync).toHaveBeenCalledWith(leafName, 'utf8');
    });

    it('should not crash when a dependency file has been deleted', () => {
      const depName = 'deleted-dep.js';
      const depContent = 'export const x = 1;';
      const parentName = 'parent.js';
      const parentContent = 'import { x } from "./deleted-dep.js";';

      const { entrypoint: depEntrypoint } = setupCacheWithEntrypoint(
        depName,
        depContent
      );

      const parentDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([['./deleted-dep.js', { resolved: depName }]]);
      const { cache } = setupCacheWithEntrypoint(
        parentName,
        parentContent,
        parentDeps
      );

      cache.add('entrypoints', depName, depEntrypoint as any);
      cache.invalidateIfChanged(depName, depContent, undefined, 'fs');

      const enoent = createErrnoError(
        'ENOENT',
        "ENOENT: no such file or directory, open 'deleted-dep.js'"
      );

      mockedReadFileSync.mockImplementation((path) => {
        if (path === depName) {
          throw enoent;
        }
        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      expect(() =>
        cache.invalidateIfChanged(parentName, parentContent)
      ).not.toThrow();
      expect(cache.has('entrypoints', depName)).toBe(false);
      expect(cache.has('entrypoints', parentName)).toBe(false);
    });

    it('should rethrow non-missing dependency read errors', () => {
      const depName = 'protected-dep.js';
      const depContent = 'export const x = 1;';
      const parentName = 'parent.js';
      const parentContent = 'import { x } from "./protected-dep.js";';

      const { entrypoint: depEntrypoint } = setupCacheWithEntrypoint(
        depName,
        depContent
      );

      const parentDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([['./protected-dep.js', { resolved: depName }]]);
      const { cache } = setupCacheWithEntrypoint(
        parentName,
        parentContent,
        parentDeps
      );

      cache.add('entrypoints', depName, depEntrypoint as any);
      cache.invalidateIfChanged(depName, depContent, undefined, 'fs');

      const eacces = createErrnoError(
        'EACCES',
        "EACCES: permission denied, open 'protected-dep.js'"
      );

      mockedReadFileSync.mockImplementation((path) => {
        if (path === depName) {
          throw eacces;
        }
        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      expect(() =>
        cache.invalidateIfChanged(parentName, parentContent)
      ).toThrow(eacces);
      expect(cache.has('entrypoints', depName)).toBe(true);
      expect(cache.has('entrypoints', parentName)).toBe(true);
    });

    it('should invalidate deleted dependency cache entries for all cache types', () => {
      const depName = 'deleted-dep.js';
      const depContent = 'export const x = 1;';
      const parentName = 'parent.js';
      const parentContent = 'import { x } from "./deleted-dep.js";';

      const { entrypoint: depEntrypoint } = setupCacheWithEntrypoint(
        depName,
        depContent
      );

      const parentDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([['./deleted-dep.js', { resolved: depName }]]);
      const { cache } = setupCacheWithEntrypoint(
        parentName,
        parentContent,
        parentDeps
      );

      cache.add('entrypoints', depName, depEntrypoint as any);
      cache.add('exports', depName, ['x']);
      cache.invalidateIfChanged(depName, depContent, undefined, 'fs');

      mockedReadFileSync.mockImplementation(() => {
        throw createErrnoError('ENOENT');
      });

      cache.invalidateIfChanged(parentName, parentContent);

      expect(cache.has('entrypoints', depName)).toBe(false);
      expect(cache.has('exports', depName)).toBe(false);
    });

    it('should continue processing other dependencies when one is deleted', () => {
      const deletedDep = 'deleted.js';
      const deletedContent = 'export const a = 1;';
      const aliveDep = 'alive.js';
      const aliveContent = 'export const b = 2;';
      const newAliveContent = 'export const b = 3;';
      const parentName = 'parent.js';
      const parentContent =
        'import { a } from "./deleted"; import { b } from "./alive";';

      const { entrypoint: deletedEntrypoint } = setupCacheWithEntrypoint(
        deletedDep,
        deletedContent
      );
      const { entrypoint: aliveEntrypoint } = setupCacheWithEntrypoint(
        aliveDep,
        aliveContent
      );

      const parentDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([
        ['./deleted', { resolved: deletedDep }],
        ['./alive', { resolved: aliveDep }],
      ]);
      const { cache } = setupCacheWithEntrypoint(
        parentName,
        parentContent,
        parentDeps
      );

      cache.add('entrypoints', deletedDep, deletedEntrypoint as any);
      cache.add('entrypoints', aliveDep, aliveEntrypoint as any);
      cache.invalidateIfChanged(deletedDep, deletedContent, undefined, 'fs');
      cache.invalidateIfChanged(aliveDep, aliveContent, undefined, 'fs');

      mockedReadFileSync.mockImplementation((path) => {
        if (path === deletedDep) {
          throw createErrnoError('ENOENT');
        }
        if (path === aliveDep) {
          return newAliveContent;
        }
        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      cache.invalidateIfChanged(parentName, parentContent);

      expect(cache.has('entrypoints', deletedDep)).toBe(false);
      expect(cache.has('entrypoints', aliveDep)).toBe(false);
      expect(cache.has('entrypoints', parentName)).toBe(false);
    });

    it('should handle all dependencies being deleted', () => {
      const dep1 = 'dep1.js';
      const dep1Content = 'export const a = 1;';
      const dep2 = 'dep2.js';
      const dep2Content = 'export const b = 2;';
      const parentName = 'parent.js';
      const parentContent =
        'import { a } from "./dep1"; import { b } from "./dep2";';

      const { entrypoint: dep1Entrypoint } = setupCacheWithEntrypoint(
        dep1,
        dep1Content
      );
      const { entrypoint: dep2Entrypoint } = setupCacheWithEntrypoint(
        dep2,
        dep2Content
      );

      const parentDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([
        ['./dep1', { resolved: dep1 }],
        ['./dep2', { resolved: dep2 }],
      ]);
      const { cache } = setupCacheWithEntrypoint(
        parentName,
        parentContent,
        parentDeps
      );

      cache.add('entrypoints', dep1, dep1Entrypoint as any);
      cache.add('entrypoints', dep2, dep2Entrypoint as any);

      mockedReadFileSync.mockImplementation(() => {
        throw createErrnoError('ENOENT');
      });

      expect(() =>
        cache.invalidateIfChanged(parentName, parentContent)
      ).not.toThrow();
      expect(cache.has('entrypoints', dep1)).toBe(false);
      expect(cache.has('entrypoints', dep2)).toBe(false);
      expect(cache.has('entrypoints', parentName)).toBe(false);
    });

    it('should handle deleted dependency in recursive chain', () => {
      const leafName = 'leaf.js';
      const leafContent = 'export const c = 3;';
      const intermediateName = 'intermediate.js';
      const intermediateContent =
        'import { c } from "./leaf.js"; export const b = c;';
      const rootName = 'root.js';
      const rootContent = 'import { b } from "./intermediate.js";';

      const { entrypoint: leafEntrypoint } = setupCacheWithEntrypoint(
        leafName,
        leafContent
      );

      const intermediateDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([['./leaf.js', { resolved: leafName }]]);
      const { entrypoint: intermediateEntrypoint } = setupCacheWithEntrypoint(
        intermediateName,
        intermediateContent,
        intermediateDeps
      );

      const rootDeps = new Map<string, Pick<IEntrypointDependency, 'resolved'>>(
        [['./intermediate.js', { resolved: intermediateName }]]
      );
      const { cache } = setupCacheWithEntrypoint(
        rootName,
        rootContent,
        rootDeps
      );

      cache.add('entrypoints', leafName, leafEntrypoint as any);
      cache.add('entrypoints', intermediateName, intermediateEntrypoint as any);
      cache.invalidateIfChanged(leafName, leafContent, undefined, 'fs');

      mockedReadFileSync.mockImplementation((path) => {
        if (path === intermediateName) {
          return intermediateContent;
        }
        if (path === leafName) {
          throw createErrnoError('ENOENT');
        }
        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      expect(() =>
        cache.invalidateIfChanged(rootName, rootContent)
      ).not.toThrow();
      expect(cache.has('entrypoints', leafName)).toBe(false);
      expect(cache.has('entrypoints', intermediateName)).toBe(false);
      expect(cache.has('entrypoints', rootName)).toBe(false);
    });

    it('should handle deleted dependency with query/hash in resolved path', () => {
      const depName = 'dep.js';
      const depContent = 'export const x = 1;';
      const parentName = 'parent.js';
      const parentContent = 'import { x } from "./dep.js?raw";';

      const { entrypoint: depEntrypoint } = setupCacheWithEntrypoint(
        depName,
        depContent
      );

      const resolvedWithQuery = `${depName}?raw`;
      const parentDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([['./dep.js?raw', { resolved: resolvedWithQuery }]]);
      const { cache } = setupCacheWithEntrypoint(
        parentName,
        parentContent,
        parentDeps
      );

      cache.add('entrypoints', resolvedWithQuery, depEntrypoint as any);

      mockedReadFileSync.mockImplementation((path) => {
        if (path === depName) {
          throw createErrnoError('ENOENT');
        }
        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      expect(() =>
        cache.invalidateIfChanged(parentName, parentContent)
      ).not.toThrow();
      expect(cache.has('entrypoints', resolvedWithQuery)).toBe(false);
      expect(mockedReadFileSync).toHaveBeenCalledWith(depName, 'utf8');
    });

    it('should handle cyclic dependencies without infinite recursion', () => {
      const fileA = 'a.js';
      const contentA = 'import { b } from "./b.js"; export const a = () => b;';
      const fileB = 'b.js';
      const contentB = 'import { a } from "./a.js"; export const b = () => a;';

      const depsA = new Map<string, Pick<IEntrypointDependency, 'resolved'>>([
        ['./b.js', { resolved: fileB }],
      ]);
      const depsB = new Map<string, Pick<IEntrypointDependency, 'resolved'>>([
        ['./a.js', { resolved: fileA }],
      ]);

      const { cache } = setupCacheWithEntrypoint(fileA, contentA, depsA);
      const { entrypoint: entryB } = setupCacheWithEntrypoint(
        fileB,
        contentB,
        depsB
      );

      cache.add('entrypoints', fileB, entryB as any);

      mockedReadFileSync.mockImplementation((path) => {
        if (path === fileB) {
          return contentB;
        }
        if (path === fileA) {
          return contentA;
        }
        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      const invalidated = cache.invalidateIfChanged(fileA, contentA);

      expect(invalidated).toBe(false);
      expect(cache.has('entrypoints', fileA)).toBe(true);
      expect(cache.has('entrypoints', fileB)).toBe(true);
      expect(mockedReadFileSync).toHaveBeenCalledWith(fileB, 'utf8');
      expect(mockedReadFileSync).not.toHaveBeenCalledWith(fileA, 'utf8');
      expect(mockedReadFileSync).toHaveBeenCalledTimes(1);
    });

    it('should invalidate parent when dependency content changed', () => {
      const depName = 'dep.js';
      const depContent = 'export const b = 2;';
      const newDepContent = 'export const b = 3;';
      const parentName = 'parent.js';
      const parentContent = 'import { b } from "./dep.js"; console.log(b);';

      const { entrypoint: depEntrypoint } = setupCacheWithEntrypoint(
        depName,
        depContent
      );

      const parentDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([['./dep.js', { resolved: depName }]]);
      const { cache } = setupCacheWithEntrypoint(
        parentName,
        parentContent,
        parentDeps
      );

      cache.add('entrypoints', depName, depEntrypoint as any);
      cache.invalidateIfChanged(depName, depContent, undefined, 'fs');

      mockedReadFileSync.mockImplementation((path) => {
        if (path === depName) {
          return newDepContent;
        }
        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      const invalidated = cache.invalidateIfChanged(parentName, parentContent);

      expect(invalidated).toBe(true);
      expect(cache.has('entrypoints', parentName)).toBe(false);
      expect(cache.has('entrypoints', depName)).toBe(false);
    });

    it('should invalidate root when recursive (transitive) dependency changed', () => {
      const leafName = 'leaf.js';
      const leafContent = 'export const c = 3;';
      const newLeafContent = 'export const c = 4;';
      const intermediateName = 'intermediate.js';
      const intermediateContent =
        'import { c } from "./leaf.js"; export const b = c + 1;';
      const rootName = 'root.js';
      const rootContent =
        'import { b } from "./intermediate.js"; console.log(b);';

      const { entrypoint: leafEntrypoint } = setupCacheWithEntrypoint(
        leafName,
        leafContent
      );

      const intermediateDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([['./leaf.js', { resolved: leafName }]]);
      const { entrypoint: intermediateEntrypoint } = setupCacheWithEntrypoint(
        intermediateName,
        intermediateContent,
        intermediateDeps
      );

      const rootDeps = new Map<string, Pick<IEntrypointDependency, 'resolved'>>(
        [['./intermediate.js', { resolved: intermediateName }]]
      );
      const { cache } = setupCacheWithEntrypoint(
        rootName,
        rootContent,
        rootDeps
      );

      cache.add('entrypoints', leafName, leafEntrypoint as any);
      cache.add('entrypoints', intermediateName, intermediateEntrypoint as any);
      cache.invalidateIfChanged(leafName, leafContent, undefined, 'fs');

      mockedReadFileSync.mockImplementation((path) => {
        if (path === leafName) {
          return newLeafContent;
        }
        if (path === intermediateName) {
          return intermediateContent;
        }
        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      const invalidated = cache.invalidateIfChanged(rootName, rootContent);

      expect(invalidated).toBe(true);
      expect(cache.has('entrypoints', rootName)).toBe(false);
      expect(cache.has('entrypoints', intermediateName)).toBe(false);
      expect(cache.has('entrypoints', leafName)).toBe(false);
    });

    it('should still invalidate cyclic dependency content changes', () => {
      const fileA = 'a.js';
      const contentA = 'import { b } from "./b.js"; export const a = () => b;';
      const fileB = 'b.js';
      const contentB = 'import { a } from "./a.js"; export const b = () => a;';
      const newContentB = 'import { a } from "./a.js"; export const b = 42;';

      const depsA = new Map<string, Pick<IEntrypointDependency, 'resolved'>>([
        ['./b.js', { resolved: fileB }],
      ]);
      const depsB = new Map<string, Pick<IEntrypointDependency, 'resolved'>>([
        ['./a.js', { resolved: fileA }],
      ]);

      const { cache } = setupCacheWithEntrypoint(fileA, contentA, depsA);
      const { entrypoint: entryB } = setupCacheWithEntrypoint(
        fileB,
        contentB,
        depsB
      );

      cache.add('entrypoints', fileB, entryB as any);

      mockedReadFileSync.mockImplementation((path) => {
        if (path === fileA) {
          return contentA;
        }
        if (path === fileB) {
          return contentB;
        }
        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      const invalidated = cache.invalidateIfChanged(fileB, newContentB);

      expect(invalidated).toBe(true);
      expect(cache.has('entrypoints', fileB)).toBe(false);
      expect(cache.has('entrypoints', fileA)).toBe(true);
      expect(mockedReadFileSync).toHaveBeenCalledWith(fileA, 'utf8');
      expect(mockedReadFileSync).not.toHaveBeenCalledWith(fileB, 'utf8');
    });
  });

  describe('consumeInvalidation', () => {
    it('consumes invalidation once per query/hash variant', () => {
      const cache = new TransformCacheCollection();
      const filename = '/tmp/data.txt';

      cache.invalidateForFile(filename);

      expect(cache.consumeInvalidation(`${filename}?raw`)).toBe(true);
      expect(cache.consumeInvalidation(`${filename}?url`)).toBe(true);
      expect(cache.consumeInvalidation(`${filename}#v1`)).toBe(true);

      expect(cache.consumeInvalidation(`${filename}?raw`)).toBe(false);
      expect(cache.consumeInvalidation(`${filename}?url`)).toBe(false);
      expect(cache.consumeInvalidation(`${filename}#v1`)).toBe(false);
    });

    it('re-invalidates all variants after the same file changes again', () => {
      const cache = new TransformCacheCollection();
      const filename = '/tmp/data.txt';

      cache.invalidateForFile(filename);
      expect(cache.consumeInvalidation(`${filename}?raw`)).toBe(true);
      expect(cache.consumeInvalidation(`${filename}?url`)).toBe(true);

      cache.invalidateForFile(filename);
      expect(cache.consumeInvalidation(`${filename}?raw`)).toBe(true);
      expect(cache.consumeInvalidation(`${filename}?url`)).toBe(true);
    });
  });

  it('removes entry and content hash when value is undefined', () => {
    const filename = 'empty-style.js';
    const content = '';
    const { cache } = setupCacheWithEntrypoint(filename, content);

    // @ts-expect-error accessing private field for assertions
    const { contentHashes } = cache;

    expect(cache.has('entrypoints', filename)).toBe(true);
    expect(contentHashes.has(filename)).toBe(true);

    expect(() => {
      cache.add('entrypoints', filename, undefined as any);
    }).not.toThrow();

    expect(cache.has('entrypoints', filename)).toBe(false);
    expect(contentHashes.has(filename)).toBe(false);
  });
});
