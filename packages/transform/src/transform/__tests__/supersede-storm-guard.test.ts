import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerEvalBrokerRecoveryParticipant } from '../../eval/brokerRegistry';
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
// invalidateIfChanged implementation. Each generation observes a real edit to
// a dependency whose graph is complete, so the storm guard is exercised
// independently from unknown-graph epoch recovery.
describe('supersede storm guard', () => {
  const only = ['__wywPreval'];
  const rootCode = 'export const token = "red";';
  const depCode = 'export const value = 1;';

  let depName: string;
  let name: string;
  let root: string;
  let services: Services;
  let dependencyRevision: number;

  const createRootOnce = (loadedCode: string | undefined) =>
    Entrypoint.createRoot(services, name, only, loadedCode);

  const publishDependency = (code: string) => {
    const depEntrypoint = Entrypoint.createRoot(
      services,
      depName,
      ['value'],
      code
    );
    depEntrypoint.setTransformResult({ code, metadata: null });
  };

  const editDependency = () => {
    dependencyRevision += 1;
    const code = `export const value = ${dependencyRevision};`;
    fs.writeFileSync(depName, code);
    const mtime = new Date(BASE_TIME + dependencyRevision * 1_000);
    fs.utimesSync(depName, mtime, mtime);
    return code;
  };

  const invalidateParent = (loadedCode: string | undefined) => {
    const dependencyCode = editDependency();
    const entrypoint = createRootOnce(loadedCode);
    publishDependency(dependencyCode);
    return entrypoint;
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
      last = invalidateParent(loadedCode);
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

    dependencyRevision = 1;
    services.cache.checkFreshness(depName, depName);
    publishDependency(depCode);
  });

  afterEach(() => {
    setSystemTime();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fails safely after a real unknown-graph invalidation storm', () => {
    const first = createParent(rootCode);
    const last = runInvalidations(STORM_LIMIT, rootCode);
    const firstBrokerReset = jest.fn();
    const secondBrokerReset = jest.fn();
    const participants = [firstBrokerReset, secondBrokerReset].map((reset) => ({
      isDisposed: false,
      resetAfterCacheInvalidation: reset,
    }));
    participants.forEach((participant) => {
      registerEvalBrokerRecoveryParticipant(services.cache, participant);
    });
    let stormError: unknown;

    expect(last.generation).toBe(first.generation + STORM_LIMIT);
    try {
      invalidateParent(rootCode);
    } catch (error) {
      stormError = error;
    }
    expect(stormError).toBeInstanceOf(Error);
    expect((stormError as Error).message).toContain('Supersede storm detected');
    expect(firstBrokerReset).toHaveBeenCalledTimes(1);
    expect(secondBrokerReset).toHaveBeenCalledTimes(1);

    // invalidateIfChanged evicted the parent before the diagnostic. No stale
    // entrypoint is returned or silently put back into the cache. A workflow
    // that already retained it observes the same terminal error at its next
    // publication boundary.
    expect(services.cache.get('entrypoints', name)).toBeUndefined();
    let retainedError: unknown;
    try {
      last.assertCurrentCacheEpoch();
    } catch (error) {
      retainedError = error;
    }
    expect(retainedError).toMatchObject({
      cause: stormError,
      code: 'WYW_CACHE_EPOCH_ABORTED',
    });

    let ancestorError: unknown;
    try {
      first.assertCurrentCacheEpoch();
    } catch (error) {
      ancestorError = error;
    }
    expect(ancestorError).toBe(retainedError);

    // Cache eviction must not reopen the same warm-eval retry loop. The
    // unchanged source remains blocked with the original diagnostic object.
    services.cacheEpoch = services.cache.getCurrentEpoch();
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
    expect(() => invalidateParent(rootCode)).toThrow(
      /Supersede storm detected/
    );
    services.cacheEpoch = services.cache.getCurrentEpoch();

    const nextCode = 'export const token = "blue";';
    const afterEdit = createRootOnce(nextCode);

    expect(afterEdit.originalCode).toBe(nextCode);
  });

  it('unblocks a terminal storm after a quiet interval', () => {
    createParent(rootCode);
    runInvalidations(STORM_LIMIT, rootCode);
    expect(() => invalidateParent(rootCode)).toThrow(
      /Supersede storm detected/
    );
    services.cacheEpoch = services.cache.getCurrentEpoch();

    setSystemTime(new Date(BASE_TIME + 10_001));
    expect(createRootOnce(rootCode).originalCode).toBe(rootCode);
  });

  it('unblocks a terminal storm after an explicit cache reset', () => {
    createParent(rootCode);
    runInvalidations(STORM_LIMIT, rootCode);
    expect(() => invalidateParent(rootCode)).toThrow(
      /Supersede storm detected/
    );
    services.cacheEpoch = services.cache.getCurrentEpoch();

    services.cache.clear('all');
    expect(createRootOnce(rootCode).originalCode).toBe(rootCode);
  });

  it('unblocks a terminal storm after the cache key salt changes', () => {
    createParent(rootCode);
    runInvalidations(STORM_LIMIT, rootCode);
    expect(() => invalidateParent(rootCode)).toThrow(
      /Supersede storm detected/
    );
    services.cacheEpoch = services.cache.getCurrentEpoch();

    services.cache.setKeySalt('next-config');
    services.cacheEpoch = services.cache.getCurrentEpoch();
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
    const dependencyCode = editDependency();
    const next = Entrypoint.createRoot(services, name, widenedOnly, nextCode);
    publishDependency(dependencyCode);

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
    const next = invalidateParent(nextCode);

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

    let recoveryError: unknown;
    try {
      createRootOnce(rootCode);
    } catch (error) {
      recoveryError = error;
    }
    expect(recoveryError).toMatchObject({
      cause: expect.objectContaining({
        code: 'WYW_UNKNOWN_DEPENDENCY_GRAPH_RESET',
      }),
      code: 'WYW_CACHE_EPOCH_ABORTED',
    });
    expect(services.cache.get('entrypoints', name)).toBeUndefined();
  });

  it('uses a true sliding window for paced invalidations', () => {
    const first = createParent(rootCode);
    let last = first;

    // 101ms spacing means no 10-second window contains more than 100 events.
    for (let i = 0; i < 150; i += 1) {
      setSystemTime(new Date(BASE_TIME + i * 101));
      last = invalidateParent(rootCode);
    }

    expect(last.generation).toBe(first.generation + 150);
  });

  it('starts a fresh window after a quiet interval', () => {
    const first = createParent(rootCode);
    const beforeQuiet = runInvalidations(STORM_LIMIT, rootCode);

    setSystemTime(new Date(BASE_TIME + 10_001));
    const afterQuiet = invalidateParent(rootCode);

    expect(afterQuiet).not.toBe(beforeQuiet);
    expect(afterQuiet.generation).toBe(first.generation + STORM_LIMIT + 1);
  });

  it('starts a fresh window after a generation finishes processing', () => {
    const first = createParent(rootCode);
    const completed = runInvalidations(STORM_LIMIT, rootCode);

    attachUnknownDependency(completed);
    completed.setTransformResult({ code: rootCode, metadata: null });
    const next = invalidateParent(rootCode);

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

    const next = invalidateParent(rootCode);
    expect(next).not.toBe(reused);
    expect(next.generation).toBe(reused.generation + 1);
  });

  it('prevents a parent from the retired epoch from publishing a child', () => {
    const oldParent = createRootOnce(rootCode);
    const victimName = path.join(root, 'victim.ts');
    const victimDependency = path.join(root, 'victim-dependency.ts');
    const victimCode = 'export const victim = 1;';
    fs.writeFileSync(victimName, victimCode);
    fs.writeFileSync(victimDependency, 'export const dependency = 1;');

    const recovery = services.cache.startUnknownGraphRecovery(
      victimName,
      new Set([victimDependency]),
      victimCode,
      services.cache.createGraphTraversalToken(services.cache.getCurrentEpoch())
    );
    recovery.complete();

    expect(() =>
      oldParent.createChild(victimName, ['victim'], victimCode)
    ).toThrow(
      expect.objectContaining({
        code: 'WYW_CACHE_EPOCH_ABORTED',
      })
    );
    expect(services.cache.get('entrypoints', victimName)).toBeUndefined();

    const details = services.cache.invalidateIfChangedWithDetails(
      victimName,
      victimCode,
      'loaded'
    );
    expect([...details.unknownDependencyGraphs]).toEqual([]);
  });

  it('retires a rebuilt entrypoint when another global recovery starts', () => {
    const otherName = path.join(root, 'other.ts');
    const otherDependency = path.join(root, 'other-dependency.ts');
    const otherCode = 'export const other = 1;';
    fs.writeFileSync(otherName, otherCode);
    fs.writeFileSync(otherDependency, 'export const dependency = 1;');

    const firstRecovery = services.cache.startUnknownGraphRecovery(
      name,
      new Set([depName]),
      rootCode,
      services.cache.createGraphTraversalToken(services.cache.getCurrentEpoch())
    );
    firstRecovery.complete();
    services.cacheEpoch = services.cache.getCurrentEpoch();
    const recoveryEntrypoint = createRootOnce(rootCode);

    const secondRecovery = services.cache.startUnknownGraphRecovery(
      otherName,
      new Set([otherDependency]),
      otherCode,
      services.cache.createGraphTraversalToken(services.cache.getCurrentEpoch())
    );
    secondRecovery.complete();

    expect(() => recoveryEntrypoint.assertNotSuperseded()).toThrow(
      expect.objectContaining({
        code: 'WYW_CACHE_EPOCH_ABORTED',
      })
    );
    expect(services.cache.get('entrypoints', name)).toBeUndefined();
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
