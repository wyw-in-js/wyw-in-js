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

// A bundler loader hands transform() the output of the loaders before it, so
// the `loaded` code of an entrypoint routinely differs from the bytes on disk.
// A later fs read of the same file (checkFreshness from a dependency check) is
// only a freshness probe: while the disk mtime is the one seen at load time it
// must seed the fs hash, not evict the entrypoint the bundler still considers
// current. A moved mtime, or a bundler providing code for a file whose
// entrypoint was built from disk, stays a real change.
describe('TransformCacheCollection: loaded code differs from disk', () => {
  const iconName = 'icon.js';
  const iconOnDisk = 'export const Icon = () => null;';
  const iconLoaded = `${iconOnDisk}\n// appended by a previous loader\n`;
  const parentName = 'parent.js';
  const parentContent = 'import { Icon } from "./icon.js"; styled(Icon)``;';

  let cache: TransformCacheCollection<MockEntrypoint>;
  let iconContentOnDisk: string;
  let iconMtime: number;

  const publishIcon = (generation: number) => {
    cache.add('entrypoints', iconName, {
      name: iconName,
      initialCode: iconLoaded,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation,
    });
  };

  const publishParent = (generation: number) => {
    cache.add('entrypoints', parentName, {
      name: parentName,
      initialCode: parentContent,
      dependencies: new Map(),
      invalidationDependencies: new Map([
        ['./icon.js', { resolved: iconName }],
      ]),
      invalidateOnDependencyChange: new Set([iconName]),
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
    iconContentOnDisk = iconOnDisk;
    iconMtime = 200;
    mockedStatSync.mockReset();
    mockedStatSync.mockImplementation((path) => {
      if (path === iconName) return { mtimeMs: iconMtime } as fs.Stats;
      throw new Error(`Unexpected statSync call: ${String(path)}`);
    });
    mockedReadFileSync.mockReset();
    mockedReadFileSync.mockImplementation((path) => {
      if (path === iconName) return iconContentOnDisk;
      throw new Error(`Unexpected readFileSync call: ${String(path)}`);
    });

    cache = new TransformCacheCollection<MockEntrypoint>();
    publishIcon(1);
  });

  it('keeps the entrypoint when the first fs read differs from the loaded code', () => {
    expect(cache.checkFreshness(iconName, iconName)).toBe(false);

    expect(cache.get('entrypoints', iconName)).toBeDefined();
    publishParent(1);
    expect(checkParent()).toEqual({
      changed: false,
      unknownDependencyGraphs: new Set(),
    });
  });

  it('detects a later change on disk against the seeded fs hash', () => {
    cache.checkFreshness(iconName, iconName);
    publishParent(1);

    iconContentOnDisk = 'export const Icon = () => "changed";';
    iconMtime += 1;

    expect(checkParent().changed).toBe(true);
    expect(cache.get('entrypoints', iconName)).toBeUndefined();
  });

  it('treats differing disk bytes as a change when the file was modified after it was loaded', () => {
    iconMtime += 1;
    iconContentOnDisk = 'export const Icon = () => "changed";';

    expect(cache.checkFreshness(iconName, iconName)).toBe(true);
    expect(cache.get('entrypoints', iconName)).toBeUndefined();
  });

  it('still treats loaded code that differs from a disk-built entrypoint as a change', () => {
    cache = new TransformCacheCollection<MockEntrypoint>();
    cache.invalidateIfChanged(iconName, iconOnDisk, undefined, 'fs');
    cache.add('entrypoints', iconName, {
      name: iconName,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 1,
    });

    expect(cache.invalidateIfChanged(iconName, iconLoaded)).toBe(true);
    expect(cache.get('entrypoints', iconName)).toBeUndefined();
  });
});
