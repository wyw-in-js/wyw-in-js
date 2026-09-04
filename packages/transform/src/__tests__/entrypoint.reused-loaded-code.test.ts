import fs from 'fs';
import os from 'os';
import path from 'path';

import * as babel from '@babel/core';

import { logger } from '@wyw-in-js/shared';
import type { StrictOptions } from '@wyw-in-js/shared';

import { TransformCacheCollection } from '../cache';
import { shaker } from '../shaker';
import { Entrypoint } from '../transform/Entrypoint';
import { loadAndParse } from '../transform/Entrypoint.helpers';
import type { Services } from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';

const pluginOptions: StrictOptions = {
  babelOptions: {
    babelrc: false,
    configFile: false,
  },
  displayName: false,
  extensions: ['.cjs', '.js', '.jsx', '.ts', '.tsx'],
  features: {
    dangerousCodeRemover: true,
    globalCache: true,
    happyDOM: true,
    softErrors: false,
    useBabelConfigs: true,
    useWeakRefInEval: true,
  },
  highPriorityPlugins: [],
  rules: [{ test: () => true, action: shaker }],
};

const createServices = (
  cache: TransformCacheCollection,
  filename: string
): Services => ({
  babel,
  cache,
  emitWarning: jest.fn(),
  loadAndParseFn: loadAndParse,
  log: logger,
  eventEmitter: EventEmitter.dummy,
  options: {
    filename,
    pluginOptions,
  },
});

// The bundler hands wyw the output of the loaders that ran before it, which
// routinely differs from the bytes on disk. A root created without code for
// such a file (on-demand eval preparation, an analysis root) reuses that
// loaded code from the cached generation instead of reading the disk. The new
// generation must record it as loaded code: hashed as the disk content it
// looks like an edit, evicts the cached generation, forgets its dependency
// snapshot and flips the fs hash, so the next check of any importer finds an
// unfinished module without a graph and resets the shared cache.
describe('Entrypoint: root without code reuses the loaded code of the cached generation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-reused-loaded-'));
  const depFile = path.join(root, 'dep.ts');
  const parentFile = path.join(root, 'parent.ts');
  const depOnDisk = `export const token = 'red';\n`;
  // What a preceding loader handed over for dep.ts.
  const depLoaded = `export const token = 'red'; // transpiled\n`;
  const parentCode = `import { token } from './dep';\nexport const a = token;\n`;

  let cache: TransformCacheCollection;
  let services: Services;

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.writeFileSync(depFile, depOnDisk);
    fs.writeFileSync(parentFile, parentCode);

    cache = new TransformCacheCollection();
    services = createServices(cache, parentFile);

    // The bundler transformed dep.ts with its loaded code and evaluated it.
    const dep = Entrypoint.createRoot(
      services,
      depFile,
      ['__wywPreval'],
      depLoaded
    );
    dep.setTransformResult({ code: depLoaded, metadata: null });
    cache.add('entrypoints', depFile, dep.createEvaluated(services));

    // A static read of dep.ts seeded its fs hash from the disk content.
    expect(cache.checkFreshness(depFile, depFile)).toBe(false);

    const parent = Entrypoint.createRoot(
      services,
      parentFile,
      ['__wywPreval'],
      parentCode
    );
    parent.addDependency({
      only: ['token'],
      resolved: depFile,
      source: './dep',
    });
    parent.setTransformResult({ code: parentCode, metadata: null });

    expect(
      cache.invalidateIfChangedWithDetails(parentFile, parentCode)
    ).toEqual({
      changed: false,
      unknownDependencyGraphs: new Set(),
    });
  });

  it('keeps the loaded code as loaded code', () => {
    const reprocessed = Entrypoint.createRoot(services, depFile, ['*']);

    expect(reprocessed.initialCode).toBe(depLoaded);
    expect(reprocessed.originalCode).toBe(depLoaded);
  });

  it('does not report the reused code as a change of the file', () => {
    Entrypoint.createRoot(services, depFile, ['*']);

    expect(
      cache.invalidateIfChangedWithDetails(parentFile, parentCode)
    ).toEqual({
      changed: false,
      unknownDependencyGraphs: new Set(),
    });
    // The disk content still matches the fs hash: no flip-flop between the
    // two representations.
    expect(cache.checkFreshness(depFile, depFile)).toBe(false);
  });

  it('still detects an edit of the file on disk', () => {
    Entrypoint.createRoot(services, depFile, ['*']);

    fs.writeFileSync(depFile, `export const token = 'blue';\n`);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(depFile, later, later);

    expect(cache.checkFreshness(depFile, depFile)).toBe(true);
    expect(
      cache.invalidateIfChangedWithDetails(parentFile, parentCode).changed
    ).toBe(true);
  });
});
