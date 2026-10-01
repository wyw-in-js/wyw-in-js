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

// Loaded bytes and raw disk bytes are different representations. The cache
// records a raw baseline at publication, so later probes compare raw bytes
// even when a loader transforms them or an edit preserves the timestamp.
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

  it('detects changed disk bytes before first fs probe at unchanged mtime', () => {
    iconContentOnDisk = 'export const Icon = () => "changed";';

    expect(cache.checkFreshness(iconName, iconName)).toBe(true);
    expect(cache.get('entrypoints', iconName)).toBeUndefined();
  });

  it('does not refresh the raw baseline when loaded code is republished', () => {
    iconContentOnDisk = 'export const Icon = () => "changed";';
    publishIcon(2);

    expect(cache.checkFreshness(iconName, iconName)).toBe(true);
    expect(cache.get('entrypoints', iconName)).toBeUndefined();
  });

  it('invalidates a virtual source when its first disk revision differs', () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('Virtual source has no disk baseline');
    });
    cache = new TransformCacheCollection<MockEntrypoint>();
    publishIcon(1);
    mockedReadFileSync.mockImplementation(() => iconContentOnDisk);

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
