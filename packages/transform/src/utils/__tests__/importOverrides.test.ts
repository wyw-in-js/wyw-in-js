import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { applyImportOverride, findImportOverride } from '../importOverrides';

describe('findImportOverride', () => {
  it('keys file imports by their root-relative resolved path', () => {
    expect(
      findImportOverride({
        importOverrides: { './src/dep.ts': { noShake: true } },
        resolved: '/project/src/dep.ts',
        root: '/project',
        source: './dep',
      })
    ).toEqual({ key: './src/dep.ts', override: { noShake: true } });
  });

  it('keys package imports by their source and matches globs', () => {
    expect(
      findImportOverride({
        importOverrides: { '@scope/*': { unknown: 'allow' } },
        resolved: '/project/node_modules/@scope/pkg/index.js',
        root: '/project',
        source: '@scope/pkg',
      })
    ).toEqual({ key: '@scope/pkg', override: { unknown: 'allow' } });
  });

  it('reports the key even without overrides', () => {
    expect(
      findImportOverride({
        importOverrides: undefined,
        resolved: null,
        root: '/project',
        source: 'pkg',
      })
    ).toEqual({ key: 'pkg', override: undefined });
  });
});

describe('applyImportOverride', () => {
  let root: string;
  let importer: string;

  beforeEach(() => {
    root = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'wyw-import-overrides-'))
    );
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'mock.js'), 'export {};');
    importer = path.join(root, 'src', 'entry.js');
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it('returns null when no override matches', () => {
    const getStack = jest.fn(() => [importer]);

    expect(
      applyImportOverride({
        getStack,
        importOverrides: { other: { noShake: true } },
        importer,
        only: ['a'],
        resolved: '/project/node_modules/pkg/index.js',
        root,
        source: 'pkg',
      })
    ).toBeNull();
    expect(getStack).not.toHaveBeenCalled();
  });

  it('disables shaking for noShake overrides', () => {
    expect(
      applyImportOverride({
        getStack: () => [importer],
        importOverrides: { pkg: { noShake: true } },
        importer,
        only: ['a'],
        resolved: '/project/node_modules/pkg/index.js',
        root,
        source: 'pkg',
      })
    ).toEqual({
      mocked: false,
      only: ['*'],
      resolved: '/project/node_modules/pkg/index.js',
    });
  });

  it('resolves root-relative mocks, even for unresolved imports', () => {
    expect(
      applyImportOverride({
        getStack: () => [importer],
        importOverrides: { pkg: { mock: './src/mock.js' } },
        importer,
        only: ['a'],
        resolved: null,
        root,
        source: 'pkg',
      })
    ).toEqual({
      mocked: true,
      only: ['a'],
      resolved: path.join(root, 'src', 'mock.js'),
    });
  });
});
