import * as babel from '@babel/core';
import { EventEmitter as NodeEventEmitter } from 'events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';

import { LruCache, serializeValue } from '@wyw-in-js/shared';

import { disposeEvalBroker, EvalBroker, getEvalBroker } from '../eval/broker';
import {
  beginEvalTelemetry,
  registerEvalTelemetryReporter,
  type EvalBrokerMirrorSnapshot,
  type EvalTelemetryRecord,
  type EvalTelemetryToken,
} from '../debug/evalTelemetry';
import { Entrypoint } from '../transform/Entrypoint';
import {
  loadWywOptions,
  type PartialOptions,
} from '../transform/helpers/loadWywOptions';
import { withDefaultServices } from '../transform/helpers/withDefaultServices';
import { shaker } from '../shaker';
import { EventEmitter } from '../utils/EventEmitter';

const createEmitter = () => {
  let actionId = 0;
  return new EventEmitter(
    () => {},
    ((phase: string) => {
      if (phase !== 'start') return undefined;
      const id = actionId;
      actionId += 1;
      return id;
    }) as never,
    () => {}
  );
};

const createServices = (
  root: string,
  filename: string,
  emitter: EventEmitter,
  overrides: PartialOptions = {}
) =>
  withDefaultServices({
    babel,
    eventEmitter: emitter,
    options: {
      root,
      filename,
      pluginOptions: loadWywOptions({
        configFile: false,
        rules: [{ test: () => true, action: shaker }],
        babelOptions: {
          babelrc: false,
          configFile: false,
        },
        ...overrides,
      }),
    },
  });

