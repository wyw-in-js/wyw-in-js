import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Entrypoint } from '../Entrypoint';
import type { Services } from '../types';

import { createServices } from './entrypoint-helpers';

/* eslint-disable import/no-unresolved -- Bun is the package test runtime. */
// @ts-expect-error The package test runtime provides bun:test; the legacy spec
// typings in this repo only know the jest globals.
const {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest: bunJest,
  setSystemTime,
} = (await import('bun:test')) as {
  afterEach: (fn: () => void) => void;
  beforeEach: (fn: () => void) => void;
  describe: (name: string, fn: () => void) => void;
  expect: jest.Expect;
  it: (name: string, fn: () => void) => void;
  jest: typeof jest;
  setSystemTime: (date?: Date) => void;
};
/* eslint-enable import/no-unresolved */

(globalThis as typeof globalThis & { jest: typeof jest }).jest = bunJest;

const BASE_TIME = new Date('2026-01-01T00:00:00Z').getTime();
const STORM_LIMIT = 100;

// These tests intentionally keep TransformCacheCollection's real
// invalidateIfChanged implementation. An unknown dependency graph triggers
// the production invalidation path, including eviction of the cached parent;
// mocking the method to return true would miss the stale-output regression.
describe('supersede storm guard', () => {
  const only = ['__wywPreval'];
  const rootCode = 'export const token = "red";';
  const depCode = 'export const value = 1;';

  let depName: string;
  let name: string;
  let root: string;
  let services: Services;

  const createRootOnce = (loadedCode: string | undefined) =>
    Entrypoint.createRoot(services, name, only, loadedCode);

  const createUnknownGraph = () => {
    const depEntrypoint = Entrypoint.createRoot(
      services,
      depName,
      ['value'],
      depCode
    );
    depEntrypoint.beginProcessing();
    services.cache.invalidateIfChanged(depName, depCode, undefined, 'fs');
    services.cache.delete('entrypoints', depName);
    depEntrypoint.endProcessing();
  };

  const attachUnknownDependency = (entrypoint: Entrypoint) => {
    entrypoint.addDependency({
      only: ['value'],
      resolved: depName,
      source: './dep.js',
    });
  };

  const createParent = (loadedCode: string | undefined) => {
    const entrypoint = createRootOnce(loadedCode);
    attachUnknownDependency(entrypoint);
    return entrypoint;
  };

  const runInvalidations = (count: number, loadedCode: string | undefined) => {
    let last: Entrypoint | undefined;
    for (let i = 0; i < count; i += 1) {
      last = createRootOnce(loadedCode);
    }
    return last!;
  };

  beforeEach(() => {
    setSystemTime(new Date(BASE_TIME));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-supersede-storm-'));
    name = path.join(root, 'entry.ts');
    depName = path.join(root, 'dep.ts');
    fs.writeFileSync(name, rootCode);
    fs.writeFileSync(depName, depCode);

    services = createServices();
    services.loadAndParseFn = jest.fn((_services, filename, loadedCode) => ({
      ast: null as never,
      code: loadedCode ?? fs.readFileSync(filename, 'utf8'),
      evaluator: jest.fn(),
      evalConfig: {},
    }));

    createUnknownGraph();
  });

  afterEach(() => {
    setSystemTime();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fails safely after a real unknown-graph invalidation storm', () => {
    const first = createParent(rootCode);
    const last = runInvalidations(STORM_LIMIT, rootCode);
    let stormError: unknown;

    expect(last.generation).toBe(first.generation + STORM_LIMIT);
    try {
      createRootOnce(rootCode);
    } catch (error) {
      stormError = error;
    }
    expect(stormError).toBeInstanceOf(Error);
    expect((stormError as Error).message).toContain('Supersede storm detected');

    // invalidateIfChanged evicted the parent before the diagnostic. No stale
    // entrypoint is returned or silently put back into the cache. A workflow
    // that already retained it observes the same terminal error at its next
    // publication boundary.
    expect(services.cache.get('entrypoints', name)).toBeUndefined();
    let retainedError: unknown;
    try {
      last.assertNotSuperseded();
    } catch (error) {
      retainedError = error;
    }
    expect(retainedError).toBe(stormError);

    let ancestorError: unknown;
    try {
      first.assertNotSuperseded();
    } catch (error) {
      ancestorError = error;
    }
    expect(ancestorError).toBe(stormError);

    // Cache eviction must not reopen the same warm-eval retry loop. The
    // unchanged source remains blocked with the original diagnostic object.
    let retryError: unknown;
    try {
      createRootOnce(rootCode);
    } catch (error) {
      retryError = error;
    }
    expect(retryError).toBe(stormError);
  });

  it('unblocks a terminal storm after a real source edit', () => {
    createParent(rootCode);
    runInvalidations(STORM_LIMIT, rootCode);
    expect(() => createRootOnce(rootCode)).toThrow(/Supersede storm detected/);

    const nextCode = 'export const token = "blue";';
    const afterEdit = createRootOnce(nextCode);

    expect(afterEdit.originalCode).toBe(nextCode);
  });

  it('unblocks a terminal storm after a quiet interval', () => {
    createParent(rootCode);
    runInvalidations(STORM_LIMIT, rootCode);
    expect(() => createRootOnce(rootCode)).toThrow(/Supersede storm detected/);

    setSystemTime(new Date(BASE_TIME + 10_001));
    expect(createRootOnce(rootCode).originalCode).toBe(rootCode);
  });

  it('unblocks a terminal storm after an explicit cache reset', () => {
    createParent(rootCode);
    runInvalidations(STORM_LIMIT, rootCode);
    expect(() => createRootOnce(rootCode)).toThrow(/Supersede storm detected/);

    services.cache.clear('all');
    expect(createRootOnce(rootCode).originalCode).toBe(rootCode);
  });

  it('unblocks a terminal storm after the cache key salt changes', () => {
    createParent(rootCode);
    runInvalidations(STORM_LIMIT, rootCode);
    expect(() => createRootOnce(rootCode)).toThrow(/Supersede storm detected/);

    services.cache.setKeySalt('next-config');
    expect(createRootOnce(rootCode).originalCode).toBe(rootCode);
  });

  it('accepts a real edit to an fs-loaded entrypoint at the rate boundary', () => {
    const first = createParent(undefined);
    const beforeEdit = runInvalidations(STORM_LIMIT, undefined);
    const nextCode = 'export const token = "blue";';

    fs.writeFileSync(name, nextCode);
    const afterEdit = createRootOnce(undefined);

    expect(afterEdit).not.toBe(beforeEdit);
    expect(afterEdit.originalCode).toBe(nextCode);
    expect(afterEdit.generation).toBe(first.generation + STORM_LIMIT + 1);
  });

  it('resets the window when a real edit also widens the requested exports', () => {
    const first = createParent(rootCode);
    runInvalidations(STORM_LIMIT, rootCode);
    const nextCode = 'export const token = "blue";';
    const widenedOnly = [...only, 'token'];

    const widened = Entrypoint.createRoot(
      services,
      name,
      widenedOnly,
      nextCode
    );
    attachUnknownDependency(widened);
    const next = Entrypoint.createRoot(services, name, widenedOnly, nextCode);

    expect(widened.generation).toBe(first.generation + STORM_LIMIT + 1);
    expect(next).not.toBe(widened);
    expect(next.generation).toBe(widened.generation + 1);
  });

  it('resets the window when a real edit replaces an incomplete evaluated entrypoint', () => {
    createParent(rootCode);
    const latest = runInvalidations(STORM_LIMIT, rootCode);
    services.cache.add('entrypoints', name, latest.createEvaluated());

    const nextCode = 'export const token = "blue";';
    const edited = createRootOnce(nextCode);
    attachUnknownDependency(edited);
    const next = createRootOnce(nextCode);

    expect(edited.originalCode).toBe(nextCode);
    expect(next).not.toBe(edited);
  });

  it('fails safely instead of reusing an unchanged root after its dependency changed', () => {
    createParent(rootCode);
    runInvalidations(STORM_LIMIT, rootCode);

    // Make the dependency graph known so this final invalidation is caused by
    // the real dependency edit, not by the synthetic unknown state.
    const repairedDependency = Entrypoint.createRoot(
      services,
      depName,
      ['value'],
      depCode
    );
    services.cache.delete('entrypoints', repairedDependency.name);
    fs.writeFileSync(depName, 'export const value = 2;');
    const nextMtime = new Date(Date.now() + 1_000);
    fs.utimesSync(depName, nextMtime, nextMtime);

    expect(() => createRootOnce(rootCode)).toThrow(/potentially stale output/);
    expect(services.cache.get('entrypoints', name)).toBeUndefined();
  });

  it('uses a true sliding window for paced invalidations', () => {
    const first = createParent(rootCode);
    let last = first;

    // 101ms spacing means no 10-second window contains more than 100 events.
    for (let i = 0; i < 150; i += 1) {
      setSystemTime(new Date(BASE_TIME + i * 101));
      last = createRootOnce(rootCode);
    }

    expect(last.generation).toBe(first.generation + 150);
  });

  it('starts a fresh window after a quiet interval', () => {
    const first = createParent(rootCode);
    const beforeQuiet = runInvalidations(STORM_LIMIT, rootCode);

    setSystemTime(new Date(BASE_TIME + 10_001));
    const afterQuiet = createRootOnce(rootCode);

    expect(afterQuiet).not.toBe(beforeQuiet);
    expect(afterQuiet.generation).toBe(first.generation + STORM_LIMIT + 1);
  });

  it('starts a fresh window after a generation finishes processing', () => {
    const first = createParent(rootCode);
    const completed = runInvalidations(STORM_LIMIT, rootCode);

    attachUnknownDependency(completed);
    completed.setTransformResult({ code: rootCode, metadata: null });
    const next = createRootOnce(rootCode);

    expect(next).not.toBe(completed);
    expect(next.generation).toBe(first.generation + STORM_LIMIT + 1);
  });

  it('starts a fresh window after reusing a completed transform', () => {
    const seed = createRootOnce(rootCode);
    seed.setTransformResult({ code: rootCode, metadata: null });
    const evaluated = seed.createEvaluated();
    services.cache.delete('entrypoints', name);

    createParent(rootCode);
    runInvalidations(STORM_LIMIT, rootCode);

    // A warm evaluated entrypoint can supply a completed transform without
    // processEntrypoint calling setTransformResult on the new generation.
    services.cache.add('entrypoints', name, evaluated);
    const reused = createRootOnce(rootCode);
    reused.addDependency({
      only: ['value'],
      resolved: depName,
      source: './dep.js',
    });
    services.cache.add('entrypoints', name, reused);

    const next = createRootOnce(rootCode);
    expect(next).not.toBe(reused);
    expect(next.generation).toBe(reused.generation + 1);
  });

  it('keeps recovery pending when a parent from the retired lifecycle tries to create a child', () => {
    const oldParent = createRootOnce(rootCode);
    const victimName = path.join(root, 'victim.ts');
    const victimDependency = path.join(root, 'victim-dependency.ts');
    const victimCode = 'export const victim = 1;';
    fs.writeFileSync(victimName, victimCode);
    fs.writeFileSync(victimDependency, 'export const dependency = 1;');

    services.cache.beginUnknownGraphRecovery(
      victimName,
      new Set([victimDependency]),
      victimCode,
      {}
    );

    expect(() =>
      oldParent.createChild(victimName, ['victim'], victimCode)
    ).toThrow(/dependency graph is incomplete/);
    expect(services.cache.get('entrypoints', victimName)).toBeUndefined();

    const details = services.cache.invalidateIfChangedWithDetails(
      victimName,
      victimCode,
      'loaded'
    );
    expect([...details.unknownDependencyGraphs]).toEqual([victimDependency]);
  });

  it('does not let a retired traversal token bypass a retained recovery marker', () => {
    const otherName = path.join(root, 'other.ts');
    const otherDependency = path.join(root, 'other-dependency.ts');
    const otherCode = 'export const other = 1;';
    fs.writeFileSync(otherName, otherCode);
    fs.writeFileSync(otherDependency, 'export const dependency = 1;');

    const recoveryToken = {};
    services.cache.beginUnknownGraphRecovery(
      name,
      new Set([depName]),
      rootCode,
      recoveryToken
    );
    const recoveryEntrypoint = Entrypoint.createRoot(
      services,
      name,
      only,
      rootCode,
      { graphTraversalToken: recoveryToken }
    );

    // A recovery of an unrelated file resets nothing this traversal read, so
    // it keeps working on the same shared cache.
    services.cache.beginUnknownGraphRecovery(
      otherName,
      new Set([otherDependency]),
      otherCode,
      {}
    );
    expect(() => recoveryEntrypoint.assertNotSuperseded()).not.toThrow();

    // A second recovery of the same file, opened by another request, is what
    // retires it: the retained marker now belongs to the newer recovery.
    services.cache.beginUnknownGraphRecovery(
      name,
      new Set([depName]),
      rootCode,
      {}
    );

    expect(() => recoveryEntrypoint.assertNotSuperseded()).toThrow(
      /dependency graph is incomplete/
    );
    expect(() =>
      Entrypoint.createRoot(services, name, only, rootCode, {
        graphTraversalToken: recoveryEntrypoint.graphTraversalToken,
      })
    ).toThrow(/dependency graph is incomplete/);
    expect(() =>
      Entrypoint.createRoot(services, name, only, undefined, {
        graphTraversalToken: recoveryEntrypoint.graphTraversalToken,
      })
    ).toThrow(/dependency graph is incomplete/);
    expect(services.cache.get('entrypoints', name)).toBeUndefined();

    const details = services.cache.invalidateIfChangedWithDetails(
      name,
      rootCode,
      'loaded'
    );
    expect([...details.unknownDependencyGraphs]).toEqual([depName]);
  });

  it('never rate-limits genuinely changing loaded source', () => {
    let last = createParent('export const token = 0;');
    for (let i = 1; i < 150; i += 1) {
      const next = createRootOnce(`export const token = ${i};`);
      expect(next).not.toBe(last);
      last = next;
    }

    expect(last.generation).toBe(150);
  });
});
