import fs from 'node:fs';

import { CacheKeySaltBusyError, TransformCacheCollection } from '../cache';
import { registerEvalBrokerRecoveryParticipant } from '../eval/brokerRegistry';
import { Entrypoint } from '../transform/Entrypoint';
import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import { withDefaultServices } from '../transform/helpers/withDefaultServices';

type MockEntrypoint = {
  dependencies: Map<string, { resolved: string | null }>;
  generation: number;
  initialCode?: string;
  isProcessing?: boolean;
  invalidateOnDependencyChange?: Set<string>;
  invalidationDependencies?: Map<string, { resolved: string | null }>;
  name: string;
};

const entrypoint = (
  name: string,
  extra: Partial<MockEntrypoint> = {}
): MockEntrypoint => ({
  name,
  dependencies: new Map(),
  invalidationDependencies: new Map(),
  generation: 1,
  ...extra,
});

const recover = (
  cache: TransformCacheCollection<MockEntrypoint>,
  filename: string,
  unknown: string[] = ['missing.linaria.ts']
) =>
  cache.startUnknownGraphRecovery(
    filename,
    new Set(unknown),
    'export const a = 1;',
    cache.createGraphTraversalToken(cache.getCurrentEpoch())
  );

// The eval broker owns one VM generation for the whole transform cache. Cache
// recovery therefore has the same scope: every attempt from the old epoch is
// retired and top-level transform() is responsible for retrying it.
describe('TransformCacheCollection: transactional recovery', () => {
  it('retires every traversal with one typed error that retains the cause', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const oldEpoch = cache.getCurrentEpoch();
    const first = cache.createGraphTraversalToken(oldEpoch);
    const unrelated = cache.createGraphTraversalToken(oldEpoch);
    const transition = recover(cache, 'recovering.tsx');

    expect(transition.abortError).toMatchObject({
      code: 'WYW_CACHE_EPOCH_ABORTED',
      fromEpoch: 0,
      reason: 'unknown-dependency-graph',
      toEpoch: 1,
    });
    expect(transition.abortError.cause).toMatchObject({
      code: 'WYW_UNKNOWN_DEPENDENCY_GRAPH_RESET',
      name: 'UnknownDependencyGraphResetError',
    });
    expect(cache.getEpochError(oldEpoch)).toBe(transition.abortError);
    expect(cache.getLifecycleError(0)).toBeNull();
    expect(cache.getGraphTraversalTokenError(first)).toBe(
      transition.abortError
    );
    expect(cache.getGraphTraversalTokenError(unrelated)).toBe(
      transition.abortError
    );
    transition.complete();
  });

  it('coalesces recovery requests from the same old epoch', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const epoch = cache.getCurrentEpoch();
    const firstToken = cache.createGraphTraversalToken(epoch);
    const secondToken = cache.createGraphTraversalToken(epoch);
    const first = cache.startUnknownGraphRecovery(
      'a.tsx',
      new Set(['a-dependency.ts']),
      'export const a = 1;',
      firstToken
    );
    const second = cache.startUnknownGraphRecovery(
      'b.tsx',
      new Set(['b-dependency.ts']),
      'export const b = 1;',
      secondToken
    );

    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.abortError).toBe(first.abortError);
    expect(cache.getLifecycleVersion()).toBe(1);
    first.complete();
  });

  it('keeps the released unknown-graph recovery API synchronous', async () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const recoveryToken = {};
    const lifecycleVersion = cache.getLifecycleVersion();
    const sourceCode = 'export const value = 1;';

    const recoveryError = cache.beginUnknownGraphRecovery(
      'recovering.tsx',
      new Set(['missing.ts']),
      sourceCode,
      recoveryToken
    );
    const unrelatedToken = cache.createGraphTraversalToken();

    expect(recoveryError).toMatchObject({
      code: 'WYW_UNKNOWN_DEPENDENCY_GRAPH_RESET',
      name: 'UnknownDependencyGraphResetError',
    });
    expect(cache.getLifecycleError(lifecycleVersion)).toBeNull();
    expect(cache.getGraphTraversalTokenError(recoveryToken)).toBeNull();
    expect(
      cache.invalidateIfChangedWithDetails(
        'recovering.tsx',
        sourceCode,
        'loaded',
        recoveryToken
      ).unknownDependencyGraphs
    ).toEqual(new Set());
    expect(
      cache.invalidateIfChangedWithDetails(
        'recovering.tsx',
        sourceCode,
        'loaded',
        unrelatedToken
      ).unknownDependencyGraphs
    ).toEqual(new Set(['missing.ts']));

    // Legacy pending bookkeeping must not hold the transactional epoch barrier.
    await expect(cache.acquireReadyEpoch()).resolves.toBe(
      cache.getCurrentEpoch()
    );

    cache.completeUnknownGraphRecovery('recovering.tsx');
    expect(
      cache.invalidateIfChangedWithDetails(
        'recovering.tsx',
        sourceCode,
        'loaded',
        unrelatedToken
      ).unknownDependencyGraphs
    ).toEqual(new Set());
  });

  it('keeps pending recovery until the published entrypoint completes', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const filename = 'recovering.tsx';
    const sourceCode = 'export const value = 1;';
    const recoveryToken = {};
    const recoveryError = cache.beginUnknownGraphRecovery(
      filename,
      new Set(['missing.ts']),
      sourceCode,
      recoveryToken
    );
    const published = entrypoint(filename, {
      initialCode: sourceCode,
      isProcessing: true,
    });
    const detached = entrypoint(filename, { initialCode: sourceCode });
    cache.add('entrypoints', filename, published);

    cache.completeUnknownGraphRecovery(filename, detached);
    expect(
      cache.getRecoveryError(
        filename,
        cache.getLifecycleVersion(),
        cache.createGraphTraversalToken()
      )
    ).toBe(recoveryError);

    published.isProcessing = false;
    cache.completeUnknownGraphRecovery(filename, published);
    expect(
      cache.getRecoveryError(
        filename,
        cache.getLifecycleVersion(),
        cache.createGraphTraversalToken()
      )
    ).toBeNull();

    cache.beginUnknownGraphRecovery(
      filename,
      new Set(['another-missing.ts']),
      sourceCode,
      {}
    );
    cache.add('entrypoints', filename, entrypoint(filename));
    expect(
      cache.getRecoveryError(
        filename,
        cache.getLifecycleVersion(),
        cache.createGraphTraversalToken()
      )
    ).toBeNull();
  });

  it('preserves pending evidence across recovery and clears it explicitly', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const firstError = cache.beginUnknownGraphRecovery(
      'first.tsx',
      new Set(['first-missing.ts']),
      'export const first = 1;',
      {}
    );
    cache.beginUnknownGraphRecovery(
      'second.tsx',
      new Set(['second-missing.ts']),
      'export const second = 1;',
      {}
    );

    expect(
      cache.getRecoveryError(
        'first.tsx',
        cache.getLifecycleVersion(),
        cache.createGraphTraversalToken()
      )
    ).toBe(firstError);

    cache.clear('entrypoints');
    expect(
      cache.getRecoveryError(
        'first.tsx',
        cache.getLifecycleVersion(),
        cache.createGraphTraversalToken()
      )
    ).toBeNull();
    // An explicit entrypoint-cache clear ends pending recovery but retains
    // historical file recovery queries, as in the published cache contract.
    expect(cache.getRecoveryError('first.tsx', 0)).toBe(firstError);

    cache.setKeySalt('first');
    expect(cache.getRecoveryError('first.tsx', 0)).toBe(firstError);
    cache.setKeySalt('second');
    expect(cache.getRecoveryError('first.tsx', 0)).toBeNull();
  });

  it('restores the file-scoped recovery query API as compatibility metadata', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const versionBefore = cache.getLifecycleVersion();
    const recoveryError = cache.beginUnknownGraphRecovery(
      'recovering.tsx',
      new Set(['missing.ts']),
      'export const value = 1;',
      {}
    );

    expect(cache.getRecoveryError('recovering.tsx', versionBefore)).toBe(
      recoveryError
    );
    expect(cache.getRecoveryError('unrelated.tsx', versionBefore)).toBeNull();
    expect(
      cache.getScopedRecoveryError(versionBefore, new Set(['recovering.tsx']))
    ).toBe(recoveryError);
    expect(
      cache.getScopedRecoveryError(versionBefore, new Set(['unrelated.tsx']))
    ).toBeUndefined();
  });

  it('keeps released traversal tokens scoped to files they visited', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const sourceCode = 'export const value = 1;';
    const visitedToken = cache.createGraphTraversalToken();
    const unrelatedToken = cache.createGraphTraversalToken();

    cache.invalidateIfChangedWithDetails(
      'recovering.tsx',
      sourceCode,
      'loaded',
      visitedToken
    );
    const recoveryError = cache.beginUnknownGraphRecovery(
      'recovering.tsx',
      new Set(['missing.ts']),
      sourceCode,
      {}
    );

    expect(cache.getGraphTraversalTokenError(visitedToken)).toBe(recoveryError);
    expect(cache.getGraphTraversalTokenError(unrelatedToken)).toBeNull();
  });

  it('reports a pending file recovery before an older legacy token error', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const sourceCode = 'export const value = 1;';
    const staleToken = cache.createGraphTraversalToken();

    cache.invalidateIfChangedWithDetails(
      'first.tsx',
      sourceCode,
      'loaded',
      staleToken
    );
    const firstError = cache.beginUnknownGraphRecovery(
      'first.tsx',
      new Set(['first-missing.ts']),
      sourceCode,
      {}
    );
    const pendingError = cache.beginUnknownGraphRecovery(
      'pending.tsx',
      new Set(['pending-missing.ts']),
      sourceCode,
      {}
    );

    expect(cache.getGraphTraversalTokenError(staleToken)).toBe(firstError);
    expect(() =>
      cache.invalidateIfChangedWithDetails(
        'pending.tsx',
        sourceCode,
        'loaded',
        staleToken
      )
    ).toThrow(pendingError);
  });

  it('keeps the released supersede recovery API synchronous', async () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const oldEpoch = cache.getCurrentEpoch();
    const lifecycleVersion = cache.getLifecycleVersion();
    const recoveryError = new Error('supersede storm');

    expect(cache.beginSupersedeStormRecovery(recoveryError)).toBeUndefined();
    expect(cache.getEpochError(oldEpoch)).toMatchObject({
      code: 'WYW_CACHE_EPOCH_ABORTED',
      cause: recoveryError,
      reason: 'supersede-storm',
    });
    expect(cache.getLifecycleError(lifecycleVersion)).toBe(recoveryError);
    expect(cache.getScopedRecoveryError(lifecycleVersion, new Set())).toBe(
      recoveryError
    );
    expect(
      cache.getScopedRecoveryError(cache.getLifecycleVersion(), new Set())
    ).toBe(recoveryError);
    await expect(cache.acquireReadyEpoch()).resolves.toBe(
      cache.getCurrentEpoch()
    );
  });

  it('keeps key-salt rotations out of the released lifecycle counters', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const recoveryError = new Error('global recovery');
    cache.beginSupersedeStormRecovery(recoveryError);
    const lifecycleVersion = cache.getLifecycleVersion();

    cache.setKeySalt('first');
    cache.setKeySalt('second');

    expect(cache.getLifecycleVersion()).toBe(lifecycleVersion);
    expect(cache.getLifecycleError(lifecycleVersion)).toBeNull();
    expect(cache.getLifecycleError(lifecycleVersion - 1)).toBe(recoveryError);
  });

  it('keeps Entrypoint cacheLifecycleVersion on the released counter', () => {
    const cache = new TransformCacheCollection();
    cache.setKeySalt('first');
    cache.setKeySalt('second');
    const services = withDefaultServices({
      cache,
      options: {
        filename: '/abs/entry.ts',
        root: '/abs',
        pluginOptions: loadWywOptions({ configFile: false }),
      },
    });
    const createdEntrypoint = Entrypoint.createRoot(
      services,
      '/abs/entry.ts',
      ['__wywPreval'],
      'export const value = 1;'
    );

    expect(createdEntrypoint.cacheEpoch.version).toBeGreaterThan(
      createdEntrypoint.cacheLifecycleVersion
    );

    const recoveryError = new Error('global recovery');
    cache.beginSupersedeStormRecovery(recoveryError);
    expect(
      cache.getLifecycleError(createdEntrypoint.cacheLifecycleVersion)
    ).toBe(recoveryError);
  });

  it('does not pin reusable default services to one cache epoch', () => {
    const cache = new TransformCacheCollection();
    const services = withDefaultServices({
      cache,
      options: {
        filename: '/abs/entry.ts',
        root: '/abs',
        pluginOptions: loadWywOptions({ configFile: false }),
      },
    });

    expect(services.cacheEpoch).toBeUndefined();
    cache.beginSupersedeStormRecovery(new Error('supersede storm'));

    const createdEntrypoint = Entrypoint.createRoot(
      services,
      '/abs/entry.ts',
      ['__wywPreval'],
      'export const value = 1;'
    );
    expect(createdEntrypoint.cacheEpoch).toBe(cache.getCurrentEpoch());
  });

  it('accepts a released traversal token in public Entrypoint.createRoot', () => {
    const cache = new TransformCacheCollection();
    const services = withDefaultServices({
      cache,
      options: {
        filename: '/abs/entry.ts',
        root: '/abs',
        pluginOptions: loadWywOptions({ configFile: false }),
      },
    });
    const sourceCode = 'export const value = 1;';
    cache.beginUnknownGraphRecovery(
      '/abs/entry.ts',
      new Set(['/abs/missing.ts']),
      sourceCode,
      {}
    );
    const traversalToken = cache.createGraphTraversalToken();

    let recoveryError: unknown;
    try {
      Entrypoint.createRoot(
        services,
        '/abs/entry.ts',
        ['__wywPreval'],
        sourceCode,
        { graphTraversalToken: traversalToken }
      );
    } catch (error) {
      recoveryError = error;
    }

    expect(recoveryError).toMatchObject({
      code: 'WYW_CACHE_EPOCH_ABORTED',
      reason: 'unknown-dependency-graph',
    });
    expect(() =>
      Entrypoint.createRoot(
        services,
        '/abs/entry.ts',
        ['__wywPreval'],
        sourceCode,
        { graphTraversalToken: traversalToken }
      )
    ).not.toThrow();
  });

  it('does not expose a replacement epoch before recovery completes', async () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const transition = recover(cache, 'recovering.tsx');
    let acquired = false;
    const nextEpoch = cache.acquireReadyEpoch().then((epoch) => {
      acquired = true;
      return epoch;
    });

    await Promise.resolve();
    expect(acquired).toBe(false);

    transition.complete();
    await expect(nextEpoch).resolves.toBe(cache.getCurrentEpoch());
  });

  it('keeps a replacement epoch unavailable when broker reset fails', async () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const resetFailure = new Error('broker reset failed');
    const participant = {
      isDisposed: false,
      resetAfterCacheInvalidation: jest.fn(() => {
        throw resetFailure;
      }),
    };
    registerEvalBrokerRecoveryParticipant(cache, participant);
    const transition = recover(cache, 'recovering.tsx');
    const waiting = cache.acquireReadyEpoch();
    const replacementEpoch = cache.getCurrentEpoch();

    expect(() =>
      cache.publish(
        replacementEpoch,
        'entrypoints',
        'too-early.ts',
        entrypoint('too-early.ts')
      )
    ).toThrow(/still in progress/);

    expect(() => transition.complete()).toThrow(resetFailure);
    expect(participant.resetAfterCacheInvalidation).toHaveBeenCalledTimes(1);

    await expect(waiting).rejects.toBe(resetFailure);
    await expect(cache.acquireReadyEpoch()).rejects.toBe(resetFailure);
    expect(() =>
      cache.publish(
        replacementEpoch,
        'entrypoints',
        'after-failure.ts',
        entrypoint('after-failure.ts')
      )
    ).toThrow(resetFailure);
    expect(() =>
      cache.beginUnknownGraphRecovery(
        'second-recovery.ts',
        new Set(['still-missing.ts']),
        'export const value = 2;',
        {}
      )
    ).toThrow(resetFailure);
    expect(participant.resetAfterCacheInvalidation).toHaveBeenCalledTimes(1);
    expect(cache.getCurrentEpoch()).toBe(replacementEpoch);
    expect(cache.get('entrypoints', 'too-early.ts')).toBeUndefined();
    expect(cache.get('entrypoints', 'after-failure.ts')).toBeUndefined();
  });

  it('clears completed and in-flight state before opening the new epoch', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    cache.add('entrypoints', 'complete.ts', entrypoint('complete.ts'));
    cache.add(
      'entrypoints',
      'in-flight.ts',
      entrypoint('in-flight.ts', {
        isProcessing: true,
        transformed: false,
      })
    );
    cache.add('exports', 'complete.ts', ['value']);

    const transition = recover(cache, 'recovering.tsx');

    expect(cache.get('entrypoints', 'complete.ts')).toBeUndefined();
    expect(cache.get('entrypoints', 'in-flight.ts')).toBeUndefined();
    expect(cache.get('exports', 'complete.ts')).toBeUndefined();
    transition.complete();
  });

  it('rejects publication from the old epoch', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const oldEpoch = cache.getCurrentEpoch();
    const transition = recover(cache, 'recovering.tsx');

    expect(() =>
      cache.publish(oldEpoch, 'entrypoints', 'stale.ts', entrypoint('stale.ts'))
    ).toThrow(transition.abortError);

    transition.complete();
    cache.publish(
      cache.getCurrentEpoch(),
      'entrypoints',
      'fresh.ts',
      entrypoint('fresh.ts')
    );
    expect(cache.get('entrypoints', 'fresh.ts')).toBeDefined();
  });

  it('rejects an epoch owned by another cache collection', () => {
    const owner = new TransformCacheCollection<MockEntrypoint>();
    const foreign = new TransformCacheCollection<MockEntrypoint>();
    const ownerEpoch = owner.getCurrentEpoch();

    expect(() =>
      foreign.publish(
        ownerEpoch,
        'entrypoints',
        'foreign.ts',
        entrypoint('foreign.ts')
      )
    ).toThrow(/wrong owner/);
    expect(() => foreign.createGraphTraversalToken(ownerEpoch)).toThrow(
      /wrong owner/
    );
    expect(() =>
      foreign.invalidateIfChangedWithDetails(
        'foreign.ts',
        'export const value = 1;',
        'loaded',
        undefined,
        ownerEpoch
      )
    ).toThrow(/wrong owner/);
    expect(foreign.get('entrypoints', 'foreign.ts')).toBeUndefined();
  });

  it('lets the replacement epoch rebuild the graph that triggered recovery', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const transition = recover(cache, 'recovering.tsx');
    transition.complete();

    expect(
      cache.invalidateIfChangedWithDetails(
        'recovering.tsx',
        'export const a = 1;',
        'loaded',
        undefined,
        cache.getCurrentEpoch()
      )
    ).toEqual({ changed: false, unknownDependencyGraphs: new Set() });
  });
});

