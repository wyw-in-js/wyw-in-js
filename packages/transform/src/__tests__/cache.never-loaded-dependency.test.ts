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
  processingStarted?: boolean;
  transformed?: boolean;
};

const mockedReadFileSync = jest.spyOn(fs, 'readFileSync');
const mockedStatSync = jest.spyOn(fs, 'statSync');

// Static preeval and side-effect provenance register the files they read as
// invalidation dependencies through checkFreshness. Such a file is never loaded
// as a module, so it can never gain an entrypoint or a dependency snapshot. The
// unknown-graph guard must not mistake it for an evicted module whose
// transitive graph was lost: that resets the whole cache on every check and,
// because the file can never satisfy the guard, the recovery never converges.
describe('TransformCacheCollection: dependency that was never an entrypoint', () => {
  const parentName = 'parent.js';
  const parentContent =
    'import { theme } from "./theme.js"; console.log(theme);';
  const themeName = 'theme.js';
  const themeContent =
    'import { reset } from "./reset.js"; export const theme = { reset };';
  const resetName = 'reset.js';
  const resetContent = 'export const reset = "* { margin: 0 }";';

  let cache: TransformCacheCollection<MockEntrypoint>;
  let resetContentOnDisk: string;
  let resetMtime: number;

  const publishTheme = (generation: number) => {
    cache.add('entrypoints', themeName, {
      name: themeName,
      initialCode: themeContent,
      dependencies: new Map(),
      invalidationDependencies: new Map([
        ['./reset.js', { resolved: resetName }],
      ]),
      invalidateOnDependencyChange: new Set([resetName]),
      generation,
    });
  };

  const publishParent = (generation: number) => {
    cache.add('entrypoints', parentName, {
      name: parentName,
      initialCode: parentContent,
      dependencies: new Map([['./theme.js', { resolved: themeName }]]),
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
    resetContentOnDisk = resetContent;
    resetMtime = 200;
    mockedStatSync.mockReset();
    mockedStatSync.mockImplementation((path) => {
      if (path === themeName) return { mtimeMs: 123 } as fs.Stats;
      if (path === resetName) return { mtimeMs: resetMtime } as fs.Stats;
      throw new Error(`Unexpected statSync call: ${String(path)}`);
    });
    mockedReadFileSync.mockReset();
    mockedReadFileSync.mockImplementation((path) => {
      if (path === themeName) return themeContent;
      if (path === resetName) return resetContentOnDisk;
      throw new Error(`Unexpected readFileSync call: ${String(path)}`);
    });

    cache = new TransformCacheCollection<MockEntrypoint>();

    // reset.js is only ever seen through checkFreshness: it gets an mtime and
    // an fs content hash, but no entrypoint and no snapshot.
    cache.checkFreshness(resetName, resetName);

    cache.invalidateIfChanged(themeName, themeContent, undefined, 'fs');
    publishTheme(1);
    publishParent(1);
  });

  it('treats the dependency graph as known', () => {
    expect(checkParent()).toEqual({
      changed: false,
      unknownDependencyGraphs: new Set(),
    });
    expect(cache.get('entrypoints', parentName)).toBeDefined();
  });

  it('still detects a content change of that file', () => {
    resetContentOnDisk = 'export const reset = "* { margin: 1px }";';
    resetMtime += 1;

    expect(checkParent()).toEqual({
      changed: true,
      unknownDependencyGraphs: new Set(),
    });
    expect(cache.get('entrypoints', parentName)).toBeUndefined();
  });

  it('still detects a content change behind an unchanged mtime', () => {
    // invalidateOnDependencyChange forces a hash check for this file.
    resetContentOnDisk = 'export const reset = "* { margin: 1px }";';

    expect(checkParent().changed).toBe(true);
    expect(mockedReadFileSync).toHaveBeenCalledWith(resetName, 'utf8');
  });

  it('treats a live analysis root that never started processing as known', () => {
    // resolveDependency publishes Entrypoint.createRoot(reset.js, ['reset'])
    // to resolve an import through reset.js. It only resolves imports; its
    // dependency map is partial and it never gets a transform result.
    cache.add('entrypoints', resetName, {
      name: resetName,
      initialCode: undefined,
      dependencies: new Map([['./base.js', { resolved: 'base.js' }]]),
      invalidationDependencies: new Map(),
      generation: 1,
      processingStarted: false,
      transformed: false,
    });

    expect(checkParent()).toEqual({
      changed: false,
      unknownDependencyGraphs: new Set(),
    });
    // base.js was never checked: the analysis root is a leaf for theme.js.
    expect(mockedStatSync).not.toHaveBeenCalledWith('base.js');
  });

  it('still detects a content change of a live analysis root', () => {
    cache.add('entrypoints', resetName, {
      name: resetName,
      initialCode: undefined,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 1,
      processingStarted: false,
      transformed: false,
    });
    resetContentOnDisk = 'export const reset = "* { margin: 1px }";';
    resetMtime += 1;

    expect(checkParent()).toEqual({
      changed: true,
      unknownDependencyGraphs: new Set(),
    });
    expect(cache.get('entrypoints', parentName)).toBeUndefined();
  });

  it('treats a module that is still being processed as a hash-verified leaf', () => {
    // Another transform is processing reset.js as a module right now. Its
    // dependency map is partial, but theme.js only read its bytes: the content
    // hash is the whole contract, exactly as for a never-loaded file.
    cache.add('entrypoints', resetName, {
      name: resetName,
      initialCode: resetContent,
      dependencies: new Map([['./base.js', { resolved: 'base.js' }]]),
      invalidationDependencies: new Map(),
      generation: 1,
      isProcessing: true,
      processingStarted: true,
      transformed: false,
    });

    expect(checkParent()).toEqual({
      changed: false,
      unknownDependencyGraphs: new Set(),
    });
    expect(mockedStatSync).not.toHaveBeenCalledWith('base.js');
  });

  it('still detects a content change of a module that is still being processed', () => {
    cache.add('entrypoints', resetName, {
      name: resetName,
      initialCode: resetContent,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 1,
      isProcessing: true,
      processingStarted: true,
      transformed: false,
    });
    resetContentOnDisk = 'export const reset = "* { margin: 1px }";';
    resetMtime += 1;

    expect(checkParent()).toEqual({
      changed: true,
      unknownDependencyGraphs: new Set(),
    });
    expect(cache.get('entrypoints', parentName)).toBeUndefined();
  });

  it('keeps a live unfinished module that started processing unknown', () => {
    cache.add('entrypoints', resetName, {
      name: resetName,
      initialCode: resetContent,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 1,
      processingStarted: true,
      transformed: false,
    });

    expect(checkParent()).toEqual({
      changed: true,
      unknownDependencyGraphs: new Set([resetName]),
    });
  });

  it('keeps a module evicted mid-processing unknown', () => {
    cache.add('entrypoints', resetName, {
      name: resetName,
      initialCode: resetContent,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 1,
      isProcessing: true,
    });
    cache.delete('entrypoints', resetName);

    expect(checkParent()).toEqual({
      changed: true,
      unknownDependencyGraphs: new Set([resetName]),
    });
  });

  it('forgets the entrypoint history together with the entrypoint cache', () => {
    cache.add('entrypoints', resetName, {
      name: resetName,
      initialCode: resetContent,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 1,
      isProcessing: true,
    });
    cache.delete('entrypoints', resetName);
    cache.clear('entrypoints');

    cache.checkFreshness(resetName, resetName);
    cache.invalidateIfChanged(themeName, themeContent, undefined, 'fs');
    publishTheme(2);
    publishParent(2);

    expect(checkParent()).toEqual({
      changed: false,
      unknownDependencyGraphs: new Set(),
    });
  });

  it('seeds the history from a pre-populated entrypoint cache', () => {
    const entrypoints = new Map<string, MockEntrypoint>([
      [
        resetName,
        {
          name: resetName,
          initialCode: resetContent,
          dependencies: new Map(),
          invalidationDependencies: new Map(),
          generation: 1,
          isProcessing: true,
        },
      ],
    ]);
    cache = new TransformCacheCollection<MockEntrypoint>({ entrypoints });
    cache.delete('entrypoints', resetName);
    cache.checkFreshness(resetName, resetName);
    cache.invalidateIfChanged(themeName, themeContent, undefined, 'fs');
    publishTheme(1);
    publishParent(1);

    expect(checkParent().unknownDependencyGraphs).toEqual(new Set([resetName]));
  });
});