const testCssProcessorFile = join(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

describe('EvalBroker telemetry', () => {
  it('attributes batched roots explicitly when the middle root fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
    const entries = ['a', 'b', 'c'].map((name) => join(root, `${name}.js`));
    entries.forEach((entry) =>
      writeFileSync(entry, 'export const __wywPreval = {};')
    );

    const emitter = createEmitter();
    const services = createServices(root, entries[0], emitter);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const privateBroker = broker as unknown as {
      ensureRunner: () => Promise<void>;
      handleLoad: (
        requestId: string,
        payload: {
          id: string;
          importerId: string | null;
          request: string | null;
        }
      ) => Promise<void>;
      initRunner: (entrypoint: Entrypoint) => Promise<void>;
      loadModule: jest.Mock;
      request: (
        type: string,
        payload: unknown,
        timeoutMs?: number
      ) => Promise<unknown>;
      runnerInputQueue: unknown;
      sendMessage: (message: unknown) => Promise<void>;
    };
    privateBroker.ensureRunner = jest.fn(async () => {});
    privateBroker.initRunner = jest.fn(async () => {});
    privateBroker.runnerInputQueue = { write: () => Promise.resolve() };
    privateBroker.sendMessage = jest.fn(async () => {});
    privateBroker.loadModule = jest.fn(async (payload) => ({
      code: `export const value = ${JSON.stringify(payload.id)};`,
      hash: `hash:${payload.id}`,
      imports: null,
      only: ['value'],
    }));

    const executionOrder: string[] = [];
    privateBroker.request = jest.fn(async (type, payload) => {
      if (type !== 'EVAL') throw new Error(`unexpected request: ${type}`);
      const { id } = payload as { id: string };
      executionOrder.push(id);
      await privateBroker.handleLoad(`load:${id}`, {
        id: `${id}:dependency`,
        importerId: id,
        request: './dependency',
      });
      if (id === entries[1]) throw new Error('middle-fail');
      return {
        values: {
          value: serializeValue(id, { allowFunctions: true }),
        },
      };
    });

    try {
      const entrypoints = entries.map((entry) =>
        Entrypoint.createRoot(
          services,
          entry,
          ['__wywPreval'],
          readFileSync(entry, 'utf8')
        )
      );
      const settled = await Promise.allSettled(
        entrypoints.map((entrypoint) => broker.evaluate(entrypoint))
      );

      expect(executionOrder).toEqual(entries);
      expect(settled.map(({ status }) => status)).toEqual([
        'fulfilled',
        'rejected',
        'fulfilled',
      ]);

      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(3);
      expect(roots.map((record) => record.root.entrypoint)).toEqual(entries);
      expect(roots.map((record) => record.root.status)).toEqual([
        'success',
        'error',
        'success',
      ]);
      expect(roots.map((record) => record.root.batchIndex)).toEqual([0, 1, 2]);
      expect(roots.map((record) => record.root.batchSize)).toEqual([3, 3, 3]);
      expect(roots.map((record) => record.loads.requests)).toEqual([1, 1, 1]);
      expect(new Set(roots.map((record) => record.brokerId)).size).toBe(1);
      roots.forEach((record) => {
        expect(record.root.queueWaitMs).toBeGreaterThanOrEqual(0);
        expect(record.root.durationMs).toBeGreaterThanOrEqual(0);
      });
    } finally {
      unregister();
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves batch metadata when runner startup fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
    const entries = ['a', 'b', 'c'].map((name) => join(root, `${name}.js`));
    entries.forEach((entry) =>
      writeFileSync(entry, 'export const __wywPreval = {};')
    );

    const emitter = createEmitter();
    const services = createServices(root, entries[0], emitter);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const privateBroker = broker as unknown as {
      ensureRunner: () => Promise<void>;
    };
    privateBroker.ensureRunner = jest.fn(async () => {
      throw new Error('runner-unavailable');
    });

    try {
      const entrypoints = entries.map((entry) =>
        Entrypoint.createRoot(
          services,
          entry,
          ['__wywPreval'],
          readFileSync(entry, 'utf8')
        )
      );
      const settled = await Promise.allSettled(
        entrypoints.map((entrypoint) => broker.evaluate(entrypoint))
      );

      expect(settled.every(({ status }) => status === 'rejected')).toBe(true);
      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(3);
      expect(roots.map((record) => record.root.batchIndex)).toEqual([0, 1, 2]);
      expect(roots.map((record) => record.root.batchSize)).toEqual([3, 3, 3]);
      expect(roots.map((record) => record.root.status)).toEqual([
        'error',
        'error',
        'error',
      ]);
      expect(roots.map((record) => record.loads.requests)).toEqual([0, 0, 0]);
    } finally {
      unregister();
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('partitions miss, inflight hit, cache hit, and invalidation exactly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
    const entry = join(root, 'entry.js');
    const dependency = join(root, 'dependency.js');
    writeFileSync(entry, 'export const __wywPreval = {};');
    writeFileSync(dependency, 'export const value = 1;');

    let releaseFirstLoad:
      | ((value: { code: string; loader?: string | null }) => void)
      | undefined;
    let loaderCalls = 0;
    const customLoader = jest.fn(() => {
      loaderCalls += 1;
      if (loaderCalls === 1) {
        return new Promise<{ code: string }>((resolve) => {
          releaseFirstLoad = resolve;
        });
      }

      return Promise.resolve({ code: 'export const value = 2;' });
    });
    const emitter = createEmitter();
    const services = createServices(root, entry, emitter, {
      eval: { customLoader },
    });
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dependency)
    );
    const privateBroker = broker as unknown as {
      activeEvalTelemetry: EvalTelemetryToken | undefined;
      loadModule: (payload: {
        id: string;
        importerId: string | null;
        request: string | null;
      }) => Promise<{ code: string }>;
      onlyByModule: Map<string, string[]>;
    };
    const token = beginEvalTelemetry(emitter, broker, () => ({
      entrypoint: entry,
    }));
    expect(token).toBeDefined();
    token!.start({ batchIndex: 0, batchSize: 1 });
    privateBroker.activeEvalTelemetry = token;
    privateBroker.onlyByModule.set(dependency, ['*']);
    const payload = {
      id: dependency,
      importerId: entry,
      request: null,
    };

    try {
      token!.recordLoadRequest();
      const first = privateBroker.loadModule(payload);
      token!.recordLoadRequest();
      const inflight = privateBroker.loadModule(payload);
      expect(customLoader).toHaveBeenCalledTimes(1);
      releaseFirstLoad?.({ code: 'export const value = 1;' });
      await Promise.all([first, inflight]);

      token!.recordLoadRequest();
      await privateBroker.loadModule(payload);
      services.cache.invalidateForFile(dependency);
      token!.recordLoadRequest();
      await privateBroker.loadModule(payload);
      token!.finish('success');

      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(1);
      const [record] = roots;
      expect(record.loads.requests).toBe(4);
      expect(record.loads.cache).toEqual(
        expect.objectContaining({
          hits: 2,
          inflightHits: 1,
          inflightWaitMisses: 0,
          inflightWaits: 1,
          invalidationMisses: 1,
          misses: 2,
          promotions: 0,
        })
      );
      expect(record.loads.cache.outcomes).toEqual(
        expect.objectContaining({
          hit: 1,
          'inflight-hit': 1,
          'inflight-wait': 1,
          'invalidation-miss': 1,
          miss: 1,
        })
      );
      expect(record.evictions.hostPreparedCache).toEqual(
        expect.objectContaining({
          invalidation: 1,
          total: 1,
          unknownByteEntries: 0,
        })
      );
      expect(customLoader).toHaveBeenCalledTimes(2);
    } finally {
      privateBroker.activeEvalTelemetry = undefined;
      unregister();
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts an invalidated result inserted by an older in-flight load', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
    const entry = join(root, 'entry.js');
    const dependency = join(root, 'dependency.js');
    writeFileSync(entry, 'export const __wywPreval = {};');

    let resolveOld: ((value: { code: string }) => void) | undefined;
    const customLoader = jest
      .fn<() => Promise<{ code: string }>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValueOnce({ code: 'export const value = "fresh";' });
    const emitter = createEmitter();
    const services = createServices(root, entry, emitter, {
      eval: { customLoader },
    });
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dependency)
    );
    const privateBroker = broker as unknown as {
      activeEvalTelemetry: EvalTelemetryToken | undefined;
      loadModule: (payload: {
        id: string;
        importerId: string | null;
        request: string | null;
      }) => Promise<{ code: string; resetModule?: true }>;
      onlyByModule: Map<string, string[]>;
    };
    const token = beginEvalTelemetry(emitter, broker, () => ({
      entrypoint: entry,
    }));
    expect(token).toBeDefined();
    token!.start({ batchIndex: 0, batchSize: 1 });
    privateBroker.activeEvalTelemetry = token;
    privateBroker.onlyByModule.set(dependency, ['*']);
    const payload = {
      id: dependency,
      importerId: entry,
      request: './dependency.js',
    };

    try {
      token!.recordLoadRequest();
      const oldLoad = privateBroker.loadModule(payload);
      services.cache.invalidateForFile(dependency);
      token!.recordLoadRequest();
      const invalidatedLoad = privateBroker.loadModule(payload);
      resolveOld?.({ code: 'export const value = "old";' });

      const [oldResult, freshResult] = await Promise.all([
        oldLoad,
        invalidatedLoad,
      ]);
      expect(oldResult.code).toContain('"old"');
      expect(freshResult.code).toContain('"fresh"');
      expect(freshResult.resetModule).toBe(true);
      token!.finish('success');

      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(1);
      expect(roots[0].evictions.hostPreparedCache).toEqual(
        expect.objectContaining({
          invalidation: 1,
          total: 1,
          unknownByteEntries: 0,
        })
      );
      expect(customLoader).toHaveBeenCalledTimes(2);
    } finally {
      privateBroker.activeEvalTelemetry = undefined;
      unregister();
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records capacity eviction through the broker load cache wiring', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
    const entry = join(root, 'entry.js');
    const dependencyA = join(root, 'dependency-a.js');
    const dependencyB = join(root, 'dependency-b.js');
    const codeA = 'export const valueA = 1;';
    const codeB = 'export const valueB = 2;';
    const codeById = new Map([
      [dependencyA, codeA],
      [dependencyB, codeB],
    ]);
    writeFileSync(entry, 'export const __wywPreval = {};');

    const customLoader = jest.fn(async (id: string) => ({
      code: codeById.get(id)!,
    }));
    const emitter = createEmitter();
    const services = createServices(root, entry, emitter, {
      eval: { customLoader },
    });
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = broker as unknown as {
      activeEvalTelemetry: EvalTelemetryToken | undefined;
      handleLoad: (
        requestId: string,
        payload: {
          id: string;
          importerId: string | null;
          request: string | null;
        }
      ) => Promise<void>;
      loadCache: LruCache<string, { code: string }>;
      onlyByModule: Map<string, string[]>;
      runnerInputQueue: { write: (payload: string) => Promise<void> };
    };
    const wirePayloads: string[] = [];
    privateBroker.loadCache = new LruCache(1);
    privateBroker.runnerInputQueue = {
      write: async (payload: string) => {
        wirePayloads.push(payload);
      },
    };
    privateBroker.onlyByModule.set(dependencyA, ['*']);
    privateBroker.onlyByModule.set(dependencyB, ['*']);
    const token = beginEvalTelemetry(emitter, broker, () => ({
      entrypoint: entry,
    }));
    expect(token).toBeDefined();
    token!.start({ batchIndex: 0, batchSize: 1 });
    privateBroker.activeEvalTelemetry = token;

    try {
      await privateBroker.handleLoad('load-a', {
        id: dependencyA,
        importerId: entry,
        request: null,
      });
      await privateBroker.handleLoad('load-b', {
        id: dependencyB,
        importerId: entry,
        request: null,
      });
      token!.finish('success');

      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(1);
      const [record] = roots;
      expect(record.loads.requests).toBe(2);
      expect(record.evictions.hostPreparedCache).toEqual({
        capacity: 1,
        invalidation: 0,
        knownCodeBytes: Buffer.byteLength(codeA),
        replacement: 0,
        total: 1,
        unknownByteEntries: 0,
      });
      expect(privateBroker.loadCache.has(dependencyA)).toBe(false);
      expect(privateBroker.loadCache.has(dependencyB)).toBe(true);
      expect(customLoader).toHaveBeenCalledTimes(2);
      expect(JSON.parse(wirePayloads.at(-1)!).payload.code).toBe(codeB);
    } finally {
      privateBroker.activeEvalTelemetry = undefined;
      unregister();
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps inflight waits orthogonal when widening requires promotion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
    const entry = join(root, 'entry.js');
    const dependency = join(root, 'dependency.js');
    writeFileSync(entry, 'export const __wywPreval = {};');
    writeFileSync(dependency, 'export const first = 1;');

    let releaseNarrowLoad:
      | ((value: { code: string; loader?: string | null }) => void)
      | undefined;
    let loaderCalls = 0;
    const customLoader = jest.fn(() => {
      loaderCalls += 1;
      if (loaderCalls === 1) {
        return new Promise<{ code: string }>((resolve) => {
          releaseNarrowLoad = resolve;
        });
      }

      return Promise.resolve({
        code: 'export const first = 1; export const second = 2;',
      });
    });
    const emitter = createEmitter();
    const services = createServices(root, entry, emitter, {
      eval: { customLoader },
    });
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dependency)
    );
    const privateBroker = broker as unknown as {
      activeEvalTelemetry: EvalTelemetryToken | undefined;
      loadModule: (payload: {
        id: string;
        importerId: string | null;
        request: string | null;
      }) => Promise<{ code: string }>;
      onlyByModule: Map<string, string[]>;
    };
    const token = beginEvalTelemetry(emitter, broker, () => ({
      entrypoint: entry,
    }));
    expect(token).toBeDefined();
    token!.start({ batchIndex: 0, batchSize: 1 });
    privateBroker.activeEvalTelemetry = token;
    const payload = {
      id: dependency,
      importerId: entry,
      request: null,
    };

    try {
      privateBroker.onlyByModule.set(dependency, ['first']);
      token!.recordLoadRequest();
      const narrow = privateBroker.loadModule(payload);
      privateBroker.onlyByModule.set(dependency, ['first', 'second']);
      token!.recordLoadRequest();
      const wide = privateBroker.loadModule(payload);
      releaseNarrowLoad?.({ code: 'export const first = 1;' });
      await Promise.all([narrow, wide]);
      token!.finish('success');

      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(1);
      const [record] = roots;
      expect(record.loads.cache).toEqual(
        expect.objectContaining({
          hits: 0,
          inflightHits: 0,
          inflightWaitMisses: 1,
          inflightWaits: 1,
          misses: 2,
          promotions: 1,
        })
      );
      expect(record.loads.cache.outcomes).toEqual(
        expect.objectContaining({
          'inflight-wait': 1,
          'inflight-wait-miss': 1,
          miss: 1,
          promotion: 1,
        })
      );
      expect(record.evictions.hostPreparedCache).toEqual(
        expect.objectContaining({
          knownCodeBytes: Buffer.byteLength('export const first = 1;'),
          replacement: 1,
          total: 1,
          unknownByteEntries: 0,
        })
      );
      expect(customLoader).toHaveBeenCalledTimes(2);
    } finally {
      privateBroker.activeEvalTelemetry = undefined;
      unregister();
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('measures physical prepare, shake, and strip only on a cache miss', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
    const entry = join(root, 'styles.js');
    writeFileSync(
      entry,
      [
        "import { css } from 'test-css-processor';",
        'export const className = css`color: red;`;',
      ].join('\n')
    );

    const emitter = createEmitter();
    const services = createServices(root, entry, emitter, {
      tagResolver: (source, tag) =>
        source === 'test-css-processor' && tag === 'css'
          ? testCssProcessorFile
          : null,
    });
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = broker as unknown as {
      activeEvalTelemetry: EvalTelemetryToken | undefined;
      loadModule: (payload: {
        id: string;
        importerId: string | null;
        request: string | null;
      }) => Promise<{ code: string }>;
      onlyByModule: Map<string, string[]>;
    };
    const token = beginEvalTelemetry(emitter, broker, () => ({
      entrypoint: entry,
    }));
    expect(token).toBeDefined();
    token!.start({ batchIndex: 0, batchSize: 1 });
    privateBroker.activeEvalTelemetry = token;
    privateBroker.onlyByModule.set(entry, ['__wywPreval']);
    const payload = { id: entry, importerId: entry, request: entry };

    try {
      token!.recordLoadRequest();
      await privateBroker.loadModule(payload);
      token!.recordLoadRequest();
      await privateBroker.loadModule(payload);
      token!.finish('success');

      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(1);
      const [record] = roots;
      expect(record.loads.cache).toEqual(
        expect.objectContaining({ hits: 1, misses: 1 })
      );
      expect(record.loads.preparation).toEqual(
        expect.objectContaining({
          calls: 1,
          errors: 0,
          prepareCalls: 1,
          shakeCalls: 1,
          stripCalls: 1,
        })
      );
      expect(record.loads.preparation.preparedCodeBytes).toBeGreaterThan(0);
      expect(record.loads.preparation.artifacts).toEqual([
        expect.objectContaining({
          calls: 1,
          id: entry,
          onlyShape: 'named',
          outputRevision: expect.stringMatching(/^[\da-f]{64}$/u),
        }),
      ]);
    } finally {
      privateBroker.activeEvalTelemetry = undefined;
      unregister();
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps LOAD wire output identical while accounting for omission and resend reasons', async () => {
    const run = async (telemetryEnabled: boolean) => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
      const entry = join(root, 'entry.js');
      const dependency = 'virtual:dependency.js';
      writeFileSync(entry, 'export const __wywPreval = {};');
      const emitter = createEmitter();
      const records: EvalTelemetryRecord[] = [];
      const unregister = telemetryEnabled
        ? registerEvalTelemetryReporter(emitter, (record) => {
            records.push(record);
          })
        : () => {};
      const services = createServices(root, entry, emitter);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => dependency)
      );
      const privateBroker = broker as unknown as {
        activeEvalTelemetry: EvalTelemetryToken | undefined;
        handleLoad: (
          id: string,
          payload: {
            id: string;
            importerId: string | null;
            request: string | null;
          }
        ) => Promise<void>;
        loadMirror: { snapshot: () => EvalBrokerMirrorSnapshot };
        loadModule: jest.Mock;
        runnerInputQueue: { write: (payload: string) => Promise<void> };
      };
      const trace: string[] = [];
      privateBroker.runnerInputQueue = {
        write: async (payload) => {
          trace.push(payload);
        },
      };
      const code1 = 'export const value = 1;';
      const code2 = 'export const value = 2;';
      const code3 = 'export const value = 3;';
      const prepared = [
        {
          code: code1,
          hash: 'hash-1',
          imports: null,
          only: ['*'],
          resetModule: true as const,
        },
        { code: code1, hash: 'hash-1', imports: null, only: ['*'] },
        { code: code2, hash: 'hash-2', imports: null, only: ['*'] },
        { code: code3, hash: 'hash-3', imports: null, only: ['value'] },
        {
          code: code3,
          hash: 'hash-3',
          imports: null,
          only: ['value', 'other'],
        },
        { code: code3, hash: 'hash-3', imports: null, only: ['*'] },
        {
          code: code3,
          hash: 'hash-3',
          imports: null,
          only: ['*'],
          resetModule: true as const,
        },
        { code: '', hash: 'hash-4', imports: null, only: ['*'] },
        { code: '', hash: 'hash-5', imports: null, only: [] },
      ];
      privateBroker.loadModule = jest.fn(async () => prepared.shift()!);
      const token = telemetryEnabled
        ? beginEvalTelemetry(emitter, broker, () => ({ entrypoint: entry }))
        : undefined;
      token?.start({ batchIndex: 0, batchSize: 1 });
      privateBroker.activeEvalTelemetry = token;

      try {
        for (let index = 0; index < 9; index += 1) {
          // The mirror state under test is intentionally sequential.
          // eslint-disable-next-line no-await-in-loop
          await privateBroker.handleLoad(`load-${index}`, {
            id: dependency,
            importerId: entry,
            request: './dependency.js',
          });
        }
        token?.finish('success', privateBroker.loadMirror.snapshot());
        return { code1, code2, code3, records, trace };
      } finally {
        privateBroker.activeEvalTelemetry = undefined;
        unregister();
        broker.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    };

    const withoutTelemetry = await run(false);
    const withTelemetry = await run(true);
    expect(withTelemetry.trace).toEqual(withoutTelemetry.trace);

    const wire = withTelemetry.trace.map((line) => JSON.parse(line));
    expect(wire).toHaveLength(9);
    expect(wire[0].payload.code).toBe(withTelemetry.code1);
    expect(wire[0].payload.resetModule).toBe(true);
    expect(wire[1].payload).not.toHaveProperty('code');
    expect(wire[6].payload).toEqual(
      expect.objectContaining({
        code: withTelemetry.code3,
        resetModule: true,
      })
    );
    expect(wire[7].payload).toHaveProperty('code', '');
    expect(wire[8].payload).toHaveProperty('code', '');

    const roots = withTelemetry.records.filter(
      (record) => record.type === 'eval-root'
    );
    expect(roots).toHaveLength(1);
    const [record] = roots;
    expect(record.loads.requests).toBe(9);
    expect(record.loads.transmission).toEqual(
      expect.objectContaining({
        chunkedResults: 0,
        chunks: 0,
        codeBytes:
          Buffer.byteLength(withTelemetry.code1) +
          Buffer.byteLength(withTelemetry.code2) +
          Buffer.byteLength(withTelemetry.code3) * 4,
        emptyCodePayloads: 2,
        initial: 1,
        logicalResults: 9,
        moduleResetSignals: 2,
        omissions: 1,
        resendReasons: {
          'hash-change': 4,
          invalidation: 1,
          'only-widening': 1,
          'storage-shape-change': 1,
        },
        resends: 7,
        serializedExports: 0,
        wireMessages: 9,
      })
    );
    expect(record.loads.transmission.wireBytes).toBe(
      withTelemetry.trace.reduce(
        (total, line) => total + Buffer.byteLength(line),
        0
      )
    );
    expect(record.evictions.primaryPressureProxy.shipmentHashChanges).toBe(2);
    expect(record.evictions.variantPressureProxy.shipmentHashChanges).toBe(2);
    expect(record.mirror).toEqual({
      entries: 1,
      knownCodeBytes: 0,
      unknownByteEntries: 0,
    });
  });

  it('keeps telemetry-only timing and byte scans off the broker fast path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
    const entry = join(root, 'entry.js');
    writeFileSync(entry, 'export const __wywPreval = {};');
    const services = createServices(root, entry, EventEmitter.dummy);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = broker as unknown as {
      handleLoad: (
        id: string,
        payload: {
          id: string;
          importerId: string | null;
          request: string | null;
        }
      ) => Promise<void>;
      loadModule: jest.Mock;
      runnerInputQueue: { write: (payload: string) => Promise<void> };
    };
    privateBroker.loadModule = jest.fn(async () => ({
      code: 'export const value = 1;',
      hash: 'hash-1',
      imports: new Map([['./nested.js', ['value']]]),
      only: ['*'],
    }));
    privateBroker.runnerInputQueue = { write: async () => {} };
    const now = jest.spyOn(performance, 'now');
    const byteLength = jest.spyOn(Buffer, 'byteLength');
    const nowCallsBefore = now.mock.calls.length;
    const byteLengthCallsBefore = byteLength.mock.calls.length;

    try {
      await privateBroker.handleLoad('load-1', {
        id: join(root, 'dependency.js'),
        importerId: entry,
        request: './dependency.js',
      });

      expect(now.mock.calls).toHaveLength(nowCallsBefore);
      expect(byteLength.mock.calls).toHaveLength(byteLengthCallsBefore);
    } finally {
      now.mockRestore();
      byteLength.mockRestore();
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accounts for a delivered LOAD error response', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
    const entry = join(root, 'entry.js');
    writeFileSync(entry, 'export const __wywPreval = {};');
    const emitter = createEmitter();
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const services = createServices(root, entry, emitter);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = broker as unknown as {
      activeEvalTelemetry: EvalTelemetryToken | undefined;
      handleMessage: (message: unknown) => void;
      loadModule: jest.Mock;
      runnerInputQueue: { write: (payload: string) => Promise<void> };
    };
    const trace: string[] = [];
    privateBroker.runnerInputQueue = {
      write: async (payload) => {
        trace.push(payload);
      },
    };
    privateBroker.loadModule = jest.fn(async () => {
      throw new Error('load-failed');
    });
    const token = beginEvalTelemetry(emitter, broker, () => ({
      entrypoint: entry,
    }));
    expect(token).toBeDefined();
    token!.start({ batchIndex: 0, batchSize: 1 });
    privateBroker.activeEvalTelemetry = token;

    try {
      privateBroker.handleMessage({
        id: 'load-error',
        payload: {
          id: 'virtual:broken.js',
          importerId: entry,
          request: './broken.js',
        },
        type: 'LOAD',
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      token!.finish('error');

      expect(trace).toHaveLength(1);
      expect(JSON.parse(trace[0]).payload.error).toEqual(
        expect.objectContaining({ message: 'load-failed' })
      );
      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(1);
      expect(roots[0].loads.requests).toBe(1);
      expect(roots[0].loads.transmission).toEqual(
        expect.objectContaining({
          errors: 1,
          incompleteResults: 0,
          logicalResults: 1,
          wireBytes: Buffer.byteLength(trace[0]),
          wireMessages: 1,
        })
      );
    } finally {
      privateBroker.activeEvalTelemetry = undefined;
      unregister();
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records serialized-export LOAD outcomes without preparing code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
    const entry = join(root, 'entry.js');
    const dependency = join(root, 'dependency.js');
    writeFileSync(entry, 'export const __wywPreval = {};');
    const emitter = createEmitter();
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const services = createServices(root, entry, emitter);
    services.cache.add('exports', dependency, ['value']);
    services.cache.add('entrypoints', dependency, {
      evaluated: true,
      evaluatedOnly: ['value'],
      exports: { value: 42 },
      ignored: false,
    } as never);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dependency)
    );
    const privateBroker = broker as unknown as {
      activeEvalTelemetry: EvalTelemetryToken | undefined;
      handleLoad: (
        id: string,
        payload: {
          id: string;
          importerId: string | null;
          request: string | null;
        }
      ) => Promise<void>;
      onlyByModule: Map<string, string[]>;
      runnerInputQueue: { write: (payload: string) => Promise<void> };
    };
    const trace: string[] = [];
    privateBroker.runnerInputQueue = {
      write: async (payload) => {
        trace.push(payload);
      },
    };
    privateBroker.onlyByModule.set(dependency, ['value']);
    const token = beginEvalTelemetry(emitter, broker, () => ({
      entrypoint: entry,
    }));
    expect(token).toBeDefined();
    token!.start({ batchIndex: 0, batchSize: 1 });
    privateBroker.activeEvalTelemetry = token;

    try {
      await privateBroker.handleLoad('load-serialized', {
        id: dependency,
        importerId: null,
        request: null,
      });
      token!.finish('success');

      expect(trace).toHaveLength(1);
      expect(JSON.parse(trace[0]).payload).toEqual(
        expect.objectContaining({
          exports: expect.objectContaining({ value: expect.any(Object) }),
        })
      );
      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(1);
      expect(roots[0].loads.cache.serializedExports).toBe(1);
      expect(roots[0].loads.preparation.calls).toBe(0);
      expect(roots[0].loads.transmission).toEqual(
        expect.objectContaining({
          logicalResults: 1,
          serializedExports: 1,
          wireBytes: Buffer.byteLength(trace[0]),
          wireMessages: 1,
        })
      );
    } finally {
      privateBroker.activeEvalTelemetry = undefined;
      unregister();
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('observes existing poison and reset signals and keeps the mirror exact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
    const entry = join(root, 'entry.js');
    writeFileSync(entry, 'export const __wywPreval = {};');
    const emitter = createEmitter();
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const services = createServices(root, entry, emitter);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = broker as unknown as {
      activeEvalTelemetry: EvalTelemetryToken | undefined;
      handleLoad: (
        id: string,
        payload: {
          id: string;
          importerId: string | null;
          request: string | null;
        }
      ) => Promise<void>;
      handleMessage: (message: unknown) => void;
      loadMirror: { snapshot: () => EvalBrokerMirrorSnapshot };
      loadModule: jest.Mock;
      runnerInputQueue: { write: (payload: string) => Promise<void> };
    };
    privateBroker.runnerInputQueue = { write: async () => {} };
    privateBroker.loadModule = jest
      .fn()
      .mockResolvedValueOnce({
        code: 'export const a = 1;',
        hash: 'hash-a',
        imports: null,
        only: ['*'],
      })
      .mockResolvedValueOnce({
        code: 'export const b = 2;',
        hash: 'hash-b',
        imports: null,
        only: ['*'],
      });
    const token = beginEvalTelemetry(emitter, broker, () => ({
      entrypoint: entry,
    }));
    expect(token).toBeDefined();
    token!.start({ batchIndex: 0, batchSize: 1 });
    privateBroker.activeEvalTelemetry = token;

    try {
      await privateBroker.handleLoad('load-a', {
        id: 'virtual:a.js',
        importerId: entry,
        request: './a.js',
      });
      await privateBroker.handleLoad('load-b', {
        id: 'virtual:b.js',
        importerId: entry,
        request: './b.js',
      });
      privateBroker.handleMessage({
        id: 'eval-result',
        payload: { evictedIds: ['virtual:a.js', 'virtual:a.js'], values: null },
        type: 'EVAL_RESULT',
      });
      privateBroker.handleMessage({
        id: 'init-result',
        modulesReset: true,
        type: 'INIT_ACK',
      });
      token!.finish('success', privateBroker.loadMirror.snapshot());

      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(1);
      expect(roots[0].evictions).toEqual(
        expect.objectContaining({
          brokerObservedPoisonIds: 1,
          brokerObservedPoisonSignals: 1,
          brokerObservedResetSignals: 1,
        })
      );
      expect(roots[0].mirror).toEqual({
        entries: 0,
        knownCodeBytes: 0,
        unknownByteEntries: 0,
      });
    } finally {
      privateBroker.activeEvalTelemetry = undefined;
      unregister();
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records broker registry create, reuse, and disposal observations', () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
    const entry = join(root, 'entry.js');
    writeFileSync(entry, 'export const __wywPreval = {};');
    const emitter = createEmitter();
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const services = createServices(root, entry, emitter);
    const resolve = jest.fn(async () => null);

    try {
      const first = getEvalBroker(services, resolve, 'stable-key');
      expect(getEvalBroker(services, resolve, 'stable-key')).toBe(first);
      disposeEvalBroker(services.cache);

      const lifecycle = records.filter(
        (record) => record.type === 'eval-lifecycle'
      );
      expect(lifecycle.map((record) => record.event)).toEqual([
        'broker-created',
        'broker-reused',
        'broker-dispose-observed',
      ]);
      expect(lifecycle.map((record) => record.reason)).toEqual([
        'constructor',
        'stable-cache-key',
        'registry-dispose',
      ]);
      expect(lifecycle.every((record) => record.brokerId === 1)).toBe(true);
    } finally {
      disposeEvalBroker(services.cache);
      unregister();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves EvaluateResult and observes the real runner lifecycle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
    const entry = join(root, 'entry.js');
    writeFileSync(
      entry,
      ['export const __wywPreval = {', '  value: () => 42,', '};'].join('\n')
    );

    const run = async (telemetryEnabled: boolean) => {
      const emitter = createEmitter();
      const records: EvalTelemetryRecord[] = [];
      const unregister = telemetryEnabled
        ? registerEvalTelemetryReporter(emitter, (record) => {
            records.push(record);
          })
        : () => {};
      const services = createServices(root, entry, emitter);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf8')
      );

      try {
        return { records, result: await broker.evaluate(entrypoint) };
      } finally {
        broker.dispose('test-complete');
        unregister();
      }
    };

    try {
      const withoutTelemetry = await run(false);
      const withTelemetry = await run(true);
      expect(Array.from(withTelemetry.result.values ?? [])).toEqual(
        Array.from(withoutTelemetry.result.values ?? [])
      );
      expect(withTelemetry.result.dependencies).toEqual(
        withoutTelemetry.result.dependencies
      );

      const lifecycle = withTelemetry.records.filter(
        (record) => record.type === 'eval-lifecycle'
      );
      expect(lifecycle.map((record) => [record.event, record.reason])).toEqual([
        ['broker-created', 'constructor'],
        ['runner-spawn-attempt', 'ensure'],
        ['runner-activated', 'ensure'],
        ['broker-dispose-observed', 'test-complete'],
        ['runner-stop-requested', 'test-complete'],
      ]);
      expect(
        withTelemetry.records.filter((record) => record.type === 'eval-root')
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('attributes first runner activation to the services that requested it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
    const entry = join(root, 'entry.js');
    writeFileSync(
      entry,
      ['export const __wywPreval = {', '  value: () => 42,', '};'].join('\n')
    );
    const previousEmitter = createEmitter();
    const activeEmitter = createEmitter();
    const previousRecords: EvalTelemetryRecord[] = [];
    const activeRecords: EvalTelemetryRecord[] = [];
    const unregisterPrevious = registerEvalTelemetryReporter(
      previousEmitter,
      (record) => previousRecords.push(record)
    );
    const unregisterActive = registerEvalTelemetryReporter(
      activeEmitter,
      (record) => activeRecords.push(record)
    );
    const previousServices = createServices(root, entry, previousEmitter);
    const activeServices = {
      ...previousServices,
      eventEmitter: activeEmitter,
    };
    const broker = new EvalBroker(
      previousServices,
      jest.fn(async () => null)
    );
    const entrypoint = Entrypoint.createRoot(
      activeServices,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf8')
    );

    try {
      await broker.evaluate(entrypoint, activeServices);

      expect(
        previousRecords
          .filter((record) => record.type === 'eval-lifecycle')
          .map((record) => record.event)
      ).toEqual(['broker-created']);
      expect(
        activeRecords
          .filter((record) => record.type === 'eval-lifecycle')
          .map((record) => record.event)
      ).toEqual(['runner-spawn-attempt', 'runner-activated']);
      expect(
        activeRecords.filter((record) => record.type === 'eval-root')
      ).toHaveLength(1);
    } finally {
      broker.dispose('test-complete');
      unregisterPrevious();
      unregisterActive();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('observes runner replacement and exit without changing child handling', () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
    const entry = join(root, 'entry.js');
    writeFileSync(entry, 'export const __wywPreval = {};');
    const emitter = createEmitter();
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const services = createServices(root, entry, emitter);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = broker as unknown as {
      replaceRunner: (runner: unknown) => void;
      runner: unknown;
    };
    const createFakeRunner = () => {
      const runner = new NodeEventEmitter() as NodeEventEmitter & {
        kill: jest.Mock;
        stderr: PassThrough;
        stdin: PassThrough;
        stdout: PassThrough;
      };
      runner.kill = jest.fn();
      runner.stderr = new PassThrough();
      runner.stdin = new PassThrough();
      runner.stdout = new PassThrough();
      return runner;
    };
    const previous = createFakeRunner();
    const next = createFakeRunner();
    privateBroker.runner = previous;

    try {
      privateBroker.replaceRunner(next);
      expect(previous.kill).toHaveBeenCalledTimes(1);
      next.emit('exit', 17, null);

      const lifecycle = records.filter(
        (record) => record.type === 'eval-lifecycle'
      );
      expect(lifecycle.map((record) => record.event)).toEqual([
        'broker-created',
        'runner-stop-requested',
        'runner-activated',
        'runner-exit-observed',
      ]);
      expect(lifecycle[1]).toEqual(
        expect.objectContaining({ reason: 'happy-dom-replacement' })
      );
      expect(lifecycle[2]).toEqual(
        expect.objectContaining({
          reason: 'happy-dom-replacement',
          restartInferred: false,
        })
      );
      expect(lifecycle[3].reason).toContain('17 / null');
      expect(privateBroker.runner).toBeNull();
    } finally {
      broker.dispose();
      unregister();
      [previous, next].forEach((runner) => {
        runner.stdin.destroy();
        runner.stdout.destroy();
        runner.stderr.destroy();
      });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts physical chunk messages and serialized UTF-8 bytes once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-telemetry-'));
    const entry = join(root, 'entry.js');
    writeFileSync(entry, 'export const __wywPreval = {};');
    const emitter = createEmitter();
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const services = createServices(root, entry, emitter);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = broker as unknown as {
      runnerInputQueue: { write: (payload: string) => Promise<void> };
      sendLoadResult: (
        id: string,
        payload: {
          code: string;
          hash: string;
          id: string;
          map: null;
          only: string[];
        },
        telemetry: {
          details: {
            code: string;
            imports: Map<string, string[]>;
            mode: 'initial';
          };
          token: EvalTelemetryToken;
        }
      ) => Promise<void>;
    };
    const trace: string[] = [];
    privateBroker.runnerInputQueue = {
      write: async (payload) => {
        trace.push(payload);
      },
    };
    const token = beginEvalTelemetry(emitter, broker, () => ({
      entrypoint: entry,
    }));
    expect(token).toBeDefined();
    token!.start({ batchIndex: 0, batchSize: 1 });
    const code = 'x'.repeat(10 * 1024 * 1024);

    try {
      await privateBroker.sendLoadResult(
        'load-chunked',
        {
          code,
          hash: 'chunked-hash',
          id: entry,
          map: null,
          only: ['*'],
          resetModule: true,
        },
        {
          details: {
            code,
            mode: 'initial',
          },
          token: token!,
        }
      );
      token!.finish('success');

      expect(trace).toHaveLength(20);
      const wire = trace.map((line) => JSON.parse(line));
      expect(wire[0].payload).toEqual(
        expect.objectContaining({
          chunkCount: 20,
          chunkIndex: 0,
          hash: 'chunked-hash',
          only: ['*'],
          resetModule: true,
        })
      );
      expect(wire[1].payload).not.toHaveProperty('hash');
      expect(wire[1].payload).not.toHaveProperty('resetModule');
      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(1);
      expect(roots[0].loads.transmission).toEqual(
        expect.objectContaining({
          chunkedResults: 1,
          chunks: 20,
          codeBytes: Buffer.byteLength(code),
          initial: 1,
          logicalResults: 1,
          moduleResetSignals: 1,
          wireBytes: trace.reduce(
            (total, line) => total + Buffer.byteLength(line),
            0
          ),
          wireMessages: 20,
        })
      );

      const partial = beginEvalTelemetry(emitter, broker, () => ({
        entrypoint: entry,
      }));
      expect(partial).toBeDefined();
      partial!.start({ batchIndex: 0, batchSize: 1 });
      const partialTrace: string[] = [];
      let writeAttempt = 0;
      privateBroker.runnerInputQueue = {
        write: async (payload) => {
          writeAttempt += 1;
          if (writeAttempt === 2) throw new Error('chunk-write-failed');
          partialTrace.push(payload);
        },
      };
      await expect(
        privateBroker.sendLoadResult(
          'load-partial',
          {
            code,
            hash: 'partial-hash',
            id: entry,
            map: null,
            only: ['*'],
            resetModule: true,
          },
          {
            details: { code, mode: 'initial' },
            token: partial!,
          }
        )
      ).rejects.toThrow('chunk-write-failed');
      partial!.finish('error');

      const completedRoots = records.filter(
        (record) => record.type === 'eval-root'
      );
      expect(completedRoots).toHaveLength(2);
      expect(completedRoots[1].loads.transmission).toEqual(
        expect.objectContaining({
          chunks: 1,
          codeBytes: 512 * 1024,
          incompleteResults: 1,
          logicalResults: 0,
          moduleResetSignals: 0,
          wireBytes: Buffer.byteLength(partialTrace[0]),
          wireMessages: 1,
        })
      );

      const firstWriteFailure = beginEvalTelemetry(emitter, broker, () => ({
        entrypoint: entry,
      }));
      expect(firstWriteFailure).toBeDefined();
      firstWriteFailure!.start({ batchIndex: 0, batchSize: 1 });
      privateBroker.runnerInputQueue = {
        write: async () => {
          throw new Error('first-write-failed');
        },
      };
      await expect(
        privateBroker.sendLoadResult(
          'load-first-write-failure',
          {
            code,
            hash: 'first-write-failure-hash',
            id: entry,
            map: null,
            only: ['*'],
          },
          {
            details: { code, mode: 'initial' },
            token: firstWriteFailure!,
          }
        )
      ).rejects.toThrow('first-write-failed');
      firstWriteFailure!.finish('error');

      const allRoots = records.filter((record) => record.type === 'eval-root');
      expect(allRoots).toHaveLength(3);
      expect(allRoots[2].loads.transmission).toEqual(
        expect.objectContaining({
          chunks: 0,
          codeBytes: 0,
          incompleteResults: 1,
          logicalResults: 0,
          wireBytes: 0,
          wireMessages: 0,
        })
      );
    } finally {
      unregister();
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