describe('TransformCacheCollection: key salt lease', () => {
  it('adopts pre-populated entries when the first semantic key is installed', async () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const existing = entrypoint('existing.ts');
    const initialEpoch = cache.getCurrentEpoch();
    const reset = jest.fn();
    registerEvalBrokerRecoveryParticipant(cache, {
      isDisposed: false,
      resetAfterCacheInvalidation: reset,
    });
    cache.add('entrypoints', 'existing.ts', existing);

    const release = await cache.acquireKeySalt('initial');

    expect(cache.getCurrentEpoch()).toBe(initialEpoch);
    expect(cache.get('entrypoints', 'existing.ts')).toBe(existing);
    expect(reset).not.toHaveBeenCalled();
    release();
  });

  it('shares one key concurrently without letting it barge past a queued key', async () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const releaseA1 = await cache.acquireKeySalt('a');
    const releaseA2 = await cache.acquireKeySalt('a');
    const order: string[] = [];
    const waitingB = cache.acquireKeySalt('b').then((release) => {
      order.push('b');
      return release;
    });
    const waitingA = cache.acquireKeySalt('a').then((release) => {
      order.push('a');
      return release;
    });

    await Promise.resolve();
    expect(order).toEqual([]);

    releaseA1();
    releaseA2();
    const releaseB = await waitingB;
    expect(order).toEqual(['b']);

    releaseB();
    const releaseA3 = await waitingA;
    expect(order).toEqual(['b', 'a']);
    releaseA3();
  });

  it('makes release idempotent and rejects a direct conflicting salt change', async () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const releaseA = await cache.acquireKeySalt('a');
    const resetVersion = cache.getResetVersion();

    cache.setKeySalt('a');
    expect(() => cache.setKeySalt('b')).toThrow(CacheKeySaltBusyError);
    expect(cache.getKeySalt()).toBe('a');
    expect(cache.getResetVersion()).toBe(resetVersion);

    const waitingB = cache.acquireKeySalt('b');
    releaseA();
    releaseA();
    const releaseB = await waitingB;
    expect(cache.getKeySalt()).toBe('b');
    releaseB();
  });

  it('retires the old epoch and broadcasts a real salt switch', async () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const releaseInitial = await cache.acquireKeySalt('initial');
    releaseInitial();
    const oldEpoch = cache.getCurrentEpoch();
    const firstReset = jest.fn();
    const secondReset = jest.fn();
    const participants = [firstReset, secondReset].map((reset) => ({
      isDisposed: false,
      resetAfterCacheInvalidation: reset,
    }));
    participants.forEach((participant) => {
      registerEvalBrokerRecoveryParticipant(cache, participant);
    });

    const release = await cache.acquireKeySalt('next');

    expect(firstReset).toHaveBeenCalledTimes(1);
    expect(secondReset).toHaveBeenCalledTimes(1);
    expect(firstReset.mock.calls[0][2]).toBe('cache-key-salt-change');
    expect(() =>
      cache.publish(oldEpoch, 'entrypoints', 'stale.ts', entrypoint('stale.ts'))
    ).toThrow(
      expect.objectContaining({
        code: 'WYW_CACHE_EPOCH_ABORTED',
        reason: 'cache-key-salt-change',
      })
    );
    release();
  });

  it('keeps the replacement epoch failed when one broker reset fails', async () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const releaseInitial = await cache.acquireKeySalt('initial');
    releaseInitial();
    const resetFailure = new Error('salt reset failed');
    const successfulReset = jest.fn();
    const failedReset = jest.fn(() => {
      throw resetFailure;
    });
    const participants = [failedReset, successfulReset].map((reset) => ({
      isDisposed: false,
      resetAfterCacheInvalidation: reset,
    }));
    participants.forEach((participant) => {
      registerEvalBrokerRecoveryParticipant(cache, participant);
    });

    await expect(cache.acquireKeySalt('next')).rejects.toBe(resetFailure);
    expect(failedReset).toHaveBeenCalledTimes(1);
    expect(successfulReset).toHaveBeenCalledTimes(1);
    await expect(cache.acquireReadyEpoch()).rejects.toBe(resetFailure);
    await expect(cache.acquireKeySalt('later')).rejects.toBe(resetFailure);
  });

  it('does not switch a queued key before an active recovery completes', async () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const releaseA = await cache.acquireKeySalt('a');
    const recovery = recover(cache, 'recovering.tsx');
    let acquiredB = false;
    const waitingB = cache.acquireKeySalt('b').then((release) => {
      acquiredB = true;
      return release;
    });

    releaseA();
    await Promise.resolve();
    expect(acquiredB).toBe(false);
    expect(cache.getKeySalt()).toBe('a');

    recovery.complete();
    const releaseB = await waitingB;
    expect(acquiredB).toBe(true);
    expect(cache.getKeySalt()).toBe('b');
    releaseB();
  });

  it('rejects a queued key with the recovery barrier failure', async () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const releaseA = await cache.acquireKeySalt('a');
    const recovery = recover(cache, 'recovering.tsx');
    const recoveryFailure = new Error('recovery barrier failed');
    const waitingB = cache.acquireKeySalt('b');

    releaseA();
    recovery.fail(recoveryFailure);

    await expect(waitingB).rejects.toBe(recoveryFailure);
    expect(cache.getKeySalt()).toBe('a');
  });
});

// A loader can return new content for an unchanged filesystem mtime. Epoch
// recovery must not weaken that.
describe('TransformCacheCollection: loader content at unchanged mtime', () => {
  const leaf = 'leaf.js';
  const parent = 'parent.js';
  const parentCode = 'import { c } from "./leaf.js";';

  const mockedStatSync = jest.spyOn(fs, 'statSync');
  const mockedReadFileSync = jest.spyOn(fs, 'readFileSync');

  afterAll(() => {
    mockedStatSync.mockRestore();
    mockedReadFileSync.mockRestore();
  });

  it('treats new loaded content at an unchanged mtime as a change', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    mockedStatSync.mockReturnValue({ mtimeMs: 500 } as fs.Stats);

    cache.invalidateIfChanged(leaf, 'export const c = "red";', undefined, 'fs');
    cache.add('entrypoints', leaf, entrypoint(leaf));

    expect(cache.invalidateIfChanged(leaf, 'export const c = "blue";')).toBe(
      true
    );
    expect(cache.get('entrypoints', leaf)).toBeUndefined();
  });

  it('starts the replacement epoch without stale graph state', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    mockedStatSync.mockReturnValue({ mtimeMs: 500 } as fs.Stats);
    mockedReadFileSync.mockReturnValue('export const c = "red";');

    cache.checkFreshness(leaf, leaf);
    cache.add('entrypoints', leaf, entrypoint(leaf));
    cache.add(
      'entrypoints',
      parent,
      entrypoint(parent, {
        initialCode: parentCode,
        dependencies: new Map([['./leaf.js', { resolved: leaf }]]),
      })
    );

    const transition = cache.startUnknownGraphRecovery(
      'unrelated.tsx',
      new Set(['missing.linaria.ts']),
      'export const a = 1;',
      cache.createGraphTraversalToken(cache.getCurrentEpoch())
    );
    transition.complete();

    // Both modules and their snapshots belong to the discarded epoch. The
    // replacement starts cold and seeds the root again.
    expect(cache.get('entrypoints', parent)).toBeUndefined();
    expect(cache.get('entrypoints', leaf)).toBeUndefined();
    expect(
      cache.invalidateIfChangedWithDetails(parent, parentCode, 'loaded')
    ).toEqual({ changed: false, unknownDependencyGraphs: new Set() });
  });

  it('detects a changed dependency behind an unchanged mtime', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    let leafOnDisk = 'export const c = "red";';
    mockedStatSync.mockImplementation(
      () => ({ mtimeMs: 500 }) as unknown as fs.Stats
    );
    mockedReadFileSync.mockImplementation((() => leafOnDisk) as never);

    cache.checkFreshness(leaf, leaf);
    cache.add('entrypoints', leaf, entrypoint(leaf));
    cache.add(
      'entrypoints',
      parent,
      entrypoint(parent, {
        initialCode: parentCode,
        invalidationDependencies: new Map([['./leaf.js', { resolved: leaf }]]),
        invalidateOnDependencyChange: new Set([leaf]),
      })
    );

    leafOnDisk = 'export const c = "blue";';

    expect(
      cache.invalidateIfChangedWithDetails(parent, parentCode, 'loaded').changed
    ).toBe(true);
    expect(mockedReadFileSync).toHaveBeenCalledWith(leaf, 'utf8');
  });
});
