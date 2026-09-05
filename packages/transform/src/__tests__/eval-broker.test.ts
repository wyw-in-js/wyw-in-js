import * as babel from '@babel/core';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';

import {
  loadWywOptions,
  type PartialOptions,
} from '../transform/helpers/loadWywOptions';
import { oxcShaker, shaker } from '../shaker';
import { withDefaultServices } from '../transform/helpers/withDefaultServices';
import { Entrypoint } from '../transform/Entrypoint';
import { AbortError } from '../transform/actions/AbortError';
import { isCacheEpochAbortedError } from '../transform/actions/CacheEpochAbortedError';
import {
  CACHE_KEY_SALT_BUSY,
  isCacheKeySaltBusyError,
} from '../transform/actions/CacheKeySaltBusyError';
import {
  disposeEvalBroker,
  EvalBroker,
  getEvalBroker,
  stripEntrypointGlobalsFromRunnerContext,
} from '../eval/broker';
import { prepareModuleOnDemand } from '../eval/prepareModuleOnDemand';
import { serializeValue } from '../eval/serialize';
import { EventEmitter } from '../utils/EventEmitter';
import {
  CacheKeySaltBusyError,
  TransformCacheCollection,
  type TransformCacheEpoch,
} from '../cache';

const createPluginOptions = (overrides: PartialOptions = {}) =>
  loadWywOptions({
    configFile: false,
    rules: [
      {
        test: () => true,
        action: shaker,
      },
    ],
    babelOptions: {
      babelrc: false,
      configFile: false,
      presets: [
        ['@babel/preset-env', { loose: true }],
        '@babel/preset-react',
        '@babel/preset-typescript',
      ],
    },
    ...overrides,
  });

const createServices = (
  root: string,
  filename: string,
  overrides: PartialOptions = {}
) => {
  const pluginOptions = createPluginOptions(overrides);
  const cache = new TransformCacheCollection();
  return withDefaultServices({
    babel,
    cache,
    cacheEpoch: cache.getCurrentEpoch(),
    options: {
      root,
      filename,
      pluginOptions,
    },
  }) as ReturnType<typeof withDefaultServices> & {
    cacheEpoch: TransformCacheEpoch;
  };
};

const createEntrypointAfterRecovery = <T>(
  services: ReturnType<typeof createServices>,
  create: () => T
): T => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return create();
    } catch (error) {
      if (!isCacheEpochAbortedError(error) || attempt === 3) {
        throw error;
      }

      // eslint-disable-next-line no-param-reassign
      services.cacheEpoch = services.cache.getCurrentEpoch();
    }
  }
};

const testCssProcessorFile = join(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const getPrivateBroker = (broker: EvalBroker) =>
  broker as unknown as {
    activeEntrypoint: Entrypoint | null;
    activeResolveRootId: string | null;
    activeRunnerSessionId: number;
    currentServices: ReturnType<typeof createServices>;
    happyDomDisabled: boolean;
    importsByModule: Map<string, Map<string, string[]>>;
    lastHappyDomEnabled: boolean;
    lastInitKey: string | null;
    loadMirror: { get: (id: string) => { only: string[] } | undefined };
    onlyByModule: Map<string, string[]>;
    sessionLinkGraph: Set<string>;
    applyModuleExports: (
      modules: Record<
        string,
        Record<string, ReturnType<typeof serializeValue>>
      >,
      expectedEntrypoints: ReadonlyMap<string, unknown>,
      cacheOwner: TransformCacheEpoch['owner'],
      cacheGeneration: object,
      rootEntrypoint: Entrypoint
    ) => unknown;
    ensureImportsMapping: (
      id: string,
      imports: Map<string, string[]> | null | undefined
    ) => void;
    ensureRunner: () => Promise<void>;
    handleRunnerStderr: (chunk: Buffer) => void;
    handleMessage: (message: unknown, runner?: unknown) => void;
    getCacheGeneration: (cacheOwner: TransformCacheEpoch['owner']) => object;
    initIsolatedRunner: (
      payload: unknown,
      timeoutMs: number
    ) => Promise<unknown>;
    initRunner: (entrypoint: Entrypoint) => Promise<void>;
    loadModule: (payload: {
      id: string;
      importerId?: string | null;
      request?: string | null;
    }) => Promise<{
      code: string;
      hash?: string;
      imports: Map<string, string[]> | null;
      only: string[];
      exports?: Record<string, ReturnType<typeof serializeValue>>;
      resetModule?: true;
    }>;
    loadInFlight: Map<string, Promise<unknown>>;
    request: (
      type: 'INIT' | 'EVAL',
      payload: unknown,
      timeoutMs?: number
    ) => Promise<unknown>;
    resolveImport: (payload: {
      importerId: string;
      kind: 'import' | 'dynamic-import' | 'require';
      specifier: string;
    }) => Promise<{ resolvedId: string | null }>;
    runner: unknown;
    runnerInputQueue: { write: (payload: string) => Promise<void> } | null;
  };

const createActionIdHandler = () => {
  let actionId = 0;
  return (phase: string) => {
    if (phase !== 'start') {
      return undefined;
    }

    const id = actionId;
    actionId += 1;
    return id;
  };
};

describe('EvalBroker', () => {
  it('strips default entrypoint globals from stable override context payloads', () => {
    const entry = '/tmp/example/entry.js';
    const globals = {
      IMPORT_META_ENV: { MODE: 'test' },
      __dirname: '/tmp/example',
      __filename: entry,
    };

    expect(stripEntrypointGlobalsFromRunnerContext(globals, entry)).toEqual({
      IMPORT_META_ENV: { MODE: 'test' },
    });
    expect(globals).toEqual({
      IMPORT_META_ENV: { MODE: 'test' },
      __dirname: '/tmp/example',
      __filename: entry,
    });
  });

  it('reuses one runner process while isolating resolver semantic sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const serverTheme = join(root, 'server-theme.js');
    const clientTheme = join(root, 'client-theme.js');
    const source = [
      "import { value } from 'theme';",
      'export const __wywPreval = {',
      '  value: () => value,',
      '};',
    ].join('\n');
    writeFileSync(entry, source);
    writeFileSync(
      serverTheme,
      [
        "globalThis.__wywResolverSessionLeak = 'server';",
        "sessionState.value = 'server';",
        "export const value = 'server';",
      ].join('\n')
    );
    writeFileSync(
      clientTheme,
      "export const value = globalThis.__wywResolverSessionLeak ?? sessionState.value ?? 'client';"
    );

    const brokerScope = {};
    const serverResolve = jest.fn(async (what: string) =>
      what === 'theme' ? serverTheme : null
    );
    const clientResolve = jest.fn(async (what: string) =>
      what === 'theme' ? clientTheme : null
    );
    const serverServices = createServices(root, entry, {
      eval: { globals: { sessionState: {} } },
    });
    const clientServices = createServices(root, entry, {
      eval: { globals: { sessionState: {} } },
    });
    serverServices.asyncResolve = serverResolve;
    serverServices.evalBrokerScope = brokerScope;
    serverServices.evalCacheKey = 'server-resolver-semantics';
    clientServices.asyncResolve = clientResolve;
    clientServices.evalBrokerScope = brokerScope;
    clientServices.evalCacheKey = 'client-resolver-semantics';

    const broker = getEvalBroker(
      serverServices,
      serverResolve,
      serverServices.evalCacheKey
    );
    expect(
      getEvalBroker(clientServices, clientResolve, clientServices.evalCacheKey)
    ).toBe(broker);
    const privateBroker = broker as unknown as {
      createRunnerProcess: (reason: string) => unknown;
      currentServices: ReturnType<typeof createServices>;
    };
    expect(privateBroker.currentServices).not.toBe(serverServices);
    expect(privateBroker.currentServices.asyncResolve).toBeUndefined();
    expect(privateBroker.currentServices.cache).not.toBe(serverServices.cache);
    const spawnSpy = jest.spyOn(privateBroker, 'createRunnerProcess');

    try {
      const serverEntrypoint = Entrypoint.createRoot(
        serverServices,
        entry,
        ['__wywPreval'],
        source
      );
      const clientEntrypoint = Entrypoint.createRoot(
        clientServices,
        entry,
        ['__wywPreval'],
        source
      );

      const serverResult = await broker.evaluate(
        serverEntrypoint,
        serverServices
      );
      const clientResult = await broker.evaluate(
        clientEntrypoint,
        clientServices
      );

      expect(serverResult.values?.get('value')).toBe('server');
      expect(clientResult.values?.get('value')).toBe('client');
      expect(privateBroker.currentServices).not.toBe(clientServices);
      expect(privateBroker.currentServices.asyncResolve).toBeUndefined();
      expect(privateBroker.currentServices.cache).not.toBe(
        clientServices.cache
      );
      expect(serverResolve).toHaveBeenCalledWith(
        'theme',
        entry,
        expect.any(Array)
      );
      expect(clientResolve).toHaveBeenCalledWith(
        'theme',
        entry,
        expect.any(Array)
      );
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    } finally {
      disposeEvalBroker(brokerScope);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps module state isolated when a scoped runner sees a new cache', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const firstSource = "export const __wywPreval = { value: () => 'red' };";
    const secondSource = "export const __wywPreval = { value: () => 'blue' };";
    const brokerScope = {};
    const asyncResolve = async () => null;
    const firstServices = createServices(root, entry);
    const secondServices = createServices(root, entry);
    for (const services of [firstServices, secondServices]) {
      services.asyncResolve = asyncResolve;
      services.evalBrokerScope = brokerScope;
      services.evalCacheKey = 'stable-resolver-semantics';
    }
    const broker = getEvalBroker(
      firstServices,
      asyncResolve,
      firstServices.evalCacheKey
    );

    try {
      writeFileSync(entry, firstSource);
      const firstEntrypoint = Entrypoint.createRoot(
        firstServices,
        entry,
        ['__wywPreval'],
        firstSource
      );
      expect(
        (await broker.evaluate(firstEntrypoint, firstServices)).values?.get(
          'value'
        )
      ).toBe('red');
      const { runner } = getPrivateBroker(broker);

      writeFileSync(entry, secondSource);
      const secondEntrypoint = Entrypoint.createRoot(
        secondServices,
        entry,
        ['__wywPreval'],
        secondSource
      );
      expect(
        (await broker.evaluate(secondEntrypoint, secondServices)).values?.get(
          'value'
        )
      ).toBe('blue');
      expect(getPrivateBroker(broker).runner).toBe(runner);
    } finally {
      disposeEvalBroker(brokerScope);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps active cache B alive while reset rejects an older cache A batch member', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entryA = join(root, 'a.js');
    const entryB = join(root, 'b.js');
    const depB = join(root, 'dep-b.js');
    const sourceA = "export const __wywPreval = { value: () => 'from-a' };";
    const sourceB = [
      "import { value } from './dep-b.js';",
      'export const __wywPreval = { value: () => value };',
    ].join('\n');
    writeFileSync(entryA, sourceA);
    writeFileSync(entryB, sourceB);
    writeFileSync(depB, "export const value = 'from-b';");

    let releaseB!: () => void;
    let markBStarted!: () => void;
    const bGate = new Promise<void>((resolveGate) => {
      releaseB = resolveGate;
    });
    const bStarted = new Promise<void>((resolveStarted) => {
      markBStarted = resolveStarted;
    });
    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (importer === entryB && what === './dep-b.js') {
        markBStarted();
        await bGate;
        return depB;
      }
      return what.startsWith('.') ? resolve(dirname(importer), what) : null;
    });
    const brokerScope = {};
    const servicesA = createServices(root, entryA);
    const servicesB = createServices(root, entryB);
    for (const services of [servicesA, servicesB]) {
      services.asyncResolve = asyncResolve;
      services.evalBrokerScope = brokerScope;
      services.evalCacheKey = 'shared-resolver-semantics';
    }
    const broker = getEvalBroker(
      servicesB,
      asyncResolve,
      servicesB.evalCacheKey
    );
    let evalA: ReturnType<typeof broker.evaluate> | undefined;
    let evalB: ReturnType<typeof broker.evaluate> | undefined;

    try {
      const entrypointB = Entrypoint.createRoot(
        servicesB,
        entryB,
        ['__wywPreval'],
        sourceB
      );
      const staleEntrypointA = Entrypoint.createRoot(
        servicesA,
        entryA,
        ['__wywPreval'],
        sourceA
      );
      evalB = broker.evaluate(entrypointB, servicesB);
      evalA = broker.evaluate(staleEntrypointA, servicesA);
      const rejectionA = evalA.then(
        () => undefined,
        (error: unknown) => error
      );

      await bStarted;
      const runnerB = getPrivateBroker(broker).runner;
      const resetError = new Error('cache A reset');
      const recovery = servicesA.cache.startSupersedeStormRecovery(
        resetError,
        entryA,
        servicesA.cacheEpoch
      );
      expect(recovery.started).toBe(true);
      recovery.complete();
      const notRejected = Symbol('not-rejected');
      const earlyAResult = await Promise.race([
        rejectionA,
        new Promise<symbol>((resolveTimeout) => {
          setTimeout(() => resolveTimeout(notRejected), 50);
        }),
      ]);

      expect(earlyAResult).toBe(recovery.abortError);
      expect(getPrivateBroker(broker).runner).toBe(runnerB);

      releaseB();
      expect((await evalB).values?.get('value')).toBe('from-b');
      await expect(evalA).rejects.toBe(recovery.abortError);

      servicesA.cacheEpoch = servicesA.cache.getCurrentEpoch();
      const freshEntrypointA = Entrypoint.createRoot(
        servicesA,
        entryA,
        ['__wywPreval'],
        sourceA
      );
      expect(
        (await broker.evaluate(freshEntrypointA, servicesA)).values?.get(
          'value'
        )
      ).toBe('from-a');
    } finally {
      releaseB();
      await evalA?.catch(() => undefined);
      await evalB?.catch(() => undefined);
      disposeEvalBroker(brokerScope);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers queued cache B after reset aborts active cache A', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entryA = join(root, 'a.js');
    const entryB = join(root, 'b.js');
    const virtualA = join(root, 'virtual-a.js');
    const sourceA = [
      "import { value } from 'virtual-a';",
      'export const __wywPreval = { value: () => value };',
    ].join('\n');
    const sourceB = "export const __wywPreval = { value: () => 'from-b' };";
    writeFileSync(entryA, sourceA);
    writeFileSync(entryB, sourceB);

    let releaseA!: () => void;
    let markAStarted!: () => void;
    const aGate = new Promise<void>((resolveGate) => {
      releaseA = resolveGate;
    });
    const aStarted = new Promise<void>((resolveStarted) => {
      markAStarted = resolveStarted;
    });
    let markAFinished!: () => void;
    const aFinished = new Promise<void>((resolveFinished) => {
      markAFinished = resolveFinished;
    });
    const brokerScope = {};
    const servicesA = createServices(root, entryA, {
      eval: {
        customLoader: async (id) => {
          if (id !== virtualA) return undefined;
          markAStarted();
          await aGate;
          markAFinished();
          return { code: "export const value = 'stale-a';" };
        },
      },
    });
    const servicesB = createServices(root, entryB);
    const asyncResolve = async (what: string) =>
      what === 'virtual-a' ? virtualA : null;
    for (const services of [servicesA, servicesB]) {
      services.asyncResolve = asyncResolve;
      services.evalBrokerScope = brokerScope;
      services.evalCacheKey = 'shared-resolver-semantics';
    }
    const broker = getEvalBroker(
      servicesA,
      asyncResolve,
      servicesA.evalCacheKey
    );
    let evalA: ReturnType<typeof broker.evaluate> | undefined;
    let evalB: ReturnType<typeof broker.evaluate> | undefined;

    try {
      const entrypointA = Entrypoint.createRoot(
        servicesA,
        entryA,
        ['__wywPreval'],
        sourceA
      );
      const entrypointB = Entrypoint.createRoot(
        servicesB,
        entryB,
        ['__wywPreval'],
        sourceB
      );
      evalA = broker.evaluate(entrypointA, servicesA);
      evalB = broker.evaluate(entrypointB, servicesB);
      const rejectionA = evalA.then(
        () => undefined,
        (error: unknown) => error
      );

      await aStarted;
      const resetError = new Error('active cache A reset');
      const recovery = servicesA.cache.startSupersedeStormRecovery(
        resetError,
        entryA,
        servicesA.cacheEpoch
      );
      expect(recovery.started).toBe(true);
      recovery.complete();
      const notRejected = Symbol('not-rejected');
      const earlyAResult = await Promise.race([
        rejectionA,
        new Promise<symbol>((resolveTimeout) => {
          setTimeout(() => resolveTimeout(notRejected), 50);
        }),
      ]);

      expect(earlyAResult).toBe(recovery.abortError);
      expect((await evalB).values?.get('value')).toBe('from-b');
      await expect(evalA).rejects.toBe(recovery.abortError);

      releaseA();
      await aFinished;
      await new Promise<void>((resolveImmediate) => {
        setImmediate(resolveImmediate);
      });
      expect(getPrivateBroker(broker).runner).not.toBeNull();
    } finally {
      releaseA();
      await evalA?.catch(() => undefined);
      await evalB?.catch(() => undefined);
      disposeEvalBroker(brokerScope);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries ensureRunner when cache reset retires the awaited runner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const source = 'export const __wywPreval = {};';
    writeFileSync(entry, source);
    const services = createServices(root, entry);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = getPrivateBroker(broker) as ReturnType<
      typeof getPrivateBroker
    > & {
      runnerReady: Promise<void> | null;
    };
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      source
    );
    let releaseReady!: () => void;
    const runnerReady = new Promise<void>((resolveReady) => {
      releaseReady = resolveReady;
    });
    const staleRunner = {
      kill: jest.fn(),
      removeAllListeners: jest.fn(),
    };
    let ensuring: Promise<void> | undefined;

    try {
      privateBroker.activeEntrypoint = entrypoint;
      privateBroker.currentServices = services;
      privateBroker.runner = staleRunner;
      privateBroker.runnerInputQueue = { write: async () => {} };
      privateBroker.runnerReady = runnerReady;
      ensuring = privateBroker.ensureRunner();

      const resetError = new Error('reset while runner is becoming ready');
      const recovery = services.cache.startSupersedeStormRecovery(
        resetError,
        entry,
        services.cacheEpoch
      );
      expect(recovery.started).toBe(true);
      recovery.complete();
      expect(staleRunner.kill).toHaveBeenCalledTimes(1);

      releaseReady();
      await ensuring;
      expect(privateBroker.runner).not.toBeNull();
      expect(privateBroker.runner).not.toBe(staleRunner);
      expect(privateBroker.runnerInputQueue).not.toBeNull();
    } finally {
      releaseReady();
      await ensuring?.catch(() => undefined);
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not deliver stale load results to a restarted runner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const virtualTheme = join(root, 'virtual-theme.js');
    const source = [
      "import { value } from 'theme';",
      'export const __wywPreval = {',
      '  value: () => value,',
      '};',
    ].join('\n');
    writeFileSync(entry, source);

    const deferred = () => {
      let resolvePromise!: () => void;
      const promise = new Promise<void>((complete) => {
        resolvePromise = complete;
      });
      return { promise, resolve: resolvePromise };
    };
    const aGate = deferred();
    const bGate = deferred();
    const aStarted = deferred();
    const bStarted = deferred();
    const brokerScope = {};

    const createSession = (
      key: string,
      value: string,
      gate: ReturnType<typeof deferred>,
      started: ReturnType<typeof deferred>
    ) => {
      const services = createServices(root, entry, {
        eval: {
          customLoader: async (id) => {
            if (id !== virtualTheme) return undefined;
            started.resolve();
            await gate.promise;
            return {
              code: `export const value = ${JSON.stringify(value)};`,
            };
          },
        },
      });
      services.evalBrokerScope = brokerScope;
      services.evalCacheKey = key;
      services.asyncResolve = async (what) =>
        what === 'theme' ? virtualTheme : null;
      return services;
    };

    const aServices = createSession('session-a', 'A', aGate, aStarted);
    const bServices = createSession('session-b', 'B', bGate, bStarted);
    const broker = getEvalBroker(
      aServices,
      aServices.asyncResolve!,
      aServices.evalCacheKey!
    );
    let bEval: ReturnType<typeof broker.evaluate> | undefined;

    try {
      const aEntrypoint = Entrypoint.createRoot(
        aServices,
        entry,
        ['__wywPreval'],
        source
      );
      const aEval = broker.evaluate(aEntrypoint, aServices);
      await aStarted.promise;

      const runner = getPrivateBroker(broker).runner as {
        kill: () => boolean;
        once: (event: 'exit', listener: () => void) => void;
      };
      const runnerExited = new Promise<void>((resolveExit) => {
        runner.once('exit', resolveExit);
      });
      runner.kill();
      await runnerExited;
      await expect(aEval).rejects.toThrow(/Eval runner exited/);

      const bEntrypoint = Entrypoint.createRoot(
        bServices,
        entry,
        ['__wywPreval'],
        source
      );
      bEval = broker.evaluate(bEntrypoint, bServices);
      await bStarted.promise;

      aGate.resolve();
      const stillPending = Symbol('still-pending');
      const earlyResult = await Promise.race([
        bEval.then((result) => result.values?.get('value')),
        new Promise<symbol>((resolveTimeout) => {
          setTimeout(() => resolveTimeout(stillPending), 100);
        }),
      ]);
      expect(earlyResult).toBe(stillPending);

      bGate.resolve();
      expect((await bEval).values?.get('value')).toBe('B');
    } finally {
      aGate.resolve();
      bGate.resolve();
      await bEval?.catch(() => undefined);
      disposeEvalBroker(brokerScope);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restarts a semantic session after an eval fails with a load in flight', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const slowModule = join(root, 'slow.js');
    const failingModule = join(root, 'fail.js');
    const source = [
      "import { value as slow } from 'slow';",
      "import { value as recovered } from 'fail';",
      'export const __wywPreval = {',
      '  value: () => slow + recovered,',
      '};',
    ].join('\n');
    writeFileSync(entry, source);

    const deferred = () => {
      let resolvePromise!: () => void;
      const promise = new Promise<void>((complete) => {
        resolvePromise = complete;
      });
      return { promise, resolve: resolvePromise };
    };
    const firstSlowGate = deferred();
    const secondSlowGate = deferred();
    const firstSlowStarted = deferred();
    const secondSlowStarted = deferred();
    let slowCalls = 0;
    let failCalls = 0;

    const services = createServices(root, entry, {
      eval: {
        customLoader: async (id) => {
          if (id === slowModule) {
            slowCalls += 1;
            const call = slowCalls;
            if (call === 1) {
              firstSlowStarted.resolve();
              await firstSlowGate.promise;
            } else {
              secondSlowStarted.resolve();
              await secondSlowGate.promise;
            }
            return { code: `export const value = 'slow-${call}';` };
          }

          if (id === failingModule) {
            failCalls += 1;
            if (failCalls === 1) {
              await firstSlowStarted.promise;
              throw new Error('one-shot load failure');
            }
            return { code: "export const value = '-ok';" };
          }

          return undefined;
        },
      },
    });
    services.evalCacheKey = 'same-semantic-session';
    const asyncResolve = async (what: string) => {
      if (what === 'slow') return slowModule;
      if (what === 'fail') return failingModule;
      return null;
    };
    services.asyncResolve = asyncResolve;
    const broker = new EvalBroker(services, asyncResolve);
    services.evalBroker = broker;
    const createEntrypoint = () =>
      createEntrypointAfterRecovery(services, () =>
        Entrypoint.createRoot(services, entry, ['__wywPreval'], source)
      );
    let retry: ReturnType<typeof broker.evaluate> | undefined;

    try {
      await expect(
        broker.evaluate(createEntrypoint(), services)
      ).rejects.toThrow('one-shot load failure');
      expect(slowCalls).toBe(1);
      expect(failCalls).toBe(1);

      retry = broker.evaluate(createEntrypoint(), services);
      retry.catch(() => undefined);
      const retryStarted = await Promise.race([
        secondSlowStarted.promise.then(() => true),
        new Promise<false>((resolveTimeout) => {
          setTimeout(() => resolveTimeout(false), 500);
        }),
      ]);
      expect(retryStarted).toBe(true);
      expect(slowCalls).toBe(2);

      firstSlowGate.resolve();
      const stillPending = Symbol('still-pending');
      const earlyResult = await Promise.race([
        retry.then((result) => result.values?.get('value')),
        new Promise<symbol>((resolveTimeout) => {
          setTimeout(() => resolveTimeout(stillPending), 100);
        }),
      ]);
      expect(earlyResult).toBe(stillPending);

      secondSlowGate.resolve();
      expect((await retry).values?.get('value')).toBe('slow-2-ok');
      expect(failCalls).toBe(2);
    } finally {
      firstSlowGate.resolve();
      secondSlowGate.resolve();

      const runner = getPrivateBroker(broker).runner as {
        exitCode: number | null;
        kill: () => boolean;
        once: (event: 'exit', listener: () => void) => void;
        signalCode: string | null;
      } | null;
      if (runner && runner.exitCode === null && runner.signalCode === null) {
        const runnerExited = new Promise<void>((resolveExit) => {
          runner.once('exit', resolveExit);
        });
        runner.kill();
        await runnerExited;
      }
      await retry?.catch(() => undefined);
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not carry a delayed dynamic import into the next semantic session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const firstEntry = join(root, 'first.js');
    const secondEntry = join(root, 'second.js');
    const firstSlowModule = join(root, 'first-slow.js');
    const secondSlowModule = join(root, 'second-slow.js');
    const firstSource = [
      'export const __wywPreval = {',
      '  value: () => {',
      "    void import('slow');",
      "    return 'first';",
      '  },',
      '};',
    ].join('\n');
    const secondSource = [
      "import { value } from 'slow';",
      'export const __wywPreval = { value: () => value };',
    ].join('\n');
    writeFileSync(firstEntry, firstSource);
    writeFileSync(secondEntry, secondSource);
    writeFileSync(firstSlowModule, "export const value = 'old';");
    writeFileSync(secondSlowModule, "export const value = 'new';");

    const deferred = () => {
      let resolvePromise!: () => void;
      const promise = new Promise<void>((complete) => {
        resolvePromise = complete;
      });
      return { promise, resolve: resolvePromise };
    };
    const firstGate = deferred();
    const secondGate = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    let firstLoads = 0;
    let secondLoads = 0;

    const firstServices = createServices(root, firstEntry, {
      eval: {
        customLoader: async (id) => {
          if (id !== firstSlowModule) return undefined;
          firstLoads += 1;
          firstStarted.resolve();
          await firstGate.promise;
          return { code: "export const value = 'old';" };
        },
      },
    });
    firstServices.evalCacheKey = 'first-semantics';
    firstServices.asyncResolve = async (what) =>
      what === 'slow' ? firstSlowModule : null;

    const secondServices = createServices(root, secondEntry, {
      eval: {
        customLoader: async (id) => {
          if (id !== secondSlowModule) return undefined;
          secondLoads += 1;
          secondStarted.resolve();
          await secondGate.promise;
          return { code: "export const value = 'new';" };
        },
      },
    });
    secondServices.evalCacheKey = 'second-semantics';
    secondServices.asyncResolve = async (what) =>
      what === 'slow' ? secondSlowModule : null;

    const broker = new EvalBroker(firstServices, firstServices.asyncResolve);

    try {
      const firstEntrypoint = Entrypoint.createRoot(
        firstServices,
        firstEntry,
        ['__wywPreval'],
        firstSource
      );
      expect(
        (await broker.evaluate(firstEntrypoint, firstServices)).values?.get(
          'value'
        )
      ).toBe('first');
      await firstStarted.promise;

      const secondEntrypoint = Entrypoint.createRoot(
        secondServices,
        secondEntry,
        ['__wywPreval'],
        secondSource
      );
      const secondEval = broker.evaluate(secondEntrypoint, secondServices);
      secondEval.catch(() => undefined);
      await secondStarted.promise;

      // The first LOAD finishes only after the second INIT established a new
      // session. Its continuation must stay abandoned instead of populating
      // the new runner caches or satisfying the second import.
      firstGate.resolve();
      const stillPending = Symbol('still-pending');
      expect(
        await Promise.race([
          secondEval.then((result) => result.values?.get('value')),
          new Promise<symbol>((resolveTimeout) => {
            setTimeout(() => resolveTimeout(stillPending), 100);
          }),
        ])
      ).toBe(stillPending);

      secondGate.resolve();
      expect((await secondEval).values?.get('value')).toBe('new');
      expect(firstLoads).toBe(1);
      expect(secondLoads).toBe(1);
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers a post-eval dynamic import resolve delivered in one chunk with EVAL_RESULT', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const slowModule = join(root, 'slow.js');
    const source = [
      'export const __wywPreval = {',
      '  value: () => {',
      "    void import('slow');",
      "    return 'first';",
      '  },',
      '};',
    ].join('\n');
    writeFileSync(entry, source);
    writeFileSync(slowModule, "export const value = 'slow';");

    let loads = 0;
    let loadStarted!: () => void;
    const loadStartedPromise = new Promise<void>((complete) => {
      loadStarted = complete;
    });
    const services = createServices(root, entry, {
      eval: {
        customLoader: async (id) => {
          if (id !== slowModule) return undefined;
          loads += 1;
          loadStarted();
          return { code: "export const value = 'slow';" };
        },
      },
    });
    services.evalCacheKey = 'coalesced-semantics';
    services.asyncResolve = async (what) =>
      what === 'slow' ? slowModule : null;

    const broker = new EvalBroker(services, services.asyncResolve);
    const privateBroker = broker as unknown as {
      onData: (runner: unknown, chunk: string) => void;
    };

    // Deliver runner stdout in coalesced chunks so the RESOLVE issued by the
    // fire-and-forget import is processed in the same synchronous batch as
    // EVAL_RESULT. This is what a busy CI host produces naturally.
    const originalOnData = privateBroker.onData;
    let coalesced = '';
    let coalescedRunner: unknown;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    privateBroker.onData = (runner, chunk) => {
      coalesced += chunk;
      coalescedRunner = runner;
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const buffered = coalesced;
        coalesced = '';
        originalOnData.call(broker, coalescedRunner, buffered);
      }, 5);
    };

    try {
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        source
      );
      expect(
        (await broker.evaluate(entrypoint, services)).values?.get('value')
      ).toBe('first');

      // The dynamic import continuation belongs to the same semantic session
      // and must still be served after EVAL_RESULT cleared the active
      // entrypoint. Dropping RESOLVE_RESULT would leave the runner awaiting
      // forever and this LOAD would never arrive.
      const loaded = await Promise.race([
        loadStartedPromise.then(() => true),
        new Promise<false>((resolveTimeout) => {
          setTimeout(() => resolveTimeout(false), 1000);
        }),
      ]);
      expect(loaded).toBe(true);
      expect(loads).toBe(1);
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not let a stale same-id load block the next entrypoint session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const firstEntry = join(root, 'first.js');
    const secondEntry = join(root, 'second.js');
    const slowModule = join(root, 'slow.js');
    const firstSource = [
      'export const __wywPreval = {',
      '  value: () => {',
      "    void import('./slow.js');",
      "    return 'first';",
      '  },',
      '};',
    ].join('\n');
    const secondSource = [
      "import { value } from './slow.js';",
      'export const __wywPreval = { value: () => value };',
    ].join('\n');
    writeFileSync(firstEntry, firstSource);
    writeFileSync(secondEntry, secondSource);
    writeFileSync(slowModule, '');

    const deferred = () => {
      let resolvePromise!: () => void;
      const promise = new Promise<void>((complete) => {
        resolvePromise = complete;
      });
      return { promise, resolve: resolvePromise };
    };
    const firstGate = deferred();
    const secondGate = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    let slowLoads = 0;
    const services = createServices(root, firstEntry, {
      eval: {
        customLoader: async (id) => {
          if (id !== slowModule) return undefined;
          slowLoads += 1;
          if (slowLoads === 1) {
            firstStarted.resolve();
            await firstGate.promise;
            return { code: "export const value = 'old';" };
          }

          secondStarted.resolve();
          await secondGate.promise;
          return { code: "export const value = 'new';" };
        },
      },
    });
    services.evalCacheKey = 'same-semantic-session';
    services.asyncResolve = async (what) =>
      what === './slow.js' ? slowModule : null;
    const broker = new EvalBroker(services, services.asyncResolve);
    let secondEval: ReturnType<typeof broker.evaluate> | undefined;

    try {
      const firstEntrypoint = Entrypoint.createRoot(
        services,
        firstEntry,
        ['__wywPreval'],
        firstSource
      );
      expect(
        (await broker.evaluate(firstEntrypoint, services)).values?.get('value')
      ).toBe('first');
      await firstStarted.promise;

      const secondEntrypoint = Entrypoint.createRoot(
        services,
        secondEntry,
        ['__wywPreval'],
        secondSource
      );
      secondEval = broker.evaluate(secondEntrypoint, services);
      secondEval.catch(() => undefined);
      const secondLoadStarted = await Promise.race([
        secondStarted.promise.then(() => true),
        new Promise<false>((resolveTimeout) => {
          setTimeout(() => resolveTimeout(false), 500);
        }),
      ]);
      expect(secondLoadStarted).toBe(true);

      firstGate.resolve();
      const stillPending = Symbol('still-pending');
      expect(
        await Promise.race([
          secondEval.then((result) => result.values?.get('value')),
          new Promise<symbol>((resolveTimeout) => {
            setTimeout(() => resolveTimeout(stillPending), 100);
          }),
        ])
      ).toBe(stillPending);

      secondGate.resolve();
      expect((await secondEval).values?.get('value')).toBe('new');
      expect(slowLoads).toBe(2);
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      await secondEval?.catch(() => undefined);
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers a later batched evaluation after an INIT failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const badEntry = join(root, 'bad.js');
    const goodEntry = join(root, 'good.js');
    const source = 'export const __wywPreval = { value: () => 42 };';
    writeFileSync(badEntry, source);
    writeFileSync(goodEntry, source);

    const badServices = createServices(root, badEntry, {
      eval: {
        globals: {
          BROKEN_FN: {
            __wyw_eval_global: {
              signature: 'wyw-eval-global',
              version: 1,
              kind: 'function',
              source: 'function () {',
            },
          },
        },
      },
    });
    badServices.evalCacheKey = 'bad-init';
    badServices.asyncResolve = async () => null;
    const goodServices = createServices(root, goodEntry);
    goodServices.evalCacheKey = 'good-init';
    goodServices.asyncResolve = async () => null;
    const broker = new EvalBroker(badServices, async () => null);

    try {
      const bad = Entrypoint.createRoot(
        badServices,
        badEntry,
        ['__wywPreval'],
        source
      );
      const good = Entrypoint.createRoot(
        goodServices,
        goodEntry,
        ['__wywPreval'],
        source
      );
      const [badResult, goodResult] = await Promise.allSettled([
        broker.evaluate(bad, badServices),
        broker.evaluate(good, goodServices),
      ]);

      expect(badResult.status).toBe('rejected');
      if (badResult.status === 'rejected') {
        expect(badResult.reason).toEqual(
          expect.objectContaining({
            message: expect.stringContaining(
              'Failed to restore eval.globals function'
            ),
          })
        );
      }
      expect(goodResult.status).toBe('fulfilled');
      if (goodResult.status === 'fulfilled') {
        expect(goodResult.value.values?.get('value')).toBe(42);
      }
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('makes dispose terminal and rejects active and scheduled evaluations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const slowModule = join(root, 'slow.js');
    const source = [
      "import { value } from 'slow';",
      'export const __wywPreval = { value: () => value };',
    ].join('\n');
    writeFileSync(entry, source);
    writeFileSync(slowModule, 'export const value = 42;');

    let releaseSlow!: () => void;
    let markSlowStarted!: () => void;
    const slowGate = new Promise<void>((resolveGate) => {
      releaseSlow = resolveGate;
    });
    const slowStarted = new Promise<void>((resolveStarted) => {
      markSlowStarted = resolveStarted;
    });
    const services = createServices(root, entry, {
      eval: {
        customLoader: async (id) => {
          if (id !== slowModule) return undefined;
          markSlowStarted();
          await slowGate;
          return { code: 'export const value = 42;' };
        },
      },
    });
    services.asyncResolve = async (what) =>
      what === 'slow' ? slowModule : null;
    const broker = new EvalBroker(services, services.asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      source
    );

    try {
      const active = broker.evaluate(entrypoint, services);
      active.catch(() => undefined);
      await slowStarted;
      broker.dispose();
      await expect(active).rejects.toThrow('Eval broker has been disposed');
      await expect(broker.evaluate(entrypoint, services)).rejects.toThrow(
        'Eval broker has been disposed'
      );
      expect(getPrivateBroker(broker).runner).toBeNull();

      const scheduledBroker = new EvalBroker(services, services.asyncResolve);
      const scheduled = scheduledBroker.evaluate(entrypoint, services);
      scheduled.catch(() => undefined);
      scheduledBroker.dispose();
      await expect(scheduled).rejects.toThrow('Eval broker has been disposed');
      await new Promise<void>((resolveImmediate) => {
        setImmediate(resolveImmediate);
      });
      expect(getPrivateBroker(scheduledBroker).runner).toBeNull();
    } finally {
      releaseSlow();
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not activate an isolated runner after terminal disposal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const source = 'export const __wywPreval = { value: () => 42 };';
    writeFileSync(entry, source);
    const services = createServices(root, entry, {
      features: { happyDOM: true },
    });
    const broker = new EvalBroker(services, async () => null);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      source
    );
    const oldRunner = {
      kill: jest.fn(() => true),
      removeAllListeners: jest.fn(),
    };
    const candidateRunner = {
      kill: jest.fn(() => true),
    };
    let resolveCandidate!: (runner: unknown) => void;
    const candidate = new Promise<unknown>((resolveRunner) => {
      resolveCandidate = resolveRunner;
    });
    const privateBroker = broker as unknown as {
      happyDomDisabled: boolean;
      initIsolatedRunner: jest.Mock<Promise<unknown>, [unknown, number]>;
      initRunner: (value: Entrypoint) => Promise<void>;
      lastHappyDomEnabled: boolean;
      lastInitKey: string | null;
      replaceRunner: jest.Mock;
      runner: unknown;
    };
    privateBroker.runner = oldRunner;
    privateBroker.lastInitKey = 'previous-init';
    privateBroker.lastHappyDomEnabled = false;
    privateBroker.happyDomDisabled = false;
    privateBroker.initIsolatedRunner = jest.fn(() => candidate);
    privateBroker.replaceRunner = jest.fn();

    try {
      const initializing = privateBroker.initRunner(entrypoint);
      initializing.catch(() => undefined);
      await Promise.resolve();
      expect(privateBroker.initIsolatedRunner).toHaveBeenCalledTimes(1);

      broker.dispose();
      resolveCandidate(candidateRunner);

      await expect(initializing).rejects.toThrow(
        'Eval broker has been disposed'
      );
      expect(candidateRunner.kill).toHaveBeenCalledTimes(1);
      expect(privateBroker.replaceRunner).not.toHaveBeenCalled();
      expect(privateBroker.runner).toBeNull();
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recreates a registry broker after direct terminal disposal', () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    writeFileSync(entry, 'export const __wywPreval = {};');
    const services = createServices(root, entry);
    const scope = {};
    services.evalBrokerScope = scope;
    const resolver = async () => null;

    try {
      const first = getEvalBroker(services, resolver, 'stable-key');
      first.dispose();
      const second = getEvalBroker(services, resolver, 'stable-key');

      expect(second).not.toBe(first);
      expect(second.isDisposed).toBe(false);
    } finally {
      disposeEvalBroker(scope);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('broadcasts one recovery to every scoped broker serving the cache', () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entryA = join(root, 'a.js');
    const entryB = join(root, 'b.js');
    const recoveryFile = join(root, 'recovery.js');
    const source = 'export const __wywPreval = {};';
    writeFileSync(recoveryFile, source);
    const cache = new TransformCacheCollection();
    const scopeA = {};
    const scopeB = {};
    const servicesA = createServices(root, entryA);
    const servicesB = createServices(root, entryB);
    servicesA.cache = cache;
    servicesA.cacheEpoch = cache.getCurrentEpoch();
    servicesA.evalBrokerScope = scopeA;
    servicesB.cache = cache;
    servicesB.cacheEpoch = cache.getCurrentEpoch();
    servicesB.evalBrokerScope = scopeB;
    const resolver = async () => null;
    const brokerA = getEvalBroker(servicesA, resolver, 'stable-key');
    const brokerB = getEvalBroker(servicesB, resolver, 'stable-key');
    servicesA.evalBroker = brokerA;
    servicesB.evalBroker = brokerB;
    const resetA = jest.spyOn(brokerA, 'resetAfterCacheInvalidation');
    const resetB = jest.spyOn(brokerB, 'resetAfterCacheInvalidation');
    const freshness = jest
      .spyOn(cache, 'invalidateIfChangedWithDetails')
      .mockReturnValueOnce({
        changed: false,
        unknownDependencyGraphs: new Set([join(root, 'missing.js')]),
      });
    let abortError: unknown;

    try {
      Entrypoint.createRoot(servicesA, recoveryFile, ['__wywPreval'], source);
    } catch (error) {
      abortError = error;
    }

    try {
      expect(abortError).toMatchObject({
        code: 'WYW_CACHE_EPOCH_ABORTED',
        reason: 'unknown-dependency-graph',
      });
      expect(resetA).toHaveBeenCalledTimes(1);
      expect(resetB).toHaveBeenCalledTimes(1);
      expect(resetA).toHaveBeenCalledWith(
        cache.getCurrentEpoch().owner,
        abortError,
        'unknown-dependency-graph'
      );
      expect(resetB).toHaveBeenCalledWith(
        cache.getCurrentEpoch().owner,
        abortError,
        'unknown-dependency-graph'
      );
    } finally {
      freshness.mockRestore();
      disposeEvalBroker(scopeA);
      disposeEvalBroker(scopeB);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('collects dependency edges from ignored modules shipped verbatim', () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const barrel = join(root, 'barrel.js');
    writeFileSync(
      barrel,
      [
        "import { localValue } from './values.js';",
        "export { reexportedValue } from './values.js';",
        "export * from './wildcard.js';",
      ].join('\n')
    );
    const services = createServices(root, barrel, {
      rules: [{ test: () => true, action: 'ignore' }],
    });

    try {
      const result = prepareModuleOnDemand(services, barrel, ['*']);

      expect(Array.from(result.imports ?? [])).toEqual([
        ['./values.js', ['localValue', 'reexportedValue']],
        ['./wildcard.js', ['*']],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers custom resolver over bundler resolver', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    writeFileSync(dep, 'export const value = 1;');

    const customResolver = jest.fn(async () => ({ id: dep }));
    const asyncResolve = jest.fn(async () => dep);
    const services = createServices(root, importer, {
      eval: { customResolver },
    });

    const broker = new EvalBroker(services, asyncResolve);
    const privateBroker = getPrivateBroker(broker);
    privateBroker.importsByModule.set(importer, new Map([['./dep.js', ['*']]]));

    const result = await privateBroker.resolveImport({
      specifier: './dep.js',
      importerId: importer,
      kind: 'import',
    });

    expect(customResolver).toHaveBeenCalledTimes(1);
    expect(asyncResolve).not.toHaveBeenCalled();
    expect(result.resolvedId).toBe(dep);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('prefers native resolver over bundler resolver in hybrid mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const bundlerDep = join(root, 'bundler.js');
    const nativeDep = join(root, 'node_modules', 'dep', 'index.js');

    mkdirSync(dirname(nativeDep), { recursive: true });
    writeFileSync(importer, 'export const value = true;');
    writeFileSync(bundlerDep, 'export const value = "bundler";');
    writeFileSync(nativeDep, 'export const value = "native";');

    const asyncResolve = jest.fn(async () => bundlerDep);
    const services = createServices(root, importer, {
      eval: {
        resolver: 'hybrid',
      },
    });

    const broker = new EvalBroker(services, asyncResolve);
    const privateBroker = getPrivateBroker(broker);
    privateBroker.importsByModule.set(importer, new Map([['dep', ['*']]]));

    const result = await privateBroker.resolveImport({
      specifier: 'dep',
      importerId: importer,
      kind: 'import',
    });

    expect(realpathSync(result.resolvedId!)).toBe(realpathSync(nativeDep));
    expect(asyncResolve).not.toHaveBeenCalled();

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('logs native resolver misses in hybrid mode when eval resolve debug is enabled', async () => {
    const previousDebug = process.env.WYW_DEBUG_EVAL_RESOLVE;
    process.env.WYW_DEBUG_EVAL_RESOLVE = '1';

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const bundlerDep = join(root, 'bundler.js');

    try {
      writeFileSync(importer, 'export const value = true;');
      writeFileSync(bundlerDep, 'export const value = "bundler";');

      const asyncResolve = jest.fn(async () => bundlerDep);
      const services = createServices(root, importer, {
        eval: {
          resolver: 'hybrid',
        },
      });

      const broker = new EvalBroker(services, asyncResolve);
      const privateBroker = getPrivateBroker(broker);
      privateBroker.importsByModule.set(
        importer,
        new Map([['virtual:dep', ['*']]])
      );

      const result = await privateBroker.resolveImport({
        specifier: 'virtual:dep',
        importerId: importer,
        kind: 'import',
      });

      expect(result.resolvedId).toBe(bundlerDep);
      expect(warn).toHaveBeenCalledWith(
        '[wyw-eval:resolve:native-miss]',
        expect.objectContaining({
          specifier: 'virtual:dep',
          importerId: importer,
        })
      );

      broker.dispose();
    } finally {
      warn.mockRestore();
      if (previousDebug === undefined) {
        delete process.env.WYW_DEBUG_EVAL_RESOLVE;
      } else {
        process.env.WYW_DEBUG_EVAL_RESOLVE = previousDebug;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps active eval services while later evals wait in queue', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const firstEntry = join(root, 'first.js');
    const secondEntry = join(root, 'second.js');
    writeFileSync(firstEntry, 'export const __wywPreval = {};');
    writeFileSync(secondEntry, 'export const __wywPreval = {};');

    const firstWarnings: string[] = [];
    const secondWarnings: string[] = [];
    const firstServices = createServices(root, firstEntry, {
      evalConsole: 'warning',
    });
    const secondServices = createServices(root, secondEntry, {
      evalConsole: 'warning',
    });
    firstServices.emitWarning = (message) => firstWarnings.push(message);
    secondServices.emitWarning = (message) => secondWarnings.push(message);

    const broker = new EvalBroker(
      firstServices,
      jest.fn(async () => null)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.ensureRunner = jest.fn(async () => {});
    privateBroker.initRunner = jest.fn(async () => {});

    let resolveFirstEval: ((payload: { values: null }) => void) | null = null;
    let firstEvalStarted: (() => void) | null = null;
    const firstEvalStartedPromise = new Promise<void>((resolveStarted) => {
      firstEvalStarted = resolveStarted;
    });
    privateBroker.request = jest.fn((_type, payload) => {
      const { id } = payload as { id: string };
      if (id === firstEntry) {
        firstEvalStarted?.();
        return new Promise<{ values: null }>((resolveEval) => {
          resolveFirstEval = resolveEval;
        });
      }

      return Promise.resolve({ values: null });
    });

    const firstEntrypoint = Entrypoint.createRoot(
      firstServices,
      firstEntry,
      ['__wywPreval'],
      readFileSync(firstEntry, 'utf-8')
    );
    const secondEntrypoint = Entrypoint.createRoot(
      secondServices,
      secondEntry,
      ['__wywPreval'],
      readFileSync(secondEntry, 'utf-8')
    );

    const firstEval = broker.evaluate(firstEntrypoint, firstServices);
    await firstEvalStartedPromise;
    const secondEval = broker.evaluate(secondEntrypoint, secondServices);

    privateBroker.handleRunnerStderr(Buffer.from('active warning\n'));

    expect(firstWarnings).toEqual(['active warning']);
    expect(secondWarnings).toEqual([]);

    resolveFirstEval?.({ values: null });
    await firstEval;
    await secondEval;

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('loadModule merges importer-specific needs even when onlyByModule is narrow', async () => {
    // Simulates the intra-session race: onlyByModule has only one importer's
    // contribution, but the LOAD payload identifies a different importer whose
    // importsByModule map reveals additional needed exports. The fix in
    // loadModuleImpl merges these into requiredOnly so the prepared code
    // includes all exports the importer actually needs.
    //
    // The barrel must NOT be statically evaluatable (the broker overrides
    // simple modules to only:['*']). Using re-exports from sub-modules
    // makes it non-trivial, matching the real design-system barrel pattern.

    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const barrel = join(root, 'barrel.js');
    const typography = join(root, 'typography.js');
    const layout = join(root, 'layout.js');
    const consumerA = join(root, 'consumer-a.js');
    const consumerB = join(root, 'consumer-b.js');

    // Sub-modules with non-trivial logic to avoid static evaluation
    writeFileSync(
      typography,
      [
        'const base = 16;',
        'export const fontWeight = base * 25;',
        'export const lineHeight = base * 1.5;',
      ].join('\n')
    );
    writeFileSync(
      layout,
      [
        'const unit = 8;',
        'export const iconSize = unit * 3;',
        'export const spacing = unit * 2;',
      ].join('\n')
    );
    // Barrel re-exports from sub-modules (not statically evaluatable)
    writeFileSync(
      barrel,
      [
        "export { fontWeight, lineHeight } from './typography.js';",
        "export { iconSize, spacing } from './layout.js';",
      ].join('\n')
    );
    writeFileSync(
      consumerA,
      [
        "import { fontWeight } from './barrel.js';",
        'export const a = fontWeight;',
      ].join('\n')
    );
    writeFileSync(
      consumerB,
      [
        "import { iconSize } from './barrel.js';",
        'export const b = iconSize;',
      ].join('\n')
    );

    const services = createServices(root, consumerA);
    const asyncResolve = jest.fn(async () => null);
    const broker = new EvalBroker(services, asyncResolve);
    const privateBroker = getPrivateBroker(broker);

    // Simulate: onlyByModule for barrel was set by consumer-a's RESOLVE only
    privateBroker.onlyByModule.set(barrel, ['fontWeight']);

    // Simulate: importsByModule for consumer-b shows it imports iconSize
    privateBroker.importsByModule.set(
      consumerB,
      new Map([['./barrel.js', ['iconSize']]])
    );

    // LOAD from consumer-b's context. Without the fix, requiredOnly would be
    // ["fontWeight"] (from onlyByModule), missing iconSize. With the fix,
    // it merges consumer-b's needs: ["fontWeight", "iconSize"].
    const loaded = await privateBroker.loadModule({
      id: barrel,
      importerId: consumerB,
      request: './barrel.js',
    });

    expect(loaded.only).toEqual(
      expect.arrayContaining(['fontWeight', 'iconSize'])
    );
    // The prepared code must re-export iconSize from the layout sub-module
    expect(loaded.code).toContain('iconSize');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not widen `only` with cached cross-session entrypoints', async () => {
    // Cross-session widening regression: a previously-cached entrypoint
    // (consumer-a, evaluated in a prior transform) recorded
    // `barrel: only=['fontWeight']`. A new session for consumer-b imports
    // only `iconSize` from the same barrel. The barrel's load `only`
    // must not pull in `fontWeight` just because consumer-a's cached
    // entrypoint exists — consumer-a isn't part of this session's link
    // graph, so its imports don't constrain the load.

    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const barrel = join(root, 'barrel.js');
    const typography = join(root, 'typography.js');
    const layout = join(root, 'layout.js');
    const consumerA = join(root, 'consumer-a.js');
    const consumerB = join(root, 'consumer-b.js');

    writeFileSync(
      typography,
      ['const base = 16;', 'export const fontWeight = base * 25;'].join('\n')
    );
    writeFileSync(
      layout,
      ['const unit = 8;', 'export const iconSize = unit * 3;'].join('\n')
    );
    writeFileSync(
      barrel,
      [
        "export { fontWeight } from './typography.js';",
        "export { iconSize } from './layout.js';",
      ].join('\n')
    );
    writeFileSync(
      consumerA,
      [
        "import { fontWeight } from './barrel.js';",
        'export const a = fontWeight;',
      ].join('\n')
    );
    writeFileSync(
      consumerB,
      [
        "import { iconSize } from './barrel.js';",
        'export const b = iconSize;',
      ].join('\n')
    );

    const services = createServices(root, consumerB);

    // Simulate a cached prior-session entrypoint for consumer-a that
    // recorded barrel: only=['fontWeight']. With the cross-session
    // widening, this would bleed into consumer-b's load.
    const cachedConsumerA = Entrypoint.createRoot(
      services,
      consumerA,
      ['*'],
      readFileSync(consumerA, 'utf-8')
    );
    cachedConsumerA.addDependency({
      only: ['fontWeight'],
      resolved: barrel,
      source: './barrel.js',
    });
    services.cache.add('entrypoints', consumerA, cachedConsumerA);

    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = getPrivateBroker(broker);

    // Consumer-b's session: importsByModule reflects what consumer-b
    // actually imports.
    privateBroker.importsByModule.set(
      consumerB,
      new Map([['./barrel.js', ['iconSize']]])
    );
    // Simulate what runOneEntrypoint → resetPerEntrypointState would do
    // when consumer-b's session starts: seed the link graph with the
    // entrypoint. Consumer-a is NOT in the graph (it's a stale cached
    // entrypoint from a prior session) so its imports must not bleed in.
    privateBroker.sessionLinkGraph.add(consumerB);

    const loaded = await privateBroker.loadModule({
      id: barrel,
      importerId: consumerB,
      request: './barrel.js',
    });

    expect(loaded.only).toEqual(expect.arrayContaining(['iconSize']));
    expect(loaded.only).not.toContain('fontWeight');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not silently drop exports a barrel needs via a wildcard re-export edge', async () => {
    // The eval path used to build its import map from
    // collectOxcExportsAndImports(...).imports only, dropping .reexports
    // entirely — even though the shaker's separate mapper included them. A
    // module shipped with `export * from './values.js'` keeps a real ESM
    // dependency edge on values.js that never appeared in the broker's
    // import map for the barrel.
    //
    // Consequence: once some other importer has caused values.js to be
    // cached under a narrow `only` within this session,
    // mergeKnownDependencyOnly's per-module cache means a LOAD for
    // values.js reached *through the barrel* reuses that same stale narrow
    // `only` — because the barrel's own importsByModule entry for
    // './values.js' doesn't exist to widen it — silently omitting exports
    // the barrel's wildcard re-export needs. A consumer that reaches those
    // exports only through the barrel gets an incomplete module.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const values = join(root, 'values.js');
    const barrel = join(root, 'barrel.js');
    const consumerNarrow = join(root, 'consumer-narrow.js');

    // Non-trivial computed exports, matching the barrel-pattern fixtures
    // above — trivial re-exports get shipped in full regardless of `only`,
    // which would mask this defect.
    writeFileSync(
      values,
      [
        'const base = 16;',
        'export const namedValue = base * 25;',
        'export const otherValue = base * 3;',
      ].join('\n')
    );
    writeFileSync(
      barrel,
      ["export * from './values.js';", 'export const marker = 1;'].join('\n')
    );

    const services = createServices(root, consumerNarrow);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = broker as unknown as {
      importsByModule: Map<string, Map<string, string[]>>;
      onlyByModule: Map<string, string[]>;
      sessionLinkGraph: Set<string>;
      loadModule: (payload: {
        id: string;
        importerId?: string | null;
        request?: string | null;
      }) => Promise<{ code: string; only: string[]; hash?: string }>;
    };

    // consumer-narrow already resolved+loaded values.js narrowly, within
    // this session, before the barrel ever needs it.
    privateBroker.sessionLinkGraph.add(consumerNarrow);
    privateBroker.importsByModule.set(
      consumerNarrow,
      new Map([['./values.js', ['namedValue']]])
    );
    privateBroker.onlyByModule.set(values, ['namedValue']);
    await privateBroker.loadModule({
      id: values,
      importerId: consumerNarrow,
      request: './values.js',
    });

    // Now load the barrel itself — through the real preparation path, not
    // hand-seeded — so its importsByModule entry reflects whatever
    // collectOxcImportMap actually returns for
    // `export * from "./values.js"`. This is the exact mechanism that's
    // broken: the barrel's own compiled code keeps the statement verbatim
    // (a wildcard target can't be selectively pruned), but the import map
    // built for it must include the edge for the merge below to widen
    // values.js's stale narrow `only`.
    privateBroker.sessionLinkGraph.add(barrel);
    await privateBroker.loadModule({
      id: barrel,
      importerId: consumerNarrow,
      request: './barrel.js',
    });

    const wideLoad = await privateBroker.loadModule({
      id: values,
      importerId: barrel,
      request: './values.js',
    });

    expect(wideLoad.code).toContain('otherValue');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('links a real module graph that needs a barrel-reexported export outside a narrower named import', async () => {
    // End-to-end version of the test above: drives a real broker.evaluate()
    // through the real child-process runner (no hand-seeded broker state),
    // and shows the missing re-export edge can produce an actual
    // vm.SourceTextModule.link failure, not just a stale internal `only`.
    //
    // For the missing edge to crash rather than just over-fetch, the
    // barrel's importsByModule entry for './values.js' must exist but be
    // missing the needed name — total absence of an entry falls back to
    // requesting everything (getImportOnly's `?? ['*']`), which fails safe.
    // So the barrel below carries *both* a narrow named import (which
    // creates the entry) and a wildcard re-export (which the entry then
    // fails to widen for, pre-fix):
    //
    //   import { namedValue } from './values.js';
    //   export * from './values.js';
    //   export const derived = namedValue * 2;
    //
    // Pre-fix, the eval import map for barrel.js is
    // {'./values.js': ['namedValue']} — the reexport is dropped — so
    // values.js gets prepared with only `namedValue`, `otherValue` is
    // shaken out, and the barrel's `export *` can no longer supply it to
    // entry.js. entry.js's link then throws "does not provide an export
    // named 'otherValue'". Post-fix the map entry is
    // ['namedValue', '*'], values.js is prepared wide, and the graph links.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const values = join(root, 'values.js');
    const barrel = join(root, 'barrel.js');
    const entry = join(root, 'entry.js');

    // Computed (not literal) exports keep values.js out of
    // isStaticallyEvaluatableModule — an Identifier operand (`base`) makes
    // it unsafe — otherwise the broker force-widens it to only:['*'] and
    // the defect is masked regardless of the import map.
    writeFileSync(
      values,
      [
        'const base = 16;',
        'export const namedValue = base * 25;',
        'export const otherValue = base * 3;',
      ].join('\n')
    );
    writeFileSync(
      barrel,
      [
        "import { namedValue } from './values.js';",
        "export * from './values.js';",
        'export const derived = namedValue * 2;',
      ].join('\n')
    );
    writeFileSync(
      entry,
      [
        "import { derived, otherValue } from './barrel.js';",
        'export const __wywPreval = {',
        '  total: () => derived + otherValue,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entry);
    const broker = new EvalBroker(services, asyncResolve);

    try {
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      const result = await broker.evaluate(entrypoint);

      // derived = (16 * 25) * 2 = 800, otherValue = 16 * 3 = 48
      expect(result.values?.get('total')).toBe(848);
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dedupes in-flight resolve calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    writeFileSync(dep, 'export const value = 1;');

    let resolvePromise: ((value: string | null) => void) | null = null;
    const asyncResolve = jest.fn(
      () =>
        new Promise<string | null>((resolveFn) => {
          resolvePromise = resolveFn;
        })
    );
    const services = createServices(root, importer);
    const broker = new EvalBroker(services, asyncResolve);
    const privateBroker = getPrivateBroker(broker);
    privateBroker.importsByModule.set(importer, new Map([['./dep.js', ['*']]]));

    const first = privateBroker.resolveImport({
      specifier: './dep.js',
      importerId: importer,
      kind: 'import',
    });
    const second = privateBroker.resolveImport({
      specifier: './dep.js',
      importerId: importer,
      kind: 'import',
    });

    expect(asyncResolve).toHaveBeenCalledTimes(1);
    resolvePromise?.(dep);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.resolvedId).toBe(dep);
    expect(secondResult.resolvedId).toBe(dep);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('passes active entrypoint as async resolver stack root for transitive imports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const importer = join(root, 'dep.js');
    const nested = join(root, 'nested.js');
    writeFileSync(importer, 'export const value = 1;');
    writeFileSync(nested, 'export const value = 2;');

    const asyncResolve = jest.fn(async () => nested);
    const services = createServices(root, entry);
    const broker = new EvalBroker(services, asyncResolve);
    const privateBroker = getPrivateBroker(broker);
    privateBroker.activeResolveRootId = entry;
    privateBroker.importsByModule.set(
      importer,
      new Map([['./nested.js', ['*']]])
    );

    const result = await privateBroker.resolveImport({
      specifier: './nested.js',
      importerId: importer,
      kind: 'import',
    });

    expect(result.resolvedId).toBe(nested);
    expect(asyncResolve).toHaveBeenCalledWith('./nested.js', importer, [
      importer,
      entry,
    ]);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('passes conditionNames to native fallback resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const pkgDir = join(root, 'node_modules', '@test', 'helpers');
    const sourceDep = join(pkgDir, 'src', 'utils.js');
    const defaultDep = join(pkgDir, 'lib', 'src', 'utils.js');

    mkdirSync(dirname(sourceDep), { recursive: true });
    mkdirSync(dirname(defaultDep), { recursive: true });
    writeFileSync(importer, 'module.exports = 1;');
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify(
        {
          name: '@test/helpers',
          exports: {
            './src/*': {
              '@test/source': './src/*.js',
              default: './lib/src/*.js',
            },
          },
        },
        null,
        2
      )
    );
    writeFileSync(sourceDep, 'module.exports = { value: "source" };');
    writeFileSync(defaultDep, 'module.exports = { value: "default" };');

    const services = createServices(root, importer, {
      conditionNames: ['@test/source', '...'],
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.importsByModule.set(
      importer,
      new Map([['@test/helpers/src/utils', ['*']]])
    );

    const result = await privateBroker.resolveImport({
      specifier: '@test/helpers/src/utils',
      importerId: importer,
      kind: 'require',
    });

    expect(realpathSync(result.resolvedId)).toBe(realpathSync(sourceDep));

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('dedupes in-flight load calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');

    let loaderResolve:
      | ((value: { code: string; loader?: string | null } | null) => void)
      | null = null;
    const customLoader = jest.fn(
      () =>
        new Promise<{ code: string } | null>((resolveFn) => {
          loaderResolve = resolveFn;
        })
    );
    const services = createServices(root, importer, {
      eval: { customLoader },
    });

    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.onlyByModule.set(dep, ['*']);

    const first = privateBroker.loadModule({
      id: dep,
      importerId: importer,
      request: null,
    });
    const second = privateBroker.loadModule({
      id: dep,
      importerId: importer,
      request: null,
    });

    expect(customLoader).toHaveBeenCalledTimes(1);
    loaderResolve?.({ code: 'export const value = 1;' });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.code).toContain('export const value = 1;');
    expect(secondResult.code).toContain('export const value = 1;');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects a custom-loader result after its cache publication is replaced', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    const source = 'export const value = 1; export const extra = 2;';
    writeFileSync(importer, 'export {};');
    writeFileSync(dep, source);

    let releaseLoader!: () => void;
    let signalLoaderStarted!: () => void;
    const loaderGate = new Promise<void>((resolveGate) => {
      releaseLoader = resolveGate;
    });
    const loaderStarted = new Promise<void>((resolveStarted) => {
      signalLoaderStarted = resolveStarted;
    });
    const customLoader = jest.fn(async () => {
      signalLoaderStarted();
      await loaderGate;
      return { code: source };
    });
    const services = createServices(root, importer, {
      eval: { customLoader },
    });
    const initial = Entrypoint.createRoot(services, dep, ['value'], source);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.onlyByModule.set(dep, ['value']);

    const loading = privateBroker.loadModule({
      id: dep,
      importerId: importer,
      request: './dep.js',
    });
    await loaderStarted;
    const replacement = Entrypoint.createRoot(
      services,
      dep,
      ['value', 'extra'],
      source
    );
    expect(replacement).not.toBe(initial);
    releaseLoader();

    await expect(loading).rejects.toBeInstanceOf(AbortError);
    expect(services.cache.get('entrypoints', dep)).toBe(replacement);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects prepared code replaced by a transform finish observer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    const source = 'export const value = 1; export const extra = 2;';
    writeFileSync(importer, 'export {};');
    writeFileSync(dep, source);

    const services = createServices(root, importer, {
      rules: [{ action: oxcShaker, test: () => true }],
    });
    const initial = Entrypoint.createRoot(services, dep, ['value'], source);
    let replacement: Entrypoint | undefined;
    services.eventEmitter = new EventEmitter(
      (labels, type) => {
        if (
          !replacement &&
          type === 'finish' &&
          labels.method === 'transform:evaluator'
        ) {
          replacement = Entrypoint.createRoot(
            services,
            dep,
            ['value', 'extra'],
            source
          );
        }
      },
      createActionIdHandler(),
      () => {}
    );
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.activeEntrypoint = initial;
    privateBroker.onlyByModule.set(dep, ['value']);

    await expect(
      privateBroker.loadModule({
        id: dep,
        importerId: importer,
        request: './dep.js',
      })
    ).rejects.toBeInstanceOf(AbortError);
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(initial);
    expect(services.cache.get('entrypoints', dep)).toBe(replacement);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('retires a blocked LOAD without sending or clearing replacement-runner state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    const entryCode = 'export const __wywPreval = {};';
    writeFileSync(importer, entryCode);
    writeFileSync(dep, 'export const value = 0;');

    let releaseOld!: () => void;
    let releaseFresh!: () => void;
    const oldGate = new Promise<void>((resolveGate) => {
      releaseOld = resolveGate;
    });
    const freshGate = new Promise<void>((resolveGate) => {
      releaseFresh = resolveGate;
    });
    let loadAttempt = 0;
    const customLoader = jest.fn(async () => {
      loadAttempt += 1;
      if (loadAttempt === 1) {
        await oldGate;
        return { code: 'export const value = "stale";' };
      }
      await freshGate;
      return { code: 'export const value = "fresh";' };
    });
    const services = createServices(root, importer, {
      eval: { customLoader },
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);
    const oldEntrypoint = Entrypoint.createRoot(
      services,
      importer,
      ['__wywPreval'],
      entryCode
    );
    const oldWrites: string[] = [];
    const freshWrites: string[] = [];
    const oldRunner = {
      kill: jest.fn(),
      removeAllListeners: jest.fn(),
    };
    const freshRunner = {
      kill: jest.fn(),
      removeAllListeners: jest.fn(),
    };

    privateBroker.activeEntrypoint = oldEntrypoint;
    privateBroker.activeRunnerSessionId = 1;
    privateBroker.runner = oldRunner;
    privateBroker.runnerInputQueue = {
      write: async (payload) => {
        oldWrites.push(payload);
      },
    };
    privateBroker.handleMessage(
      {
        id: 'load-1',
        payload: { id: dep, importerId: importer, request: './dep.js' },
        sessionId: 1,
        type: 'LOAD',
      },
      oldRunner
    );
    await Promise.resolve();
    expect(customLoader).toHaveBeenCalledTimes(1);

    const recovery = services.cache.startUnknownGraphRecovery(
      importer,
      new Set([dep]),
      entryCode,
      oldEntrypoint.graphTraversalToken
    );
    recovery.complete();
    expect(oldRunner.kill).toHaveBeenCalledTimes(1);

    services.cacheEpoch = services.cache.getCurrentEpoch();
    const freshEntrypoint = Entrypoint.createRoot(
      services,
      importer,
      ['__wywPreval'],
      entryCode
    );
    privateBroker.activeEntrypoint = freshEntrypoint;
    privateBroker.activeRunnerSessionId = 2;
    privateBroker.runner = freshRunner;
    privateBroker.runnerInputQueue = {
      write: async (payload) => {
        freshWrites.push(payload);
      },
    };
    privateBroker.handleMessage(
      {
        id: 'load-1',
        payload: { id: dep, importerId: importer, request: './dep.js' },
        sessionId: 2,
        type: 'LOAD',
      },
      freshRunner
    );
    await Promise.resolve();
    expect(customLoader).toHaveBeenCalledTimes(2);

    releaseOld();
    await new Promise<void>((resolveTick) => {
      setImmediate(resolveTick);
    });
    expect(privateBroker.loadInFlight.has(dep)).toBe(true);
    expect(oldWrites).toHaveLength(0);
    expect(freshWrites).toHaveLength(0);

    releaseFresh();
    await new Promise<void>((resolveTick) => {
      setImmediate(resolveTick);
    });
    expect(oldWrites).toHaveLength(0);
    expect(freshWrites).toHaveLength(1);
    expect(JSON.parse(freshWrites[0]).payload.code).toContain('fresh');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('reuses load cache for sequential loads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');

    const customLoader = jest.fn(async () => ({
      code: 'export const value = 1;',
    }));
    const services = createServices(root, importer, {
      eval: { customLoader },
    });

    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.onlyByModule.set(dep, ['*']);

    await privateBroker.loadModule({
      id: dep,
      importerId: importer,
      request: null,
    });
    await privateBroker.loadModule({
      id: dep,
      importerId: importer,
      request: null,
    });

    expect(customLoader).toHaveBeenCalledTimes(1);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('reships same-hash code only after explicit invalidation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    const customLoader = jest.fn(async () => ({
      code: 'export const value = 1;',
    }));
    const services = createServices(root, importer, {
      eval: { customLoader },
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);
    const transportBroker = broker as unknown as {
      handleLoad: (
        id: string,
        payload: { id: string; importerId: string; request: string }
      ) => Promise<void>;
      runnerInputQueue: { write: (payload: string) => Promise<void> };
    };
    const messages: Array<{
      payload: { code?: string; resetModule?: true };
    }> = [];
    transportBroker.runnerInputQueue = {
      write: async (payload) => {
        messages.push(JSON.parse(payload));
      },
    };
    privateBroker.onlyByModule.set(dep, ['*']);
    const request = { id: dep, importerId: importer, request: './dep.js' };

    try {
      await transportBroker.handleLoad('initial', request);
      await transportBroker.handleLoad('warm-before', request);
      services.cache.invalidateForFile(dep);
      await transportBroker.handleLoad('invalidated', request);
      await transportBroker.handleLoad('warm-after', request);

      expect(customLoader).toHaveBeenCalledTimes(2);
      expect(messages).toHaveLength(4);
      expect(messages[0].payload).toEqual(
        expect.objectContaining({ code: 'export const value = 1;' })
      );
      expect(messages[0].payload).not.toHaveProperty('resetModule');
      expect(messages[1].payload).not.toHaveProperty('code');
      expect(messages[1].payload).not.toHaveProperty('resetModule');
      expect(messages[2].payload).toEqual(
        expect.objectContaining({
          code: 'export const value = 1;',
          resetModule: true,
        })
      );
      expect(messages[3].payload).not.toHaveProperty('code');
      expect(messages[3].payload).not.toHaveProperty('resetModule');
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('forgets pre-invalidation mirror coverage before tracking a reset module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    const broker = new EvalBroker(
      createServices(root, importer),
      jest.fn(async () => dep)
    );
    const transportBroker = broker as unknown as {
      handleLoad: (
        id: string,
        payload: { id: string; importerId: string; request: string }
      ) => Promise<void>;
      loadModule: jest.Mock;
      runnerInputQueue: { write: (payload: string) => Promise<void> };
    };
    const code = 'export const value = 1;';
    const prepared = [
      { code, hash: 'stable-hash', imports: null, only: ['*'] },
      {
        code,
        hash: 'stable-hash',
        imports: null,
        only: ['value'],
        resetModule: true as const,
      },
      { code, hash: 'stable-hash', imports: null, only: ['*'] },
    ];
    const messages: Array<{ payload: { code?: string; resetModule?: true } }> =
      [];
    transportBroker.loadModule = jest.fn(async () => prepared.shift()!);
    transportBroker.runnerInputQueue = {
      write: async (payload) => {
        messages.push(JSON.parse(payload));
      },
    };
    const request = { id: dep, importerId: importer, request: './dep.js' };

    try {
      await transportBroker.handleLoad('initial', request);
      await transportBroker.handleLoad('invalidated', request);
      await transportBroker.handleLoad('widened-after-reset', request);

      expect(messages).toHaveLength(3);
      expect(messages[0].payload.code).toBe(code);
      expect(messages[1].payload).toEqual(
        expect.objectContaining({ code, resetModule: true })
      );
      expect(messages[2].payload.code).toBe(code);
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bypasses stale serialized exports after invalidation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    const customLoader = jest.fn(async () => ({
      code: 'export const value = "fresh";',
    }));
    const services = createServices(root, importer, {
      eval: { customLoader },
    });
    const seedStaleEvaluatedExports = () => {
      services.cache.add('exports', dep, ['value']);
      services.cache.add('entrypoints', dep, {
        evaluated: true,
        evaluatedOnly: ['value'],
        exports: { value: 'stale' },
        ignored: false,
      } as never);
    };
    seedStaleEvaluatedExports();
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.onlyByModule.set(dep, ['value']);
    const request = { id: dep, importerId: null, request: null };

    try {
      const serialized = await privateBroker.loadModule(request);
      expect(serialized.exports).toEqual(
        expect.objectContaining({ value: expect.any(Object) })
      );
      expect(customLoader).not.toHaveBeenCalled();

      services.cache.invalidateForFile(dep);
      seedStaleEvaluatedExports();

      const invalidated = await privateBroker.loadModule(request);
      expect(invalidated.code).toContain('"fresh"');
      expect(invalidated).not.toHaveProperty('exports');
      expect(invalidated.resetModule).toBe(true);
      expect(customLoader).toHaveBeenCalledTimes(1);
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps stale serialized exports blocked while a reset retry is pending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    const customLoader = jest
      .fn<() => Promise<{ code: string }>>()
      .mockRejectedValueOnce(new Error('fresh-load-failed'))
      .mockResolvedValueOnce({ code: 'export const value = "fresh";' });
    const services = createServices(root, importer, {
      eval: { customLoader },
    });
    const seedStaleEvaluatedExports = () => {
      services.cache.add('exports', dep, ['value']);
      services.cache.add('entrypoints', dep, {
        evaluated: true,
        evaluatedOnly: ['value'],
        exports: { value: 'stale' },
        ignored: false,
      } as never);
    };
    seedStaleEvaluatedExports();
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.onlyByModule.set(dep, ['value']);
    const request = { id: dep, importerId: null, request: null };

    try {
      const serialized = await privateBroker.loadModule(request);
      expect(serialized).toHaveProperty('exports');
      services.cache.invalidateForFile(dep);
      seedStaleEvaluatedExports();

      await expect(privateBroker.loadModule(request)).rejects.toThrow(
        'fresh-load-failed'
      );
      const retried = await privateBroker.loadModule(request);
      expect(retried.code).toContain('"fresh"');
      expect(retried).not.toHaveProperty('exports');
      expect(customLoader).toHaveBeenCalledTimes(2);
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not reuse an older in-flight preparation after invalidation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    let resolveOld: ((value: { code: string }) => void) | undefined;
    let resolveFresh: ((value: { code: string }) => void) | undefined;
    let signalFreshStarted: (() => void) | undefined;
    const freshStarted = new Promise<void>((resolveFn) => {
      signalFreshStarted = resolveFn;
    });
    const customLoader = jest
      .fn<() => Promise<{ code: string }>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolveFn) => {
            resolveOld = resolveFn;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolveFn) => {
            resolveFresh = resolveFn;
            signalFreshStarted?.();
          })
      );
    const services = createServices(root, importer, {
      eval: { customLoader },
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.onlyByModule.set(dep, ['*']);
    const request = { id: dep, importerId: importer, request: './dep.js' };

    try {
      const oldLoad = privateBroker.loadModule(request);
      services.cache.invalidateForFile(dep);
      const invalidatedLoad = privateBroker.loadModule(request);
      const concurrentFreshLoad = privateBroker.loadModule(request);

      expect(customLoader).toHaveBeenCalledTimes(1);
      resolveOld?.({ code: 'export const value = "old";' });
      await freshStarted;
      expect(customLoader).toHaveBeenCalledTimes(2);

      resolveFresh?.({ code: 'export const value = "fresh";' });

      const [oldResult, invalidatedResult, concurrentResult] =
        await Promise.all([oldLoad, invalidatedLoad, concurrentFreshLoad]);
      expect(oldResult.code).toContain('"old"');
      expect(oldResult).not.toHaveProperty('resetModule');
      expect(invalidatedResult.code).toContain('"fresh"');
      expect(invalidatedResult.resetModule).toBe(true);
      expect(concurrentResult.code).toContain('"fresh"');

      const warm = await privateBroker.loadModule(request);
      expect(warm.code).toContain('"fresh"');
      expect(warm).not.toHaveProperty('resetModule');
      expect(customLoader).toHaveBeenCalledTimes(2);
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('orders repeated invalidations behind the preparation they supersede', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    let resolveOld: ((value: { code: string }) => void) | undefined;
    let resolveFirstFresh: ((value: { code: string }) => void) | undefined;
    let resolveSecondFresh: ((value: { code: string }) => void) | undefined;
    let signalFirstFresh: (() => void) | undefined;
    let signalSecondFresh: (() => void) | undefined;
    const firstFreshStarted = new Promise<void>((resolveStarted) => {
      signalFirstFresh = resolveStarted;
    });
    const secondFreshStarted = new Promise<void>((resolveStarted) => {
      signalSecondFresh = resolveStarted;
    });
    const customLoader = jest
      .fn<() => Promise<{ code: string }>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolveLoad) => {
            resolveOld = resolveLoad;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolveLoad) => {
            resolveFirstFresh = resolveLoad;
            signalFirstFresh?.();
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolveLoad) => {
            resolveSecondFresh = resolveLoad;
            signalSecondFresh?.();
          })
      );
    const services = createServices(root, importer, {
      eval: { customLoader },
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.onlyByModule.set(dep, ['*']);
    const request = { id: dep, importerId: importer, request: './dep.js' };

    try {
      const oldLoad = privateBroker.loadModule(request);
      services.cache.invalidateForFile(dep);
      const firstFreshLoad = privateBroker.loadModule(request);
      resolveOld?.({ code: 'export const value = "old";' });
      await firstFreshStarted;

      services.cache.invalidateForFile(dep);
      const secondFreshLoad = privateBroker.loadModule(request);
      const secondFreshWaiter = privateBroker.loadModule(request);
      resolveFirstFresh?.({ code: 'export const value = "fresh-1";' });
      await secondFreshStarted;
      resolveSecondFresh?.({ code: 'export const value = "fresh-2";' });

      const [old, firstFresh, secondFresh, waiter] = await Promise.all([
        oldLoad,
        firstFreshLoad,
        secondFreshLoad,
        secondFreshWaiter,
      ]);
      expect(old.code).toContain('"old"');
      expect(firstFresh.code).toContain('"fresh-1"');
      expect(firstFresh.resetModule).toBe(true);
      expect(secondFresh.code).toContain('"fresh-2"');
      expect(secondFresh.resetModule).toBe(true);
      expect(waiter.code).toContain('"fresh-2"');
      expect(waiter).not.toHaveProperty('resetModule');
      expect(customLoader).toHaveBeenCalledTimes(3);

      const warm = await privateBroker.loadModule(request);
      expect(warm.code).toContain('"fresh-2"');
      expect(customLoader).toHaveBeenCalledTimes(3);
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries after an older in-flight preparation rejects across invalidation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    let rejectOld: ((error: Error) => void) | undefined;
    const customLoader = jest
      .fn<() => Promise<{ code: string }>>()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectOld = reject;
          })
      )
      .mockResolvedValueOnce({ code: 'export const value = "fresh";' });
    const services = createServices(root, importer, {
      eval: { customLoader },
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.onlyByModule.set(dep, ['*']);
    const request = { id: dep, importerId: importer, request: './dep.js' };

    try {
      const oldLoad = privateBroker.loadModule(request);
      const oldFailure = oldLoad.then(
        () => new Error('old load unexpectedly succeeded'),
        (error: unknown) => error
      );
      services.cache.invalidateForFile(dep);
      const invalidatedLoad = privateBroker.loadModule(request);
      expect(rejectOld).toBeDefined();
      rejectOld?.(new Error('old-load-failed'));

      const oldError = await oldFailure;
      expect(oldError).toBeInstanceOf(Error);
      expect((oldError as Error).message).toBe('old-load-failed');
      const fresh = await invalidatedLoad;
      expect(fresh.code).toContain('"fresh"');
      expect(fresh.resetModule).toBe(true);
      expect(customLoader).toHaveBeenCalledTimes(2);

      const warm = await privateBroker.loadModule(request);
      expect(warm.code).toContain('"fresh"');
      expect(warm).not.toHaveProperty('resetModule');
      expect(customLoader).toHaveBeenCalledTimes(2);
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the broker mirror synchronized when reset code fails to parse', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    const entryCode = [
      "import { value } from './dep.js';",
      'export const __wywPreval = { value: () => value };',
    ].join('\n');
    writeFileSync(entry, entryCode);
    writeFileSync(dep, 'export const value = 0;');
    let dependencyCode = 'export const value = 1;';
    const customLoader = jest.fn(async (id: string) =>
      id === dep ? { code: dependencyCode } : null
    );
    const services = createServices(root, entry, {
      eval: { customLoader },
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async (what: string, importer: string) =>
        what.startsWith('.') ? resolve(dirname(importer), what) : null
      )
    );
    services.evalBroker = broker;
    const evaluate = () =>
      broker.evaluate(
        createEntrypointAfterRecovery(services, () =>
          Entrypoint.createRoot(services, entry, ['__wywPreval'], entryCode)
        )
      );
    const captureError = async () => {
      try {
        await evaluate();
        throw new Error('expected evaluation to fail');
      } catch (error) {
        return error instanceof Error
          ? error.stack ?? error.message
          : `${error}`;
      }
    };

    try {
      const initial = await evaluate();
      expect(initial.values?.get('value')).toBe(1);

      dependencyCode = 'export const value = ;';
      services.cache.invalidateForFile(dep);
      services.cache.invalidateForFile(entry);
      const firstError = await captureError();
      const repeatedError = await captureError();

      expect(firstError).toMatch(/SyntaxError|Unexpected token/);
      expect(repeatedError).toMatch(/SyntaxError|Unexpected token/);
      expect(repeatedError).not.toContain('cache desync');

      dependencyCode = 'export const value = 2;';
      services.cache.invalidateForFile(dep);
      services.cache.invalidateForFile(entry);
      const recovered = await evaluate();
      expect(recovered.values?.get('value')).toBe(2);
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes runner loads when several sibling importers request one id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const shared = join(root, 'shared.js');
    writeFileSync(shared, 'export const value = 10;');
    for (const [name, offset] of [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ] as const) {
      writeFileSync(
        join(root, `${name}.js`),
        [
          "import { value } from './shared.js';",
          `export const ${name} = value + ${offset};`,
        ].join('\n')
      );
    }
    const entryCode = [
      "import { a } from './a.js';",
      "import { b } from './b.js';",
      "import { c } from './c.js';",
      'export const __wywPreval = { total: () => a + b + c };',
    ].join('\n');
    writeFileSync(entry, entryCode);
    const services = createServices(root, entry);
    const broker = new EvalBroker(
      services,
      jest.fn(async (what: string, importer: string) =>
        what.startsWith('.') ? resolve(dirname(importer), what) : null
      )
    );
    const privateBroker = broker as unknown as {
      handleLoad: (
        requestId: string,
        payload: {
          id: string;
          importerId: string | null;
          request: string | null;
        }
      ) => Promise<void>;
    };
    const originalHandleLoad = privateBroker.handleLoad.bind(broker);
    let activeSharedLoads = 0;
    let concurrentSharedLoad = false;
    let sharedLoadCalls = 0;
    privateBroker.handleLoad = async (requestId, payload) => {
      if (payload.id !== shared) {
        return originalHandleLoad(requestId, payload);
      }

      sharedLoadCalls += 1;
      activeSharedLoads += 1;
      concurrentSharedLoad ||= activeSharedLoads > 1;
      try {
        if (sharedLoadCalls === 2) {
          await new Promise<void>((resolveDelay) => {
            setTimeout(resolveDelay, 25);
          });
        }
        return await originalHandleLoad(requestId, payload);
      } finally {
        activeSharedLoads -= 1;
      }
    };

    try {
      const result = await broker.evaluate(
        Entrypoint.createRoot(services, entry, ['__wywPreval'], entryCode)
      );
      expect(result.values?.get('total')).toBe(36);
      expect(sharedLoadCalls).toBeGreaterThanOrEqual(3);
      expect(concurrentSharedLoad).toBe(false);
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rebuilds processor modules when __wywPreval is requested after named export loads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'styles.ts');

    writeFileSync(
      entry,
      [
        "import { css } from 'test-css-processor';",
        'export const className = css`color: red;`;',
      ].join('\n')
    );

    const services = createServices(root, entry, {
      tagResolver: (source, tag) => {
        if (source === 'test-css-processor' && tag === 'css') {
          return testCssProcessorFile;
        }

        return null;
      },
    });

    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = getPrivateBroker(broker);

    privateBroker.onlyByModule.set(entry, ['className']);
    const first = await privateBroker.loadModule({
      id: entry,
      importerId: entry,
      request: entry,
    });

    expect(first.only).toContain('className');
    expect(first.code).not.toContain('__wywPreval');

    privateBroker.onlyByModule.set(entry, ['__wywPreval']);
    const second = await privateBroker.loadModule({
      id: entry,
      importerId: entry,
      request: entry,
    });

    expect(second.only).toContain('__wywPreval');
    expect(second.code).toContain('__wywPreval');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('reloads in-flight modules when nested imports request additional exports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const helper = join(root, 'helper.js');
    const dep = join(root, 'dep.js');

    writeFileSync(
      entry,
      [
        "import { first } from './dep.js';",
        "import { second } from './helper.js';",
        'export const __wywPreval = {',
        '  value: () => `${first}:${second}`,',
        '};',
      ].join('\n')
    );
    writeFileSync(
      helper,
      ["import { second } from './dep.js';", 'export { second };'].join('\n')
    );
    writeFileSync(
      dep,
      ["export const first = 'first';", "export const second = 'second';"].join(
        '\n'
      )
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }

      return null;
    });
    const services = createServices(root, entry);
    const loadAndParse = services.loadAndParseFn;
    let slowedDepLoad = false;
    services.loadAndParseFn = (nextServices, id, ...rest) => {
      if (id === dep && !slowedDepLoad) {
        slowedDepLoad = true;
        const end = Date.now() + 50;
        while (Date.now() < end) {
          // Keep the first dep load in-flight while nested imports resolve.
        }
      }

      return loadAndParse(nextServices, id, ...rest);
    };

    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe('first:second');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not reuse partial prepared export cache for wildcard or __wywPreval loads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const dep = join(root, 'dep.js');

    writeFileSync(
      dep,
      [
        "export const normal = 'normal';",
        "export const second = 'second';",
        'export const __wywPreval = {',
        "  value: () => 'preval',",
        '};',
      ].join('\n')
    );

    const services = createServices(root, dep);
    const exportsProxy = Entrypoint.createExports(services.log);
    exportsProxy.normal = 'cached-normal';
    services.cache.add('entrypoints', dep, {
      dependencies: new Map(),
      evaluated: true,
      evaluatedOnly: ['*'],
      exports: exportsProxy,
      generation: 1,
      hasTransformResult: false,
      hasWywMetadata: false,
      ignored: false,
      invalidationDependencies: new Map(),
      invalidateOnDependencyChange: new Set(),
      log: services.log,
      name: dep,
      only: ['*'],
      parents: [],
      preevalResult: null,
      seqId: -1,
      transformResultCode: null,
    });

    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);

    privateBroker.onlyByModule.set(dep, ['*']);
    const wildcardPrepared = await privateBroker.loadModule({
      id: dep,
      importerId: dep,
      request: dep,
    });

    privateBroker.onlyByModule.set(dep, ['second']);
    const namedPrepared = await privateBroker.loadModule({
      id: dep,
      importerId: dep,
      request: dep,
    });

    privateBroker.onlyByModule.set(dep, ['__wywPreval']);
    const prevalPrepared = await privateBroker.loadModule({
      id: dep,
      importerId: dep,
      request: dep,
    });

    expect(wildcardPrepared.code).toContain('normal');
    expect(namedPrepared.code).toContain('second');
    expect(prevalPrepared.code).toContain('__wywPreval');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('invalidates all query variants in load cache after file change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'data.txt');
    const rawId = `${dep}?raw`;
    const urlId = `${dep}?url`;

    const customLoader = jest.fn(async (id: string) => ({
      code: `export default ${JSON.stringify(id)};`,
    }));
    const services = createServices(root, importer, {
      eval: { customLoader },
    });

    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);

    await privateBroker.loadModule({
      id: rawId,
      importerId: importer,
      request: rawId,
    });
    await privateBroker.loadModule({
      id: urlId,
      importerId: importer,
      request: urlId,
    });
    await privateBroker.loadModule({
      id: rawId,
      importerId: importer,
      request: rawId,
    });
    await privateBroker.loadModule({
      id: urlId,
      importerId: importer,
      request: urlId,
    });

    expect(customLoader).toHaveBeenCalledTimes(2);

    services.cache.invalidateForFile(dep);

    await privateBroker.loadModule({
      id: rawId,
      importerId: importer,
      request: rawId,
    });
    await privateBroker.loadModule({
      id: urlId,
      importerId: importer,
      request: urlId,
    });

    expect(customLoader).toHaveBeenCalledTimes(4);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('strips top-level browser-global expressions from prepared __wywPreval-only loads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const dep = join(root, 'dep.js');
    writeFileSync(
      dep,
      [
        'const runtimeOnly = () => document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);',
        'const runtimeHref = window.location.href;',
        'export const __wywPreval = {',
        "  value: () => 'ok',",
        '};',
      ].join('\n')
    );

    const services = createServices(root, dep);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.onlyByModule.set(dep, ['__wywPreval']);

    const loaded = await privateBroker.loadModule({
      id: dep,
      importerId: dep,
      request: dep,
    });

    // The shaker removes all code not referenced by __wywPreval.
    expect(loaded.code).not.toContain('window.location.href');
    expect(loaded.code).not.toContain('document.createTreeWalker');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not prepare transitive graph before runner requests modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const leaves = Array.from({ length: 12 }, (_, index) =>
      join(root, `leaf-${index}.js`)
    );

    leaves.forEach((file, index) => {
      writeFileSync(file, `export const value${index} = ${index};`);
    });

    writeFileSync(
      entry,
      [
        ...leaves.map(
          (_, index) => `import { value${index} } from './leaf-${index}.js';`
        ),
        'export const __wywPreval = {',
        "  value: () => 'ready',",
        '};',
      ].join('\n')
    );

    const services = createServices(root, entry);
    const broker = new EvalBroker(
      services,
      jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }
        return null;
      })
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.onlyByModule.set(entry, ['__wywPreval']);

    await privateBroker.loadModule({
      id: entry,
      importerId: entry,
      request: entry,
    });

    for (const leaf of leaves) {
      expect(services.cache.get('entrypoints', leaf)).toBeUndefined();
    }

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not resolve unused imports for __wywPreval-only runner loads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const dep = join(root, 'dep.js');

    writeFileSync(dep, 'export const unused = 1;');
    writeFileSync(
      entry,
      [
        "import { unused } from './dep.js';",
        'export const __wywPreval = {',
        '  value: () => 1,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entry);
    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(1);
    expect(asyncResolve).not.toHaveBeenCalledWith('./dep.js', entry);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not widen preval-only eval loads with cached runtime component exports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.tsx');
    const tokens = join(root, 'tokens.ts');

    writeFileSync(
      tokens,
      [
        'export const border = { radius8: 8 };',
        "export const themeVars = { inputBorderHoverColor: 'red' };",
      ].join('\n')
    );
    writeFileSync(
      entry,
      [
        "import { memo } from 'react';",
        "import { css } from 'test-css-processor';",
        "import { border, themeVars } from './tokens';",
        'const className = css`',
        '  border-radius: ${border.radius8}px;',
        '  color: ${themeVars.inputBorderHoverColor};',
        '`;',
        'export const Comment = memo(function Comment() {',
        '  return <div className={className} />;',
        '});',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what === 'test-css-processor') {
        return testCssProcessorFile;
      }

      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }

      return null;
    });
    const services = createServices(root, entry, {
      tagResolver: (source, tag) => {
        if (source === 'test-css-processor' && tag === 'css') {
          return testCssProcessorFile;
        }

        return null;
      },
    });
    const broker = new EvalBroker(services, asyncResolve);
    const privateBroker = getPrivateBroker(broker);

    privateBroker.onlyByModule.set(entry, ['Comment']);
    await privateBroker.loadModule({
      id: entry,
      importerId: entry,
      request: entry,
    });

    privateBroker.onlyByModule.set(entry, ['__wywPreval']);
    const loaded = await privateBroker.loadModule({
      id: entry,
      importerId: entry,
      request: entry,
    });

    expect(loaded.only).toEqual(['__wywPreval']);
    expect(loaded.code).toContain('export const __wywPreval');
    expect(loaded.code).not.toContain('memo');
    expect(loaded.code).not.toContain('Comment');
    expect(loaded.imports?.has('react')).toBe(false);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('evaluates a module graph via runner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const dep = join(root, 'dep.js');

    writeFileSync(dep, 'export const value = 41;');
    writeFileSync(
      entry,
      [
        "import { value } from './dep.js';",
        'export const __wywPreval = {',
        '  value: () => value + 1,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entry);
    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(42);
    expect(result.dependencies).toContain('./dep.js');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('propagates cache-recovery errors from runner resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    const nextEntry = join(root, 'next-entry.js');

    writeFileSync(dep, 'export const value = 41;');
    writeFileSync(
      entry,
      [
        "import { value } from './dep.js';",
        'export const __wywPreval = { value: () => value };',
      ].join('\n')
    );
    const nextSource = 'export const __wywPreval = { value: () => 42 };';
    writeFileSync(nextEntry, nextSource);

    const recoveryError = new CacheKeySaltBusyError();
    const asyncResolve = jest.fn(async () => {
      throw recoveryError;
    });
    const services = createServices(root, entry, {
      eval: { require: 'warn-and-run', resolver: 'bundler' },
    });
    const nextServices = createServices(root, nextEntry);
    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );
    const nextEntrypoint = Entrypoint.createRoot(
      nextServices,
      nextEntry,
      ['__wywPreval'],
      nextSource
    );

    try {
      const evaluation = broker.evaluate(entrypoint);
      const observedError = evaluation.catch((error: unknown) => error);
      const nextEvaluation = broker.evaluate(nextEntrypoint, nextServices);

      await expect(evaluation).rejects.toBe(recoveryError);
      const error = await observedError;
      expect(isCacheKeySaltBusyError(error)).toBe(true);
      expect(error).toMatchObject({ code: CACHE_KEY_SALT_BUSY });
      expect((await nextEvaluation).values?.get('value')).toBe(42);
      expect(asyncResolve).toHaveBeenCalled();
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('propagates cache-recovery errors from runner loading', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    const source = [
      "import { value } from './dep.js';",
      'export const __wywPreval = { value: () => value };',
    ].join('\n');
    writeFileSync(entry, source);
    writeFileSync(dep, 'export const value = 41;');

    const recoveryError = new CacheKeySaltBusyError();
    const asyncResolve = jest.fn(async (what: string, importer: string) =>
      what.startsWith('.') ? resolve(dirname(importer), what) : null
    );
    const services = createServices(root, entry, {
      eval: { require: 'warn-and-run', resolver: 'bundler' },
    });
    const loadAndParse = services.loadAndParseFn;
    services.loadAndParseFn = (nextServices, id, ...rest) => {
      if (id === dep) {
        throw recoveryError;
      }
      return loadAndParse(nextServices, id, ...rest);
    };
    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      source
    );

    try {
      const evaluation = broker.evaluate(entrypoint);
      const observedError = evaluation.catch((error: unknown) => error);

      await expect(evaluation).rejects.toBe(recoveryError);
      const error = await observedError;
      expect(isCacheKeySaltBusyError(error)).toBe(true);
      expect(error).toMatchObject({ code: CACHE_KEY_SALT_BUSY });
      expect(asyncResolve).toHaveBeenCalled();
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recreates invalidated primary runner modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    const entryCode = [
      "import * as token from './dep.js';",
      'export const __wywPreval = {',
      '  value: () => token.value,',
      '};',
    ].join('\n');

    writeFileSync(dep, "export const value = (() => 'old')();");
    writeFileSync(entry, entryCode);
    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entry, {
      importOverrides: {
        './dep.js': { noShake: true },
      },
    });
    const broker = new EvalBroker(services, asyncResolve);
    const privateBroker = getPrivateBroker(broker);

    try {
      const initial = await broker.evaluate(
        Entrypoint.createRoot(services, entry, ['__wywPreval'], entryCode)
      );
      expect(initial.values?.get('value')).toBe('old');
      expect(privateBroker.loadMirror.get(dep)?.only).toContain('*');

      writeFileSync(dep, "export const value = (() => 'fresh')();");
      services.cache.invalidateForFile(dep);
      services.cache.invalidateForFile(entry);

      const updated = await broker.evaluate(
        Entrypoint.createRoot(services, entry, ['__wywPreval'], entryCode)
      );
      expect(updated.values?.get('value')).toBe('fresh');
      expect(readFileSync(entry, 'utf8')).toBe(entryCode);
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('enables eval-file debug in the runner only for enabled emitters', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    writeFileSync(entry, 'export const __wywPreval = {};');

    const services = createServices(root, entry);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.request = jest.fn(async () => ({})) as never;

    try {
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      await privateBroker.initRunner(entrypoint);
      const disabledPayload = (privateBroker.request as jest.Mock).mock
        .calls[0][1] as Record<string, unknown>;
      expect(disabledPayload.debugEvalFiles).toBeUndefined();

      services.eventEmitter = new EventEmitter(
        () => {},
        createActionIdHandler(),
        () => {}
      );
      privateBroker.lastInitKey = null;
      (privateBroker.request as jest.Mock).mockClear();

      await privateBroker.initRunner(entrypoint);
      const enabledPayload = (privateBroker.request as jest.Mock).mock
        .calls[0][1] as Record<string, unknown>;
      expect(enabledPayload.debugEvalFiles).toBe(true);
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits eval-file debug rows with serialized and stringified export values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const dep = join(root, 'dep.js');

    writeFileSync(
      dep,
      ['export const value = 41;', 'export const helper = () => value;'].join(
        '\n'
      )
    );
    writeFileSync(
      entry,
      [
        "import { value, helper } from './dep.js';",
        'export const __wywPreval = {',
        '  result: () => value + (typeof helper === "function" ? 1 : 0),',
        '};',
      ].join('\n')
    );

    const services = createServices(root, entry);
    const events: Record<string, unknown>[] = [];
    services.eventEmitter = new EventEmitter(
      (meta, type) => {
        if (type === 'single') {
          events.push(meta);
        }
      },
      createActionIdHandler(),
      () => {}
    );

    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );

    try {
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      const result = await broker.evaluate(entrypoint);
      expect(result.values?.get('result')).toBe(42);

      const resolvedDep = realpathSync(dep);
      const depEvent = events.find(
        (event) =>
          event.type === 'eval-file' &&
          (event.id === dep || event.id === resolvedDep)
      );
      expect(depEvent).toEqual(
        expect.objectContaining({
          contentBase64: expect.any(String),
          evalSeq: 1,
          payloadKind: 'code',
          valuesBase64: expect.any(String),
        })
      );

      const code = Buffer.from(
        depEvent!.contentBase64 as string,
        'base64'
      ).toString('utf8');
      expect(code).toContain('export const value = 41');

      const values = JSON.parse(
        Buffer.from(depEvent!.valuesBase64 as string, 'base64').toString('utf8')
      ) as {
        exports: Record<
          string,
          { reason?: string; status: 'serialized' | 'stringified' }
        >;
      };
      expect(values.exports.value.status).toBe('serialized');
      expect(values.exports.helper.status).toBe('stringified');
      expect(values.exports.helper.reason).toContain('unsupported function');
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps package subdirectory modules classified as ESM after cached package misses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const packageDir = join(root, 'node_modules', 'fake');
    const srcDir = join(packageDir, 'src');
    const cjsDir = join(packageDir, 'cjs');
    const first = join(srcDir, 'first.js');
    const second = join(srcDir, 'second.js');

    mkdirSync(srcDir, { recursive: true });
    mkdirSync(cjsDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: {
          './first': {
            import: './src/first.js',
            require: './cjs/first.cjs',
          },
          './second': {
            import: './src/second.js',
            require: './cjs/second.cjs',
          },
        },
      })
    );
    writeFileSync(first, 'export const first = 1;');
    writeFileSync(second, 'export const second = 2;');
    writeFileSync(join(cjsDir, 'first.cjs'), 'exports.first = 10;');
    writeFileSync(join(cjsDir, 'second.cjs'), 'exports.second = 20;');
    writeFileSync(
      entry,
      [
        "import { first } from 'fake/first';",
        "import { second } from 'fake/second';",
        'export const __wywPreval = {',
        '  value: () => first + second,',
        '};',
      ].join('\n')
    );

    const warnings: Array<{ code: string; specifier?: string }> = [];
    const asyncResolve = jest.fn(async (what: string) => {
      if (what === 'fake/first') {
        return first;
      }
      if (what === 'fake/second') {
        return second;
      }
      return null;
    });
    const services = createServices(root, entry, {
      eval: {
        onWarn: (warning) => warnings.push(warning),
      },
    });
    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(3);
    expect(warnings.filter((w) => w.code === 'require-fallback')).toHaveLength(
      0
    );

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('uses root ancestor as async resolver stack root for evaluated child entrypoints', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    const nested = join(root, 'nested.js');

    writeFileSync(entry, "import './dep.js';");
    writeFileSync(nested, 'export const value = 41;');
    writeFileSync(
      dep,
      [
        "import { value } from './nested.js';",
        'export const __wywPreval = {',
        '  value: () => value + 1,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entry);
    const broker = new EvalBroker(services, asyncResolve);
    const rootEntrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );
    const childEntrypoint = rootEntrypoint.createChild(
      dep,
      ['__wywPreval'],
      readFileSync(dep, 'utf-8')
    );

    if (childEntrypoint === 'loop') {
      throw new Error('Unexpected loop in test entrypoint graph');
    }

    const result = await broker.evaluate(childEntrypoint);

    expect(result.values?.get('value')).toBe(42);
    expect(asyncResolve).toHaveBeenCalledWith('./nested.js', dep, [dep, entry]);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not supersede a statically evaluatable child while it is being evaluated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const child = join(root, 'child.js');
    const childCode = 'export const __wywPreval = { value: () => 1 };';

    writeFileSync(entry, "import './child.js';");
    writeFileSync(child, childCode);

    const services = createServices(root, entry);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const rootEntrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );
    const childEntrypoint = rootEntrypoint.createChild(
      child,
      ['__wywPreval'],
      childCode
    );

    if (childEntrypoint === 'loop') {
      throw new Error('Unexpected loop in test entrypoint graph');
    }

    const result = await broker.evaluate(childEntrypoint);
    expect(result.values?.get('value')).toBe(1);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps only direct dependency specifiers in metadata for re-export chains', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const barrel = join(root, 'barrel.js');
    const leaf = join(root, 'leaf.js');

    writeFileSync(leaf, 'export const value = 41;');
    writeFileSync(barrel, `export { value } from './leaf.js';`);
    writeFileSync(
      entry,
      [
        "import { value } from './barrel.js';",
        'export const __wywPreval = {',
        '  value: () => value + 1,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entry);
    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(42);
    expect(result.dependencies).toEqual(['./barrel.js']);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('evaluates a barrel that wildcard re-exports a runtime-empty module', async () => {
    // A module can be a real, resolvable ESM dependency edge while shaking
    // down to zero runtime bytes (e.g. it only ever declared TypeScript
    // types). `export * from './dep'` in a barrel can't be selectively
    // pruned without knowing the wildcard target's exports, so the
    // statement survives shaking and the runner's native ESM linker still
    // requests `dep` on first load. The broker must ship the genuine empty
    // string in that case rather than treating "no code" as license to
    // reuse a cached module the runner has never seen.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.ts');
    const barrel = join(root, 'barrel.ts');
    const dep = join(root, 'dep.ts');

    writeFileSync(dep, 'export type Foo = string;\n');
    writeFileSync(
      barrel,
      ["export * from './dep';", 'export const marker = 1;'].join('\n')
    );
    writeFileSync(
      entry,
      [
        "import { marker } from './barrel';",
        'export const __wywPreval = {',
        '  value: () => marker,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entry);
    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(1);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('reuses a first-load runtime-empty module on a second request in the same session', async () => {
    // Companion to the barrel test above: once the runner has actually seen
    // (and cached) the empty module under its hash, a later request for the
    // same id/hash must still short-circuit via the cache-reuse path instead
    // of re-shipping — proving the fix doesn't just move the bug to the
    // second load.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entryA = join(root, 'entry-a.ts');
    const entryB = join(root, 'entry-b.ts');
    const barrel = join(root, 'barrel.ts');
    const dep = join(root, 'dep.ts');

    writeFileSync(dep, 'export type Foo = string;\n');
    writeFileSync(
      barrel,
      ["export * from './dep';", 'export const marker = 1;'].join('\n')
    );
    writeFileSync(
      entryA,
      [
        "import { marker } from './barrel';",
        'export const __wywPreval = {',
        '  value: () => marker,',
        '};',
      ].join('\n')
    );
    writeFileSync(
      entryB,
      [
        "import { marker } from './barrel';",
        'export const __wywPreval = {',
        '  value: () => marker + 1,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entryA);
    const broker = new EvalBroker(services, asyncResolve);

    const first = await broker.evaluate(
      Entrypoint.createRoot(
        services,
        entryA,
        ['__wywPreval'],
        readFileSync(entryA, 'utf-8')
      )
    );
    expect(first.values?.get('value')).toBe(1);

    const second = await broker.evaluate(
      Entrypoint.createRoot(
        services,
        entryB,
        ['__wywPreval'],
        readFileSync(entryB, 'utf-8')
      )
    );
    expect(second.values?.get('value')).toBe(2);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  describe('eval.globals lifecycle', () => {
    it('re-evaluates when eval.globals value changes between runs', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');

      writeFileSync(
        entry,
        [
          'const captured = GLOBAL_VAL;',
          'export const __wywPreval = {',
          '  value: () => captured,',
          '};',
        ].join('\n')
      );

      const services = createServices(root, entry, {
        eval: {
          globals: {
            GLOBAL_VAL: 1,
          },
        },
      });
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      const first = await broker.evaluate(entrypoint);
      expect(first.values?.get('value')).toBe(1);

      services.options.pluginOptions.eval = {
        ...(services.options.pluginOptions.eval ?? {}),
        globals: {
          GLOBAL_VAL: 2,
        },
      };

      const second = await broker.evaluate(entrypoint);
      expect(second.values?.get('value')).toBe(2);

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('drops removed globals across re-init', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');

      writeFileSync(
        entry,
        [
          "const captured = typeof REMOVED_GLOBAL === 'undefined' ? 'missing' : REMOVED_GLOBAL;",
          'export const __wywPreval = {',
          '  value: () => captured,',
          '};',
        ].join('\n')
      );

      const services = createServices(root, entry, {
        eval: {
          globals: {
            REMOVED_GLOBAL: 'present',
          },
        },
      });
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      const first = await broker.evaluate(entrypoint);
      expect(first.values?.get('value')).toBe('present');

      services.options.pluginOptions.eval = {
        ...(services.options.pluginOptions.eval ?? {}),
        globals: {},
      };

      const second = await broker.evaluate(entrypoint);
      expect(second.values?.get('value')).toBe('missing');

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('keeps the warm runner when a late happyDOM upgrade times out', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const plainEntry = join(root, 'plain-entry.js');
      const domEntry = join(root, 'dom-entry.js');

      writeFileSync(
        plainEntry,
        ['export const __wywPreval = {', "  value: () => 'plain',", '};'].join(
          '\n'
        )
      );
      writeFileSync(
        domEntry,
        ['export const __wywPreval = {', "  value: () => 'dom',", '};'].join(
          '\n'
        )
      );

      const services = createServices(root, plainEntry, {
        features: {
          ...createPluginOptions().features,
          happyDOM: [domEntry],
        },
      });
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const privateBroker = getPrivateBroker(broker);
      const request = jest
        .spyOn(privateBroker, 'request')
        .mockResolvedValue({});
      const initIsolatedRunner = jest
        .spyOn(privateBroker, 'initIsolatedRunner')
        .mockImplementation(async () => {
          const error = new Error('[wyw-in-js] Eval runner timed out for INIT');
          (error as { code?: string }).code = 'WYW_EVAL_TIMEOUT';
          throw error;
        });

      const plainEntrypoint = Entrypoint.createRoot(
        services,
        plainEntry,
        ['__wywPreval'],
        readFileSync(plainEntry, 'utf-8')
      );
      await privateBroker.initRunner(plainEntrypoint);

      privateBroker.runner = {
        kill: jest.fn(),
        removeAllListeners: jest.fn(),
      } as unknown;

      const domEntrypoint = Entrypoint.createRoot(
        services,
        domEntry,
        ['__wywPreval'],
        readFileSync(domEntry, 'utf-8')
      );
      await privateBroker.initRunner(domEntrypoint);

      expect(initIsolatedRunner).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1]?.[0]).toBe('INIT');
      expect(privateBroker.happyDomDisabled).toBe(true);
      expect(privateBroker.lastHappyDomEnabled).toBe(false);
      expect(privateBroker.lastInitKey).not.toBeNull();

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('reuses non-serializable dependency modules across entrypoints when globals are stable', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const dep = join(root, 'dep.js');
      const firstEntry = join(root, 'entry-a.js');
      const secondEntry = join(root, 'entry-b.js');

      writeFileSync(
        dep,
        [
          'const value = () => undefined;',
          'value.token = Math.random().toString(36).slice(2);',
          'export default value;',
        ].join('\n')
      );
      writeFileSync(
        firstEntry,
        [
          "import dep from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => dep.token,',
          '};',
        ].join('\n')
      );
      writeFileSync(
        secondEntry,
        [
          "import dep from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => dep.token,',
          '};',
        ].join('\n')
      );

      const asyncResolve = jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }
        return null;
      });
      const services = createServices(root, firstEntry);
      const broker = new EvalBroker(services, asyncResolve);
      const firstEntrypoint = Entrypoint.createRoot(
        services,
        firstEntry,
        ['__wywPreval'],
        readFileSync(firstEntry, 'utf-8')
      );
      const secondEntrypoint = Entrypoint.createRoot(
        services,
        secondEntry,
        ['__wywPreval'],
        readFileSync(secondEntry, 'utf-8')
      );

      const first = await broker.evaluate(firstEntrypoint);
      const second = await broker.evaluate(secondEntrypoint);

      expect(first.values?.get('value')).toBe(second.values?.get('value'));

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('reuses non-serializable dependency modules across entrypoints when overrideContext globals stay stable', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const dep = join(root, 'dep.js');
      const firstEntry = join(root, 'entry-a.js');
      const secondEntry = join(root, 'entry-b.js');

      writeFileSync(
        dep,
        [
          'const value = () => undefined;',
          'value.token = Math.random().toString(36).slice(2);',
          'export default value;',
        ].join('\n')
      );
      writeFileSync(
        firstEntry,
        [
          "import dep from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => dep.token,',
          '};',
        ].join('\n')
      );
      writeFileSync(
        secondEntry,
        [
          "import dep from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => dep.token,',
          '};',
        ].join('\n')
      );

      const asyncResolve = jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }
        return null;
      });
      const services = createServices(root, firstEntry, {
        overrideContext: (context) => ({
          ...context,
          __wyw_import_meta_env: {
            MODE: 'production',
          },
        }),
      });
      const broker = new EvalBroker(services, asyncResolve);
      const firstEntrypoint = Entrypoint.createRoot(
        services,
        firstEntry,
        ['__wywPreval'],
        readFileSync(firstEntry, 'utf-8')
      );
      const secondEntrypoint = Entrypoint.createRoot(
        services,
        secondEntry,
        ['__wywPreval'],
        readFileSync(secondEntry, 'utf-8')
      );

      const first = await broker.evaluate(firstEntrypoint);
      const second = await broker.evaluate(secondEntrypoint);

      expect(first.values?.get('value')).toBe(second.values?.get('value'));

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('dedupes concurrent loads for a shared noShake dependency across root and importer entrypoints', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const dep = join(root, 'icons.js');
      const svgMock = join(root, 'svg-react.js');
      const firstEntry = join(root, 'entry-a.js');
      const secondEntry = join(root, 'entry-b.js');

      writeFileSync(svgMock, 'export default "svg-mock";');
      writeFileSync(
        dep,
        [
          'export const loadCount = (() => { globalThis.__iconsLoadCount = (globalThis.__iconsLoadCount ?? 0) + 1; return globalThis.__iconsLoadCount; })();',
          "import InviteMedium from './svg-react.js';",
          "import CreateSemibold from './svg-react.js';",
          'export { InviteMedium, CreateSemibold };',
        ].join('\n')
      );
      writeFileSync(
        firstEntry,
        [
          "import { InviteMedium, loadCount } from './icons.js';",
          'export const __wywPreval = {',
          '  count: () => loadCount,',
          '  value: () => InviteMedium,',
          '};',
        ].join('\n')
      );
      writeFileSync(
        secondEntry,
        [
          "import { CreateSemibold, loadCount } from './icons.js';",
          'export const __wywPreval = {',
          '  count: () => loadCount,',
          '  value: () => CreateSemibold,',
          '};',
        ].join('\n')
      );

      const asyncResolve = jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }
        return null;
      });
      const services = createServices(root, firstEntry, {
        importOverrides: {
          './icons.js': { noShake: true },
        },
      });
      const broker = new EvalBroker(services, asyncResolve);
      const firstEntrypoint = Entrypoint.createRoot(
        services,
        firstEntry,
        ['__wywPreval'],
        readFileSync(firstEntry, 'utf-8')
      );
      const secondEntrypoint = Entrypoint.createRoot(
        services,
        secondEntry,
        ['__wywPreval'],
        readFileSync(secondEntry, 'utf-8')
      );

      const [firstResult, secondResult] = await Promise.all([
        broker.evaluate(firstEntrypoint),
        broker.evaluate(secondEntrypoint),
      ]);

      // Both entries import icons.js with noShake — single unshaken variant,
      // so the module executes only once despite two concurrent consumers.
      expect(firstResult.values?.get('count')).toBe(1);
      expect(secondResult.values?.get('count')).toBe(1);
      expect(firstResult.values?.get('value')).toBe('svg-mock');
      expect(secondResult.values?.get('value')).toBe('svg-mock');

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('does not reuse non-serializable dependency modules across entrypoints when overrideContext globals change', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const dep = join(root, 'dep.js');
      const firstEntry = join(root, 'entry-a.js');
      const secondEntry = join(root, 'entry-b.js');

      writeFileSync(
        dep,
        [
          'const value = () => undefined;',
          'value.token = Math.random().toString(36).slice(2);',
          'export default value;',
        ].join('\n')
      );
      writeFileSync(
        firstEntry,
        [
          "import dep from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => dep.token,',
          '};',
        ].join('\n')
      );
      writeFileSync(
        secondEntry,
        [
          "import dep from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => dep.token,',
          '};',
        ].join('\n')
      );

      const asyncResolve = jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }
        return null;
      });
      const services = createServices(root, firstEntry, {
        overrideContext: (context) => ({
          ...context,
          CURRENT_FILE: context.__filename,
        }),
      });
      const broker = new EvalBroker(services, asyncResolve);
      const firstEntrypoint = Entrypoint.createRoot(
        services,
        firstEntry,
        ['__wywPreval'],
        readFileSync(firstEntry, 'utf-8')
      );
      const secondEntrypoint = Entrypoint.createRoot(
        services,
        secondEntry,
        ['__wywPreval'],
        readFileSync(secondEntry, 'utf-8')
      );

      const first = await broker.evaluate(firstEntrypoint);
      const second = await broker.evaluate(secondEntrypoint);

      expect(first.values?.get('value')).not.toBe(second.values?.get('value'));

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('wraps decode failures with path-aware globals diagnostics', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');

      writeFileSync(
        entry,
        ['export const __wywPreval = {', '  value: () => 1,', '};'].join('\n')
      );

      const services = createServices(root, entry, {
        eval: {
          globals: {
            BROKEN_FN: {
              __wyw_eval_global: {
                signature: 'wyw-eval-global',
                version: 1,
                kind: 'function',
                source: 'function () {',
              },
            },
          },
        },
      });
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      await expect(broker.evaluate(entrypoint)).rejects.toThrow(
        '[wyw-in-js] Failed to restore eval.globals function at eval.globals.BROKEN_FN. Ensure the value is a user-defined function expression/arrow function. Native and bound functions are not supported.'
      );

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('reports path-aware errors for unsupported __wywPreval values', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');

      writeFileSync(
        entry,
        [
          'export const __wywPreval = {',
          '  value: () => ({',
          "    nested: new Map([['answer', 42]]),",
          '  }),',
          '};',
        ].join('\n')
      );

      const services = createServices(root, entry);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      try {
        const result = await broker.evaluate(entrypoint);
        const value = result.values?.get('value') as { nested: unknown };

        expect(() => value.nested).toThrow('[wyw-in-js] __wywPreval');
        expect(() => value.nested).toThrow('__wywPreval.value.nested');
        expect(() => value.nested).toThrow(
          'unsupported non-plain object (Map)'
        );
      } finally {
        broker.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('preserves deferred getter errors from the eval VM context', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');

      writeFileSync(
        entry,
        [
          'const value = { usable: true };',
          "Object.defineProperty(value, 'runtimeOnly', {",
          '  enumerable: true,',
          '  get() {',
          "    throw new TypeError('runtime getter failed');",
          '  },',
          '});',
          'export const __wywPreval = { value: () => value };',
        ].join('\n')
      );

      const services = createServices(root, entry);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      try {
        const result = await broker.evaluate(entrypoint);
        const value = result.values?.get('value') as {
          runtimeOnly: unknown;
          usable: boolean;
        };

        expect(value.usable).toBe(true);
        try {
          Reflect.get(value, 'runtimeOnly');
          throw new Error('Expected runtimeOnly to throw');
        } catch (error) {
          expect(error).toMatchObject({
            message: 'runtime getter failed',
            name: 'TypeError',
          });
        }
      } finally {
        broker.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('preserves function-valued __wywPreval entries as callable placeholders', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');

      writeFileSync(
        entry,
        [
          'const helper = () => 1;',
          'export const __wywPreval = {',
          '  value: () => helper,',
          '};',
        ].join('\n')
      );

      const services = createServices(root, entry);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      try {
        const result = await broker.evaluate(entrypoint);
        const value = result.values?.get('value');

        expect(typeof value).toBe('function');
        expect((value as () => unknown)()).toBeUndefined();
      } finally {
        broker.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('preserves symbol markers inside __wywPreval objects', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');

      writeFileSync(
        entry,
        [
          "const marker = Symbol.for('react.forward_ref');",
          'export const __wywPreval = {',
          '  value: () => ({ marker }),',
          '};',
        ].join('\n')
      );

      const services = createServices(root, entry);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      try {
        const result = await broker.evaluate(entrypoint);
        const value = result.values?.get('value') as
          | { marker?: symbol }
          | undefined;

        expect(typeof value?.marker).toBe('symbol');
        expect(value?.marker).toBe(Symbol.for('react.forward_ref'));
      } finally {
        broker.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('skips non-serializable dependency exports when caching module results', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');
      const secondEntry = join(root, 'entry-2.js');
      const dep = join(root, 'dep.js');

      writeFileSync(
        dep,
        [
          'export const serializable = 41;',
          'export const skipped = () => 2;',
        ].join('\n')
      );
      writeFileSync(
        entry,
        [
          "import { serializable, skipped } from './dep.js';",
          'export const __wywPreval = {',
          "  value: () => serializable + (typeof skipped === 'function' ? 1 : 0),",
          '};',
        ].join('\n')
      );
      writeFileSync(
        secondEntry,
        [
          "import { skipped } from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => skipped(),',
          '};',
        ].join('\n')
      );

      const asyncResolve = jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }
        return null;
      });
      const services = createServices(root, entry);
      const broker = new EvalBroker(services, asyncResolve);
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      try {
        const result = await broker.evaluate(entrypoint);
        const secondEntrypoint = Entrypoint.createRoot(
          services,
          secondEntry,
          ['__wywPreval'],
          readFileSync(secondEntry, 'utf-8')
        );
        const secondResult = await broker.evaluate(secondEntrypoint);
        const cachedDep = services.cache.get('entrypoints', dep) as
          | {
              exports?: Record<string, unknown>;
              evaluatedOnly?: string[];
            }
          | undefined;

        expect(result.values?.get('value')).toBe(42);
        expect(secondResult.values?.get('value')).toBe(2);
        expect(cachedDep).toBeDefined();
        expect(cachedDep?.exports?.serializable).toBe(41);
        expect(cachedDep?.exports && 'skipped' in cachedDep.exports).toBe(
          false
        );
        expect(cachedDep?.evaluatedOnly).not.toContain('*');
      } finally {
        broker.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('promotes statically evaluatable dependency modules to wildcard cache coverage', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');
      const dep = join(root, 'dep.js');

      writeFileSync(
        dep,
        ['export const foo1 = "foo1";', 'export const foo2 = "foo2";'].join(
          '\n'
        )
      );
      writeFileSync(
        entry,
        [
          "import { foo1 } from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => foo1,',
          '};',
        ].join('\n')
      );

      const asyncResolve = jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }

        return null;
      });
      const services = createServices(root, entry);
      const broker = new EvalBroker(services, asyncResolve);
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      const result = await broker.evaluate(entrypoint);
      const cachedDep = services.cache.get('entrypoints', dep) as
        | {
            exports?: Record<string, unknown>;
            evaluatedOnly?: string[];
          }
        | undefined;

      expect(result.values?.get('value')).toBe('foo1');
      expect(cachedDep?.evaluatedOnly).toContain('*');
      expect(cachedDep?.exports?.foo1).toBe('foo1');
      expect(cachedDep?.exports?.foo2).toBe('foo2');

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('does not reuse wildcard cached exports for subsequent __wywPreval requests', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');
      const dep = join(root, 'dep.js');

      writeFileSync(
        dep,
        [
          'export const normal = 41;',
          'export const __wywPreval = {',
          '  value: () => normal + 1,',
          '};',
        ].join('\n')
      );
      writeFileSync(
        entry,
        [
          "import { normal } from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => normal,',
          '};',
        ].join('\n')
      );

      const asyncResolve = jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }

        return null;
      });
      const services = createServices(root, entry);
      const broker = new EvalBroker(services, asyncResolve);
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      const firstResult = await broker.evaluate(entrypoint);
      const cachedDep = services.cache.get('entrypoints', dep) as
        | {
            evaluatedOnly?: string[];
            exports?: Record<string, unknown>;
          }
        | undefined;
      const depEntrypoint = Entrypoint.createRoot(
        services,
        dep,
        ['__wywPreval'],
        readFileSync(dep, 'utf-8')
      );
      const secondResult = await broker.evaluate(depEntrypoint);

      expect(firstResult.values?.get('value')).toBe(41);
      expect(cachedDep?.evaluatedOnly).toContain('*');
      expect(cachedDep?.exports?.normal).toBe(41);
      expect(cachedDep?.exports && '__wywPreval' in cachedDep.exports).toBe(
        false
      );
      expect(secondResult.values?.get('value')).toBe(42);

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('builds direct proxy modules for requested exports from mixed re-export barrels', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');
      const barrel = join(root, 'barrel.js');
      const main = join(root, 'main.js');
      const used = join(root, 'used.js');
      const unused = join(root, 'unused.js');

      writeFileSync(main, 'export default 1;');
      writeFileSync(used, 'export default 41;');
      writeFileSync(
        unused,
        'throw new Error("unused export should stay cold");'
      );
      writeFileSync(
        barrel,
        [
          "import main from './main.js';",
          "export { default as used } from './used.js';",
          "export { default as unused } from './unused.js';",
          'export default main;',
        ].join('\n')
      );
      writeFileSync(
        entry,
        [
          "import { used } from './barrel.js';",
          'export const __wywPreval = {',
          '  value: () => used,',
          '};',
        ].join('\n')
      );

      const asyncResolve = jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }
        return null;
      });
      const services = createServices(root, entry);
      const broker = new EvalBroker(services, asyncResolve);
      const privateBroker = getPrivateBroker(broker);

      privateBroker.onlyByModule.set(barrel, ['used']);
      const prepared = await privateBroker.loadModule({
        id: barrel,
        importerId: entry,
        request: './barrel.js',
      });

      expect(prepared.code).toContain('./used.js');
      expect(prepared.code).not.toContain('./unused.js');
      expect(prepared.code).not.toContain('./main.js');

      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      const result = await broker.evaluate(entrypoint);

      expect(result.values?.get('value')).toBe(41);

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('widens shared dependency export surface from cached parent requests', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const first = join(root, 'first.js');
      const second = join(root, 'second.js');
      const dep = join(root, 'dep.js');

      writeFileSync(
        dep,
        [
          'const values = (() => ({ foo: "foo", bar: "bar" }))();',
          'export const foo = values.foo;',
          'export const bar = values.bar;',
        ].join('\n')
      );
      writeFileSync(
        first,
        ["import { foo } from './dep.js';", 'export const value = foo;'].join(
          '\n'
        )
      );
      writeFileSync(
        second,
        ["import { bar } from './dep.js';", 'export const value = bar;'].join(
          '\n'
        )
      );
      const services = createServices(root, first);
      services.cache.add('entrypoints', first, {
        dependencies: new Map([
          [
            './dep.js',
            {
              only: ['foo'],
              resolved: dep,
              source: './dep.js',
            },
          ],
        ]),
      } as any);
      services.cache.add('entrypoints', second, {
        dependencies: new Map([
          [
            './dep.js',
            {
              only: ['bar'],
              resolved: dep,
              source: './dep.js',
            },
          ],
        ]),
      } as any);

      const broker = new EvalBroker(
        services,
        jest.fn(async (what: string, importer: string) => {
          if (what.startsWith('.')) {
            return resolve(dirname(importer), what);
          }
          return null;
        })
      );
      const privateBroker = getPrivateBroker(broker);
      privateBroker.onlyByModule.set(dep, ['foo']);

      const loaded = await privateBroker.loadModule({
        id: dep,
        importerId: first,
        request: './dep.js',
      });

      expect(loaded.only).toEqual(expect.arrayContaining(['foo', 'bar']));
      expect(loaded.code).toContain('foo');
      expect(loaded.code).toContain('bar');

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });
  });

  it('evaluates a cyclic module graph via runner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'a.js');
    const dep = join(root, 'b.js');

    writeFileSync(
      entry,
      [
        "import { valueB } from './b.js';",
        'export const valueA = 40;',
        'export const __wywPreval = {',
        '  value: () => valueA + valueB,',
        '};',
      ].join('\n')
    );
    writeFileSync(
      dep,
      ["import { valueA } from './a.js';", 'export const valueB = 2;'].join(
        '\n'
      )
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entry);
    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(42);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('applies importOverrides when resolving external packages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const mock = join(root, 'mock.js');
    const nodeModulesDir = join(root, 'node_modules', 'fake');
    const dep = join(nodeModulesDir, 'index.js');

    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(dep, 'module.exports = { value: 41 };');
    writeFileSync(mock, 'export default { value: 1 };');
    writeFileSync(
      entry,
      [
        "import fake from 'fake';",
        'export const __wywPreval = {',
        '  value: () => fake.value,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what === 'fake') {
        return dep;
      }
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });

    const services = createServices(root, entry, {
      importOverrides: {
        fake: {
          mock: './mock.js',
        },
      },
    });

    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(1);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps ESM package entries without asset imports on the external path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const nodeModulesDir = join(root, 'node_modules', 'fake');
    const dep = join(nodeModulesDir, 'index.js');

    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(join(nodeModulesDir, 'package.json'), '{"type":"module"}');
    writeFileSync(dep, 'export const value = 42;');
    writeFileSync(
      entry,
      [
        "import { value } from 'fake';",
        'export const __wywPreval = {',
        '  value: () => value,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what === 'fake') {
        return dep;
      }
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });

    const services = createServices(root, entry);
    const loadAndParse = services.loadAndParseFn;
    const loadedIds: string[] = [];
    services.loadAndParseFn = (nextServices, id, ...rest) => {
      loadedIds.push(id);
      return loadAndParse(nextServices, id, ...rest);
    };

    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(42);
    expect(loadedIds).not.toContain(dep);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to broker loading when an external ESM package imports CSS', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const nodeModulesDir = join(root, 'node_modules', 'fake');
    const dep = join(nodeModulesDir, 'index.js');
    const css = join(nodeModulesDir, 'styles.css');

    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(join(nodeModulesDir, 'package.json'), '{"type":"module"}');
    writeFileSync(css, '.fake { color: red; }');
    writeFileSync(
      dep,
      ["import './styles.css';", 'export const value = 42;'].join('\n')
    );
    writeFileSync(
      entry,
      [
        "import { value } from 'fake';",
        'export const __wywPreval = {',
        '  value: () => value,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what === 'fake') {
        return dep;
      }
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });

    const services = createServices(root, entry);
    const loadAndParse = services.loadAndParseFn;
    const loadedIds: string[] = [];
    services.loadAndParseFn = (nextServices, id, ...rest) => {
      loadedIds.push(id);
      return loadAndParse(nextServices, id, ...rest);
    };

    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(42);
    expect(loadedIds).toContain(dep);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('loads ESM children of broker-fallback barrels without synchronous require', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const nodeModulesDir = join(root, 'node_modules', 'barrel-package');
    const esmRoot = join(nodeModulesDir, 'lib');
    const cjsRoot = join(nodeModulesDir, 'lib-commonjs');
    const barrel = join(esmRoot, 'index.js');
    const child = join(esmRoot, 'child', 'index.js');

    mkdirSync(join(esmRoot, 'child'), { recursive: true });
    mkdirSync(cjsRoot, { recursive: true });
    writeFileSync(
      join(nodeModulesDir, 'package.json'),
      JSON.stringify({
        name: 'barrel-package',
        exports: {
          '.': {
            import: './lib/index.js',
            require: './lib-commonjs/index.js',
          },
        },
        main: './lib-commonjs/index.js',
      })
    );
    writeFileSync(
      barrel,
      [
        "export { value } from './child/index.js';",
        // Force the initial native load to fail so the runner falls back to
        // its broker path; the requested named export can still be proxied.
        "export { unsupported } from './unsupported.css';",
      ].join('\n')
    );
    writeFileSync(child, 'export const value = 42;\n');
    writeFileSync(join(esmRoot, 'unsupported.css'), '.unsupported {}\n');
    writeFileSync(
      join(cjsRoot, 'index.js'),
      'module.exports = { value: 42 };\n'
    );
    writeFileSync(
      entry,
      [
        "import { value } from 'barrel-package';",
        'export const __wywPreval = { value: () => value };',
      ].join('\n')
    );

    let broker: EvalBroker | undefined;
    try {
      const services = createServices(root, entry, {
        eval: { resolver: 'hybrid' },
      });
      const loadAndParse = services.loadAndParseFn;
      const loadedIds: string[] = [];
      services.loadAndParseFn = (nextServices, id, ...rest) => {
        loadedIds.push(id);
        return loadAndParse(nextServices, id, ...rest);
      };

      broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      const result = await broker.evaluate(entrypoint);

      expect(result.values?.get('value')).toBe(42);
      expect(loadedIds.map((id) => realpathSync(id))).toContain(
        realpathSync(barrel)
      );
    } finally {
      broker?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps dynamically assigned exports of a CommonJS external importable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const packageDir = join(root, 'node_modules', 'dyn-theme');

    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: 'dyn-theme', main: 'index.js' })
    );
    // cjs-module-lexer cannot see these names, so import()'s namespace only
    // carries `default` — the real module.exports has to be used instead.
    writeFileSync(
      join(packageDir, 'index.js'),
      [
        "const names = ['primaryColor'];",
        'names.forEach((name) => {',
        "  module.exports[name] = 'red';",
        '});',
        '',
      ].join('\n')
    );
    writeFileSync(
      entry,
      [
        "import { primaryColor } from 'dyn-theme';",
        'export const __wywPreval = { primaryColor: () => primaryColor };',
      ].join('\n')
    );

    let broker: EvalBroker | undefined;
    try {
      const services = createServices(root, entry, {
        eval: { resolver: 'hybrid' },
      });
      broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      const result = await broker.evaluate(entrypoint);

      expect(result.values?.get('primaryColor')).toBe('red');
    } finally {
      broker?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves bare external ids from the importing module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const packageDir = join(root, 'node_modules', 'external-theme');

    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: 'external-theme', main: 'index.js' })
    );
    writeFileSync(join(packageDir, 'index.js'), "exports.color = 'red';\n");
    writeFileSync(
      entry,
      [
        "import { color } from 'theme-alias';",
        'export const __wywPreval = { color: () => color };',
      ].join('\n')
    );

    const customResolver = jest.fn(async () => ({
      id: 'external-theme',
      external: true,
    }));
    let broker: EvalBroker | undefined;
    try {
      const services = createServices(root, entry, {
        eval: { customResolver, resolver: 'custom' },
      });
      broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      const result = await broker.evaluate(entrypoint);

      expect(result.values?.get('color')).toBe('red');
    } finally {
      broker?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still enforces eval.require for CommonJS externals reached by import', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const packageDir = join(root, 'node_modules', 'cjs-theme');

    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: 'cjs-theme', main: 'index.js' })
    );
    writeFileSync(join(packageDir, 'index.js'), "exports.color = 'red';\n");
    writeFileSync(
      entry,
      [
        "import { color } from 'cjs-theme';",
        'export const __wywPreval = { color: () => color };',
      ].join('\n')
    );

    let broker: EvalBroker | undefined;
    try {
      const services = createServices(root, entry, {
        eval: { resolver: 'hybrid', require: 'error' },
      });
      broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      await expect(broker.evaluate(entrypoint)).rejects.toThrow(
        /eval\.require='error'/
      );
    } finally {
      broker?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not apply eval.require policy to builtin imports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    writeFileSync(
      entry,
      [
        "import { basename } from 'node:path';",
        'export const __wywPreval = { value: () => basename("/tmp/file.txt") };',
      ].join('\n')
    );

    const customResolver = jest.fn(async (specifier: string) =>
      specifier === 'node:path' ? { id: 'node:path' } : null
    );
    let broker: EvalBroker | undefined;
    try {
      const services = createServices(root, entry, {
        eval: {
          customResolver,
          require: 'error',
          resolver: 'custom',
        },
      });
      broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      const result = await broker.evaluate(entrypoint);

      expect(result.values?.get('value')).toBe('file.txt');
    } finally {
      broker?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads direct node_modules asset imports through the broker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const nodeModulesDir = join(root, 'node_modules', 'fake');
    const css = join(nodeModulesDir, 'styles.css');

    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(css, '.fake { color: red; }');
    writeFileSync(
      entry,
      [
        "import cssUrl from 'fake/styles.css';",
        'export const __wywPreval = {',
        '  value: () => cssUrl,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what === 'fake/styles.css') {
        return css;
      }
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });

    const services = createServices(root, entry);
    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(css);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps CJS package entries on the external path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const nodeModulesDir = join(root, 'node_modules', 'fake');
    const dep = join(nodeModulesDir, 'index.js');

    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(dep, 'module.exports = { value: 42 };');
    writeFileSync(
      entry,
      [
        "import fake from 'fake';",
        'export const __wywPreval = {',
        '  value: () => fake.value,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what === 'fake') {
        return dep;
      }
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });

    const services = createServices(root, entry);
    const loadAndParse = services.loadAndParseFn;
    const loadedIds: string[] = [];
    services.loadAndParseFn = (nextServices, id, ...rest) => {
      loadedIds.push(id);
      return loadAndParse(nextServices, id, ...rest);
    };

    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(42);
    expect(loadedIds).not.toContain(dep);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not corrupt IPC when an external module logs to console', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const nodeModulesDir = join(root, 'node_modules', 'fake');
    const dep = join(nodeModulesDir, 'index.js');

    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(
      dep,
      [
        "console.log('hello from external');",
        'module.exports = { value: 42 };',
      ].join('\n')
    );
    writeFileSync(
      entry,
      [
        "const fake = require('fake');",
        'export const __wywPreval = {',
        '  value: () => fake.value,',
        '};',
      ].join('\n')
    );

    const warnings: string[] = [];
    const services = createServices(root, entry);
    services.emitWarning = (message) => warnings.push(message);

    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(42);
    expect(
      warnings.some((message) =>
        message.includes('[wyw-eval-runner] Failed to parse message:')
      )
    ).toBe(false);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('warns once when require fallback is used during eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const nodeModulesDir = join(root, 'node_modules', 'fake');
    const dep = join(nodeModulesDir, 'index.js');

    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(dep, 'module.exports = { value: 41 };');
    writeFileSync(
      entry,
      [
        "const fake = require('fake');",
        'export const __wywPreval = {',
        '  value: () => fake.value,',
        '};',
      ].join('\n')
    );

    const warnings: Array<{ code: string; specifier?: string }> = [];
    const services = createServices(root, entry, {
      eval: {
        require: 'warn-and-run',
        onWarn: (warning) => warnings.push(warning),
      },
    });

    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const first = await broker.evaluate(entrypoint);
    const second = await broker.evaluate(entrypoint);

    expect(first.values?.get('value')).toBe(41);
    expect(second.values?.get('value')).toBe(41);
    expect(warnings.filter((w) => w.code === 'require-fallback')).toHaveLength(
      1
    );
    expect(warnings[0].specifier).toBe('fake');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('suppresses require fallback warnings when importOverrides match', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const mock = join(root, 'mock.cjs');
    const nodeModulesDir = join(root, 'node_modules', 'fake');
    const dep = join(nodeModulesDir, 'index.js');

    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(dep, 'module.exports = { value: 41 };');
    writeFileSync(mock, 'module.exports = { value: 1 };');
    writeFileSync(
      entry,
      [
        "const fake = require('fake');",
        'export const __wywPreval = {',
        '  value: () => fake.value,',
        '};',
      ].join('\n')
    );

    const warnings: Array<{ code: string }> = [];
    const services = createServices(root, entry, {
      eval: {
        require: 'warn-and-run',
        onWarn: (warning) => warnings.push(warning),
      },
      importOverrides: {
        fake: {
          mock: './mock.cjs',
        },
      },
    });

    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(1);
    expect(warnings.filter((w) => w.code === 'require-fallback')).toHaveLength(
      0
    );

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('throws on non-literal require with strict eval errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');

    writeFileSync(
      entry,
      [
        "const name = 'fake';",
        'const fake = require(name);',
        'export const __wywPreval = {',
        '  value: () => fake?.value ?? 0,',
        '};',
      ].join('\n')
    );

    const services = createServices(root, entry, {
      eval: {
        errors: 'strict',
      },
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    await expect(broker.evaluate(entrypoint)).rejects.toThrow(
      'Non-literal require() is not supported during eval'
    );

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('collectModuleExports does not crash on TDZ exports from re-prepared modules', async () => {
    // Reproduces: ReferenceError: Cannot access 'X' before initialization
    //
    // Session 1: entry-a imports {space} from barrel. Barrel re-exports from
    // layout.js AND colors.js. colors.js → filter.js → generator.js → leaf.js.
    // leaf.js exports `const core = {...}`. The broker prepares leaf.js with
    // only:["core"]. The runner loads all modules, links, evaluates. leaf.js's
    // `core` is initialized. moduleOnly accumulates leaf.js.
    //
    // Session 2: entry-b imports {theme} from barrel. Barrel → theme.js →
    // generator.js (already cached). generator.js → leaf.js (already cached,
    // hash match → reuses SourceTextModule). But if the broker re-prepares
    // leaf.js with a wider only-set, resetSingleModuleState creates a NEW
    // SourceTextModule. This new module is linked into the current graph.
    // When evaluate() runs, all linked modules evaluate, including the new
    // leaf.js SourceTextModule. So `core` should be initialized.
    //
    // The TDZ crash happens when the runner caches a module that was linked but
    // whose parent's evaluation threw BEFORE the module itself was evaluated.
    // collectModuleExports then iterates moduleOnly and hits the TDZ binding.

    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    // leaf.js — deeply nested module with a const export
    writeFileSync(join(root, 'leaf.js'), 'export const core = { x: 1 };');

    // generator.js — imports leaf
    writeFileSync(
      join(root, 'generator.js'),
      "import { core } from './leaf.js';\nexport const gen = () => core;"
    );

    // broken.js — references an export that doesn't exist (link error)
    writeFileSync(
      join(root, 'broken.js'),
      "import { nonExistent } from './leaf.js';\nexport const value = nonExistent;"
    );

    // entry-a — imports generator (normal, succeeds)
    writeFileSync(
      join(root, 'entry-a.js'),
      [
        "import { gen } from './generator.js';",
        'export const __wywPreval = { v: () => gen().x };',
      ].join('\n')
    );

    // entry-b — imports broken (throws during eval, leaf.js may be linked but
    // not evaluated if the error propagates before the VM reaches it)
    writeFileSync(
      join(root, 'entry-b.js'),
      [
        "import { value } from './broken.js';",
        'export const __wywPreval = { v: () => value };',
      ].join('\n')
    );

    // entry-c — imports generator again (leaf.js cached from session 1,
    // but moduleOnly still has leaf.js from sessions 1+2)
    writeFileSync(
      join(root, 'entry-c.js'),
      [
        "import { gen } from './generator.js';",
        'export const __wywPreval = { v: () => gen().x };',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, join(root, 'entry-a.js'));
    const broker = new EvalBroker(services, asyncResolve);

    // Session 1: succeeds
    const epA = Entrypoint.createRoot(
      services,
      join(root, 'entry-a.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry-a.js'), 'utf-8')
    );
    const resultA = await broker.evaluate(epA);
    expect(resultA.values?.get('v')).toBe(1);

    // Session 2: broken.js throws — leaf.js may be linked but not evaluated
    const epB = Entrypoint.createRoot(
      services,
      join(root, 'entry-b.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry-b.js'), 'utf-8')
    );
    await expect(broker.evaluate(epB)).rejects.toThrow();

    // Session 3: should not crash on TDZ in collectModuleExports
    const epC = Entrypoint.createRoot(
      services,
      join(root, 'entry-c.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry-c.js'), 'utf-8')
    );
    const resultC = await broker.evaluate(epC);
    expect(resultC.values?.get('v')).toBe(1);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('collectModuleExports skips errored modules from prior failed eval sessions', async () => {
    // Reproduces: ReferenceError: Cannot access 'neutralCore' before initialization
    //
    // Mechanism: reuseModules=true keeps moduleOnly/moduleCache/moduleData across
    // eval sessions. If session N evaluates a module whose preamble runs (sets
    // moduleData) but whose body throws (const binding in TDZ, module "errored"),
    // the stale entry persists. Session N+1 evaluates a different entrypoint
    // successfully, then collectModuleExports iterates ALL moduleOnly entries.
    // Object.keys(namespace) on the "errored" module triggers TDZ.
    //
    // Fix: guard with `module.status !== 'evaluated'` in collectModuleExports.

    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    // thrower.js — preamble runs (moduleData created), then body throws.
    // The `core` binding stays in TDZ (never initialized).
    writeFileSync(
      join(root, 'thrower.js'),
      [
        'const boom = (() => { throw new Error("kaboom"); })();',
        'export const core = boom;',
      ].join('\n')
    );

    // entry-fail.js — imports thrower → evaluation fails
    writeFileSync(
      join(root, 'entry-fail.js'),
      [
        "import { core } from './thrower.js';",
        'export const __wywPreval = { v: () => core };',
      ].join('\n')
    );

    // entry-ok.js — no relation to thrower, evaluates fine
    writeFileSync(
      join(root, 'entry-ok.js'),
      'export const __wywPreval = { v: () => 42 };'
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, join(root, 'entry-fail.js'));
    const broker = new EvalBroker(services, asyncResolve);

    // Session 1: thrower.js's preamble runs → moduleData set.
    // thrower.js body throws → module status "errored", `core` in TDZ.
    // moduleOnly/moduleCache/moduleData all have thrower.js entries.
    const epFail = Entrypoint.createRoot(
      services,
      join(root, 'entry-fail.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry-fail.js'), 'utf-8')
    );
    await expect(broker.evaluate(epFail)).rejects.toThrow();

    // Session 2: different entrypoint succeeds. collectModuleExports must
    // NOT crash when iterating the stale thrower.js entry.
    const epOk = Entrypoint.createRoot(
      services,
      join(root, 'entry-ok.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry-ok.js'), 'utf-8')
    );
    const result = await broker.evaluate(epOk);
    expect(result.values?.get('v')).toBe(42);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('restarts failed module graphs without hiding the root error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    // thrower.js — body throws during evaluation
    writeFileSync(
      join(root, 'thrower.js'),
      [
        'const boom = (() => { throw new Error("kaboom"); })();',
        'export const value = boom;',
      ].join('\n')
    );

    // entry-fail.js — imports thrower → evaluation fails
    writeFileSync(
      join(root, 'entry-fail.js'),
      [
        "import { value } from './thrower.js';",
        'export const __wywPreval = { v: () => value };',
      ].join('\n')
    );

    // consumer.js — also imports thrower → will link-fail in session 2
    writeFileSync(
      join(root, 'consumer.js'),
      [
        "import { value } from './thrower.js';",
        'export const __wywPreval = { v: () => value };',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, join(root, 'entry-fail.js'));
    const broker = new EvalBroker(services, asyncResolve);

    // Session 1: thrower.js errors during evaluation
    const epFail = Entrypoint.createRoot(
      services,
      join(root, 'entry-fail.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry-fail.js'), 'utf-8')
    );
    await expect(broker.evaluate(epFail)).rejects.toThrow();

    // Session 2 starts with a fresh VM graph after the failed EVAL. The
    // original module error must still be surfaced directly.
    const epConsumer = Entrypoint.createRoot(
      services,
      join(root, 'consumer.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'consumer.js'), 'utf-8')
    );

    try {
      await broker.evaluate(epConsumer);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const error = err as Error;
      expect(error.message).toBe('kaboom');
      expect(error.stack).toContain('thrower.js');
    }

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('missing import surfaces specifier and importer, not opaque ERR_VM_MODULE_STATUS', async () => {
    // Reproduces: when an import temporarily points at a file that does not
    // exist on disk, webpack consumers see only:
    //   "Module status must be one of linked, evaluated, or errored"
    // with no indication of which import in which file is broken. The
    // diagnostic must name the missing specifier and the importing file so a
    // user can fix the import without bisecting the build.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    writeFileSync(
      join(root, 'entry.js'),
      [
        "import { value } from './missing-target.js';",
        'export const __wywPreval = { v: () => value };',
      ].join('\n')
    );

    // Resolver hands back an absolute path even though the file does not
    // exist — mirrors editor/watch state where the path is momentarily stale.
    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, join(root, 'entry.js'));
    const broker = new EvalBroker(services, asyncResolve);
    services.evalBroker = broker;

    const ep = Entrypoint.createRoot(
      services,
      join(root, 'entry.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry.js'), 'utf-8')
    );

    try {
      await broker.evaluate(ep);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const error = err as Error;
      expect(error.message).not.toMatch(
        /Module status must be one of linked, evaluated, or errored/
      );
      expect(error.message).toMatch(/missing-target\.js/);
      expect(error.message).toMatch(/entry\.js/);
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).toMatch(/missing-target\.js/);
    }

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('recovers after a transient missing import is fixed on disk', async () => {
    // Reproduces (B): once a module fails to load (ENOENT on a transient
    // missing import target), the runner caches the importer's
    // SourceTextModule in 'errored' state. On the next eval session — even
    // after the user creates the missing file — linkModule early-returns
    // because module.status !== 'unlinked', and module.evaluate() re-throws
    // the original link error. The build appears stuck despite a clean source
    // tree.
    //
    // Expected: a successful second session once the file exists.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    writeFileSync(
      join(root, 'entry.js'),
      [
        "import { value } from './target.js';",
        'export const __wywPreval = { v: () => value };',
      ].join('\n')
    );
    // target.js is intentionally missing for session 1.

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, join(root, 'entry.js'));
    const broker = new EvalBroker(services, asyncResolve);

    const ep1 = Entrypoint.createRoot(
      services,
      join(root, 'entry.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry.js'), 'utf-8')
    );
    await expect(broker.evaluate(ep1)).rejects.toThrow();

    // User creates the previously-missing file.
    writeFileSync(join(root, 'target.js'), 'export const value = 42;');

    const ep2 = createEntrypointAfterRecovery(services, () =>
      Entrypoint.createRoot(
        services,
        join(root, 'entry.js'),
        ['__wywPreval'],
        readFileSync(join(root, 'entry.js'), 'utf-8')
      )
    );
    const result = await broker.evaluate(ep2);
    expect(result.values?.get('v')).toBe(42);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('concurrent sibling dependencies importing different exports from same barrel succeed', async () => {
    // Reproduces: when two dependency modules concurrently link and both import
    // the same barrel file (for different named exports), the runner's loadInFlight
    // dedup causes the second importer to piggyback on the first's LOAD request.
    // If the broker hasn't merged both importers' needs into onlyByModule yet,
    // the barrel is prepared with a narrow only set → second importer's link fails
    // with "does not provide an export named 'X'".

    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    // Use a non-trivial re-export barrel so broker cannot promote it to
    // only:["*"] and accidentally mask narrow prepared code.
    writeFileSync(
      join(root, 'barrel.js'),
      [
        "export { fontWeight } from './typography.js';",
        "export { iconSize } from './layout.js';",
      ].join('\n')
    );
    writeFileSync(
      join(root, 'typography.js'),
      ['const base = 100;', 'export const fontWeight = base * 4;'].join('\n')
    );
    writeFileSync(
      join(root, 'layout.js'),
      ['const unit = 8;', 'export const iconSize = unit * 3;'].join('\n')
    );

    // consumer-a.js — uses fontWeight from barrel
    writeFileSync(
      join(root, 'consumer-a.js'),
      [
        "import { fontWeight } from './barrel.js';",
        'export const a = fontWeight;',
      ].join('\n')
    );

    // consumer-b.js — uses iconSize from barrel
    writeFileSync(
      join(root, 'consumer-b.js'),
      [
        "import { iconSize } from './barrel.js';",
        'export const b = iconSize;',
      ].join('\n')
    );

    // entry.js — imports both consumers, __wywPreval depends on both
    writeFileSync(
      join(root, 'entry.js'),
      [
        "import { a } from './consumer-a.js';",
        "import { b } from './consumer-b.js';",
        'export const __wywPreval = { a: () => a, b: () => b };',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, join(root, 'entry.js'));
    const broker = new EvalBroker(services, asyncResolve);

    const ep = Entrypoint.createRoot(
      services,
      join(root, 'entry.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry.js'), 'utf-8')
    );
    const result = await broker.evaluate(ep);
    expect(result.values?.get('a')).toBe(400);
    expect(result.values?.get('b')).toBe(24);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('nested sibling dependencies can widen a shared source module during link', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    writeFileSync(join(root, 'flag.js'), 'export const flag = 2;');
    writeFileSync(
      join(root, 'shared.js'),
      [
        "import { flag } from './flag.js';",
        'export const narrow = flag * 10;',
        'export const wide = flag * 20;',
      ].join('\n')
    );
    writeFileSync(
      join(root, 'direct.js'),
      [
        "import { narrow } from './shared.js';",
        'export const direct = narrow;',
      ].join('\n')
    );
    writeFileSync(
      join(root, 'nested.js'),
      [
        "import { wide } from './shared.js';",
        'export const nested = wide;',
      ].join('\n')
    );
    writeFileSync(
      join(root, 'parent.js'),
      [
        "import { direct } from './direct.js';",
        "import { nested } from './nested.js';",
        'export const parent = direct + nested;',
      ].join('\n')
    );
    writeFileSync(
      join(root, 'entry.js'),
      [
        "import { parent } from './parent.js';",
        'export const __wywPreval = { parent: () => parent };',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, join(root, 'entry.js'));
    const broker = new EvalBroker(services, asyncResolve);

    const ep = Entrypoint.createRoot(
      services,
      join(root, 'entry.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry.js'), 'utf-8')
    );
    const result = await broker.evaluate(ep);
    expect(result.values?.get('parent')).toBe(60);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('cross-session barrel widening: second session needing different exports re-prepares', async () => {
    // Reproduces stale-only issue across sessions with reuseModules.
    // Session 1: barrel prepared with only:["fontWeight"].
    // Session 2: different entrypoint needs iconSize from the same barrel.
    // The runner's resolveCache persists across sessions, so the broker may
    // not receive a fresh RESOLVE for the barrel. The broker must still
    // detect that the cached barrel is too narrow and re-prepare.

    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    // barrel.js — two exports
    writeFileSync(
      join(root, 'barrel.js'),
      ['export const fontWeight = 400;', 'export const iconSize = 24;'].join(
        '\n'
      )
    );

    // entry-a.js — only needs fontWeight
    writeFileSync(
      join(root, 'entry-a.js'),
      [
        "import { fontWeight } from './barrel.js';",
        'export const __wywPreval = { w: () => fontWeight };',
      ].join('\n')
    );

    // entry-b.js — needs iconSize (different export from barrel)
    writeFileSync(
      join(root, 'entry-b.js'),
      [
        "import { iconSize } from './barrel.js';",
        'export const __wywPreval = { s: () => iconSize };',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, join(root, 'entry-a.js'));
    const broker = new EvalBroker(services, asyncResolve);

    // Session 1: barrel gets prepared with only:["fontWeight"]
    const epA = Entrypoint.createRoot(
      services,
      join(root, 'entry-a.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry-a.js'), 'utf-8')
    );
    const resultA = await broker.evaluate(epA);
    expect(resultA.values?.get('w')).toBe(400);

    // Session 2: different entrypoint needs iconSize from the same barrel
    const epB = Entrypoint.createRoot(
      services,
      join(root, 'entry-b.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry-b.js'), 'utf-8')
    );
    const resultB = await broker.evaluate(epB);
    expect(resultB.values?.get('s')).toBe(24);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('reuses evaluated variant modules when broker sends narrow serialized exports', async () => {
    // Regression test for cache poisoning:
    //
    // Session 1 evaluates dep.js as a module variant (only includes __wywPreval,
    // so isFullModuleLoad is false). The variant has all exports (x, y).
    //
    // Session 2 only needs `x` from dep.js. The broker sends serialized exports
    // { x: ... } (narrow slice). The runner must NOT create a narrow
    // SyntheticModule — it should reuse the evaluated variant that has both x and y.
    //
    // Session 3 needs both x and y from dep.js. If the runner created a narrow
    // SyntheticModule in session 2 and returned it, session 3's link would fail
    // because the SyntheticModule doesn't have y. With the fix, the evaluated
    // variant is returned instead.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    const dep = join(root, 'dep.js');
    writeFileSync(dep, 'export const x = 10;\nexport const y = 20;\n');

    const barrel = join(root, 'barrel.js');
    writeFileSync(barrel, "export { x, y } from './dep.js';\n");

    // Session 1: imports both x and y → forces full eval of dep.js
    const entryA = join(root, 'entry-a.js');
    writeFileSync(
      entryA,
      [
        "import { x, y } from './barrel.js';",
        'export const __wywPreval = {',
        '  sum: () => x + y,',
        '};',
      ].join('\n')
    );

    // Session 2: imports only x → broker can serve serialized exports
    const entryB = join(root, 'entry-b.js');
    writeFileSync(
      entryB,
      [
        "import { x } from './barrel.js';",
        'export const __wywPreval = {',
        '  val: () => x,',
        '};',
      ].join('\n')
    );

    // Session 3: imports both x and y again → must not fail
    const entryC = join(root, 'entry-c.js');
    writeFileSync(
      entryC,
      [
        "import { x, y } from './barrel.js';",
        'export const __wywPreval = {',
        '  diff: () => y - x,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entryA);
    const broker = new EvalBroker(services, asyncResolve);

    const epA = Entrypoint.createRoot(
      services,
      entryA,
      ['__wywPreval'],
      readFileSync(entryA, 'utf-8')
    );
    const resultA = await broker.evaluate(epA);
    expect(resultA.values?.get('sum')).toBe(30);

    const epB = Entrypoint.createRoot(
      services,
      entryB,
      ['__wywPreval'],
      readFileSync(entryB, 'utf-8')
    );
    const resultB = await broker.evaluate(epB);
    expect(resultB.values?.get('val')).toBe(10);

    const epC = Entrypoint.createRoot(
      services,
      entryC,
      ['__wywPreval'],
      readFileSync(entryC, 'utf-8')
    );
    const resultC = await broker.evaluate(epC);
    expect(resultC.values?.get('diff')).toBe(10);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not create narrow SyntheticModule when barrel re-exports more than importer needs', async () => {
    // Reproduces the real-world failure: design-system.ts (barrel) re-exports
    // fontFamily+fontWeight+textStyles from typography.ts. Session A evaluates
    // the full chain. Session B's entrypoint only needs fontWeight+textStyles,
    // so the broker may serve serialized exports for typography with just those
    // 2 keys. But the barrel's SourceTextModule still has
    // `import { fontFamily, fontWeight, textStyles } from './typography.js'`
    // — it needs fontFamily too. If the runner creates a narrow SyntheticModule
    // for typography, the barrel's link fails.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    const typography = join(root, 'typography.js');
    writeFileSync(
      typography,
      [
        'export const fontFamily = "sans-serif";',
        'export const fontWeight = 400;',
        'export const textStyles = { body: "14px" };',
      ].join('\n')
    );

    const barrel = join(root, 'barrel.js');
    writeFileSync(
      barrel,
      [
        "export { fontFamily, fontWeight, textStyles } from './typography.js';",
        'export const layout = { gap: 8 };',
      ].join('\n')
    );

    // Session A: imports fontFamily + fontWeight + textStyles from barrel
    // → typography.js is prepared with all 3 exports, evaluated as variant
    const entryA = join(root, 'entry-a.js');
    writeFileSync(
      entryA,
      [
        "import { fontFamily, fontWeight, textStyles } from './barrel.js';",
        'export const __wywPreval = {',
        '  font: () => `${fontFamily} ${fontWeight} ${JSON.stringify(textStyles)}`,',
        '};',
      ].join('\n')
    );

    // Session B: imports only fontWeight + textStyles from barrel
    // → broker may serve serialized exports for typography (only fontWeight, textStyles)
    // → barrel's code still imports fontFamily from typography → must not fail
    const entryB = join(root, 'entry-b.js');
    writeFileSync(
      entryB,
      [
        "import { fontWeight, textStyles } from './barrel.js';",
        'export const __wywPreval = {',
        '  weight: () => fontWeight,',
        '};',
      ].join('\n')
    );

    // Session C: imports fontFamily again → must not fail
    const entryC = join(root, 'entry-c.js');
    writeFileSync(
      entryC,
      [
        "import { fontFamily, fontWeight } from './barrel.js';",
        'export const __wywPreval = {',
        '  info: () => `${fontFamily}/${fontWeight}`,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entryA, {
      eval: { strategy: 'hybrid' },
    });
    const broker = new EvalBroker(services, asyncResolve);

    const epA = Entrypoint.createRoot(
      services,
      entryA,
      ['__wywPreval'],
      readFileSync(entryA, 'utf-8')
    );
    const resultA = await broker.evaluate(epA);
    expect(resultA.values?.get('font')).toMatchInlineSnapshot(
      `"sans-serif 400 {"body":"14px"}"`
    );

    const epB = Entrypoint.createRoot(
      services,
      entryB,
      ['__wywPreval'],
      readFileSync(entryB, 'utf-8')
    );
    const resultB = await broker.evaluate(epB);
    expect(resultB.values?.get('weight')).toBe(400);

    const epC = Entrypoint.createRoot(
      services,
      entryC,
      ['__wywPreval'],
      readFileSync(entryC, 'utf-8')
    );
    const resultC = await broker.evaluate(epC);
    expect(resultC.values?.get('info')).toMatchInlineSnapshot(
      `"sans-serif/400"`
    );

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not reuse a narrower evaluated variant for wider serialized exports', async () => {
    // Mirrors the 4df6e915 Fibery dump:
    //
    // 1. typography.js is evaluated as a narrow variant with fontWeight only.
    // 2. typography.js is evaluated as a wider variant with fontFamily,
    //    fontWeight and textStyles.
    // 3. A later load gets serialized exports for that wider set, with a hash
    //    that is not itself cached as a SourceTextModule variant.
    //
    // The runner must not satisfy step 3 by returning the first evaluated
    // variant for the source path if that variant lacks the serialized export
    // set.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    const typography = join(root, 'typography.js');
    const entryNarrow = join(root, 'entry-narrow.js');
    const entryWide = join(root, 'entry-wide.js');
    const entrySerializedWide = join(root, 'entry-serialized-wide.js');

    writeFileSync(
      entryNarrow,
      [
        "import { fontWeight } from './typography.js';",
        'export const __wywPreval = {',
        '  value: () => fontWeight,',
        '};',
      ].join('\n')
    );
    writeFileSync(
      entryWide,
      [
        "import { fontFamily, fontWeight, textStyles } from './typography.js';",
        'export const __wywPreval = {',
        '  value: () => `${fontFamily}:${fontWeight}:${textStyles.body}`,',
        '};',
      ].join('\n')
    );
    writeFileSync(
      entrySerializedWide,
      [
        "import { fontFamily, fontWeight, textStyles } from './typography.js';",
        'export const __wywPreval = {',
        '  value: () => `${fontFamily}/${fontWeight}/${textStyles.body}`,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entryNarrow, {
      eval: { strategy: 'hybrid' },
    });
    const broker = new EvalBroker(services, asyncResolve);
    const privateBroker = getPrivateBroker(broker);
    const originalLoadModule = privateBroker.loadModule.bind(privateBroker);
    const loadCalls: Array<{
      id: string;
      importerId?: string | null;
      request?: string | null;
    }> = [];

    privateBroker.loadModule = jest.fn(async (payload) => {
      loadCalls.push(payload);

      const withImports = (
        id: string,
        result: {
          code: string;
          imports: Map<string, string[]> | null;
          only: string[];
          hash: string;
          exports?: Record<string, ReturnType<typeof serializeValue>>;
        }
      ) => {
        privateBroker.ensureImportsMapping(id, result.imports);
        return result;
      };

      if (payload.id === entryNarrow) {
        return withImports(entryNarrow, {
          code: readFileSync(entryNarrow, 'utf-8'),
          imports: new Map([['./typography.js', ['fontWeight']]]),
          only: ['__wywPreval'],
          hash: 'entry-narrow',
        });
      }

      if (payload.id === entryWide) {
        return withImports(entryWide, {
          code: readFileSync(entryWide, 'utf-8'),
          imports: new Map([
            ['./typography.js', ['fontFamily', 'fontWeight', 'textStyles']],
          ]),
          only: ['__wywPreval'],
          hash: 'entry-wide',
        });
      }

      if (payload.id === entrySerializedWide) {
        return withImports(entrySerializedWide, {
          code: readFileSync(entrySerializedWide, 'utf-8'),
          imports: new Map([
            ['./typography.js', ['fontFamily', 'fontWeight', 'textStyles']],
          ]),
          only: ['__wywPreval'],
          hash: 'entry-serialized-wide',
        });
      }

      if (payload.id === typography && payload.importerId === entryNarrow) {
        return withImports(typography, {
          code: 'export const fontWeight = 400;',
          imports: null,
          only: ['fontWeight'],
          hash: 'typography-narrow-font-weight',
        });
      }

      if (payload.id === typography && payload.importerId === entryWide) {
        return withImports(typography, {
          code: [
            'export const fontFamily = "Inter";',
            'export const fontWeight = 400;',
            'export const textStyles = { body: "14px" };',
          ].join('\n'),
          imports: null,
          only: ['fontFamily', 'fontWeight', 'textStyles'],
          hash: 'typography-wide-source',
        });
      }

      if (
        payload.id === typography &&
        payload.importerId === entrySerializedWide
      ) {
        return withImports(typography, {
          code: '',
          imports: null,
          only: ['fontFamily', 'fontWeight', 'textStyles'],
          hash: 'typography-wide-serialized-exports',
          exports: {
            fontFamily: serializeValue('Inter'),
            fontWeight: serializeValue(400),
            textStyles: serializeValue({ body: '14px' }),
          },
        });
      }

      return originalLoadModule(payload);
    });

    try {
      const narrow = Entrypoint.createRoot(
        services,
        entryNarrow,
        ['__wywPreval'],
        readFileSync(entryNarrow, 'utf-8')
      );
      const narrowResult = await broker.evaluate(narrow);
      expect(narrowResult.values?.get('value')).toBe(400);

      const wide = Entrypoint.createRoot(
        services,
        entryWide,
        ['__wywPreval'],
        readFileSync(entryWide, 'utf-8')
      );
      const wideResult = await broker.evaluate(wide);
      expect(wideResult.values?.get('value')).toBe('Inter:400:14px');

      const serializedWide = Entrypoint.createRoot(
        services,
        entrySerializedWide,
        ['__wywPreval'],
        readFileSync(entrySerializedWide, 'utf-8')
      );
      const serializedWideResult = await broker.evaluate(serializedWide);
      expect(serializedWideResult.values?.get('value')).toBe('Inter/400/14px');
      expect(loadCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: typography,
            importerId: entrySerializedWide,
          }),
        ])
      );
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps wide barrel dependency imports when a later narrow variant finishes', async () => {
    // Models the Fibery failure shape:
    //
    // - design-system.ts is a barrel that can be prepared as multiple variants.
    // - A wide variant imports fontFamily/fontWeight/textStyles from typography.
    // - A later narrow variant of the same source imports only fontWeight.
    // - Because importsByModule is keyed only by source path, the narrow map can
    //   replace the wide map while the wide SourceTextModule is still linking.
    // - When that wide module then loads typography, the dependency must still
    //   be prepared with the wide export set.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    const entry = join(root, 'entry.js');
    const barrel = join(root, 'design-system.js');
    const typography = join(root, 'typography.js');
    const theme = join(root, 'theme.js');

    writeFileSync(
      theme,
      [
        'export const themeVars = globalThis.__wywThemeVars || { text: "black" };',
      ].join('\n')
    );
    writeFileSync(
      typography,
      [
        "import { themeVars } from './theme.js';",
        'export const fontFamily = "Inter";',
        'export const fontWeight = 400;',
        'export const textStyles = { body: themeVars.text };',
      ].join('\n')
    );
    writeFileSync(
      barrel,
      [
        "export { fontFamily, fontWeight, textStyles } from './typography.js';",
      ].join('\n')
    );
    writeFileSync(
      entry,
      [
        "import { fontFamily, fontWeight, textStyles } from './design-system.js';",
        'export const __wywPreval = {',
        '  value: () => `${fontFamily}:${fontWeight}:${textStyles.body}`,',
        '};',
      ].join('\n')
    );

    const services = createServices(root, entry);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = getPrivateBroker(broker);

    privateBroker.importsByModule.set(
      entry,
      new Map([
        ['./design-system.js', ['fontFamily', 'fontWeight', 'textStyles']],
      ])
    );

    const wideBarrel = await privateBroker.loadModule({
      id: barrel,
      importerId: entry,
      request: './design-system.js',
    });

    expect(wideBarrel.imports?.get('./typography.js')).toEqual([
      'fontFamily',
      'fontWeight',
      'textStyles',
    ]);

    // Simulate a concurrent/narrow barrel variant completing after the wide
    // variant. Current code replaces the source-path import map with this
    // narrower map, which can make the still-linking wide variant load a
    // typography module that is missing fontFamily/textStyles.
    privateBroker.ensureImportsMapping(
      barrel,
      new Map([['./typography.js', ['fontWeight']]])
    );

    const typographyForWideBarrel = await privateBroker.loadModule({
      id: typography,
      importerId: barrel,
      request: './typography.js',
    });

    expect(typographyForWideBarrel.only).toEqual(
      expect.arrayContaining(['fontFamily', 'fontWeight', 'textStyles'])
    );
    expect(typographyForWideBarrel.code).toContain('fontFamily');
    expect(typographyForWideBarrel.code).toContain('textStyles');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('skips re-shipping LoadResult code when runner already has matching hash', async () => {
    // Multiple importers asking for the same dependency in one runner session
    // produce identical prepared variants (same hash, same `only`). The first
    // LOAD must ship code; subsequent LOADs must omit `code` entirely (not
    // ship `''` — that's a legitimate payload for a runtime-empty module) so
    // the runner's hash-match short-circuit (runner.js:1834) reuses its
    // cached SourceTextModule instead of re-parsing identical bytes.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importerA = join(root, 'a.js');
    const importerB = join(root, 'b.js');
    const dep = join(root, 'dep.js');

    const customLoader = jest.fn(async () => ({
      code: 'export const value = 1;',
    }));
    const services = createServices(root, importerA, {
      eval: { customLoader },
    });

    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
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
      onlyByModule: Map<string, string[]>;
      runnerInputQueue: unknown;
      sendMessage: (message: unknown) => Promise<void>;
    };

    type CapturedLoadResult = {
      id: string;
      payload: { code?: string; hash?: string; only?: string[] };
    };
    const captured: CapturedLoadResult[] = [];
    privateBroker.runnerInputQueue = {
      write: () => Promise.resolve(),
    };
    privateBroker.sendMessage = async (message: unknown) => {
      const m = message as { type: string } & CapturedLoadResult;
      if (m.type === 'LOAD_RESULT') {
        captured.push({ id: m.id, payload: m.payload });
      }
    };

    privateBroker.onlyByModule.set(dep, ['*']);

    await privateBroker.handleLoad('msg-1', {
      id: dep,
      importerId: importerA,
      request: null,
    });
    await privateBroker.handleLoad('msg-2', {
      id: dep,
      importerId: importerB,
      request: null,
    });

    expect(captured).toHaveLength(2);
    const [first, second] = captured;
    expect(first.payload.code).toBe('export const value = 1;');
    expect(first.payload.hash).toBeTruthy();
    expect(second.payload.code).toBeUndefined();
    expect(second.payload.hash).toBe(first.payload.hash);

    // Third LOAD with a wider `only` (forces a new prepared variant via the
    // loadCache miss path) must ship code again.
    const widerLoader = jest.fn(async () => ({
      code: 'export const value = 1;\nexport const extra = 2;',
    }));
    services.options.pluginOptions.eval = { customLoader: widerLoader };
    privateBroker.onlyByModule.set(dep, ['*', 'extra']);

    await privateBroker.handleLoad('msg-3', {
      id: dep,
      importerId: importerA,
      request: null,
    });

    expect(captured).toHaveLength(3);
    expect(captured[2].payload.code).toContain('extra');
    expect(captured[2].payload.hash).not.toBe(first.payload.hash);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not carry shipped-code coverage across different load hashes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    writeFileSync(entry, 'export const __wywPreval = {};');

    const services = createServices(root, entry);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
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
      runnerInputQueue: unknown;
      sendMessage: (message: unknown) => Promise<void>;
    };

    type CapturedLoadResult = {
      id: string;
      payload: { code?: string; hash?: string; only?: string[] };
    };
    const captured: CapturedLoadResult[] = [];
    privateBroker.runnerInputQueue = {
      write: () => Promise.resolve(),
    };
    privateBroker.sendMessage = async (message: unknown) => {
      const m = message as { type: string } & CapturedLoadResult;
      if (m.type === 'LOAD_RESULT') {
        captured.push({ id: m.id, payload: m.payload });
      }
    };

    privateBroker.loadModule = jest
      .fn()
      .mockResolvedValueOnce({
        code: 'export const first = 1;',
        imports: null,
        only: ['*'],
        hash: 'hash-a',
      })
      .mockResolvedValueOnce({
        code: 'export const value = 1;',
        imports: null,
        only: ['value'],
        hash: 'hash-b',
      })
      .mockResolvedValueOnce({
        code: 'export const value = 1;',
        imports: null,
        only: ['*'],
        hash: 'hash-b',
      });

    await privateBroker.handleLoad('msg-1', {
      id: dep,
      importerId: entry,
      request: null,
    });
    await privateBroker.handleLoad('msg-2', {
      id: dep,
      importerId: entry,
      request: null,
    });
    await privateBroker.handleLoad('msg-3', {
      id: dep,
      importerId: entry,
      request: null,
    });

    expect(captured).toHaveLength(3);
    expect(captured[0].payload.code).toContain('first');
    expect(captured[1].payload.code).toContain('value');
    // The second load stored hash-b as a module variant. The prior wildcard
    // coverage from hash-a must not make the broker believe hash-b also exists
    // in the runner's primary module cache.
    expect(captured[2].payload.code).toContain('value');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps shipped-code mirror across evaluate() boundaries with stable globals/happyDOM', async () => {
    // Real workflows reuse the runner across many entrypoints. The runner
    // only resets its moduleCache when globals or happyDOM change
    // (runner.js:2116). When those are stable, INIT just rebinds entrypoint
    // metadata and the runner keeps every cached module — so the broker's
    // shipped-code mirror must survive cross-entrypoint INITs.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entryA = join(root, 'a.js');
    const entryB = join(root, 'b.js');
    const dep = join(root, 'dep.js');
    writeFileSync(entryA, 'export const __wywPreval = {};');
    writeFileSync(entryB, 'export const __wywPreval = {};');

    const customLoader = jest.fn(async () => ({
      code: 'export const value = 1;',
    }));
    const services = createServices(root, entryA, {
      eval: { customLoader },
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = broker as unknown as {
      ensureRunner: () => Promise<void>;
      handleLoad: (
        id: string,
        payload: {
          id: string;
          importerId: string | null;
          request: string | null;
        }
      ) => Promise<void>;
      initRunner: (entrypoint: Entrypoint) => Promise<void>;
      lastInitKey: string | null;
      lastHappyDomEnabled: boolean;
      loadMirror: { snapshot: () => { entries: number } };
      onlyByModule: Map<string, string[]>;
      request: (
        type: string,
        payload: unknown,
        timeoutMs?: number
      ) => Promise<unknown>;
      runnerInputQueue: unknown;
      sendMessage: (message: unknown) => Promise<void>;
    };
    privateBroker.ensureRunner = jest.fn(async () => {});
    privateBroker.request = jest.fn(async () => ({}));

    type CapturedLoadResult = {
      id: string;
      payload: { code?: string; hash?: string };
    };
    const captured: CapturedLoadResult[] = [];
    privateBroker.runnerInputQueue = {
      write: () => Promise.resolve(),
    };
    privateBroker.sendMessage = async (message: unknown) => {
      const m = message as { type: string } & CapturedLoadResult;
      if (m.type === 'LOAD_RESULT') {
        captured.push({ id: m.id, payload: m.payload });
      }
    };

    privateBroker.onlyByModule.set(dep, ['*']);

    const entrypointA = Entrypoint.createRoot(
      services,
      entryA,
      ['__wywPreval'],
      readFileSync(entryA, 'utf-8')
    );
    const entrypointB = Entrypoint.createRoot(
      services,
      entryB,
      ['__wywPreval'],
      readFileSync(entryB, 'utf-8')
    );

    await privateBroker.initRunner(entrypointA);
    await privateBroker.handleLoad('msg-1', {
      id: dep,
      importerId: entryA,
      request: null,
    });

    // Switch to a different entrypoint — initKey changes but globals/happyDOM
    // are identical, so the runner keeps moduleCache and our mirror must too.
    await privateBroker.initRunner(entrypointB);
    expect(privateBroker.loadMirror.snapshot().entries).toBeGreaterThan(0);

    await privateBroker.handleLoad('msg-2', {
      id: dep,
      importerId: entryB,
      request: null,
    });

    expect(captured).toHaveLength(2);
    expect(captured[0].payload.code).toBe('export const value = 1;');
    expect(captured[1].payload.code).toBeUndefined();
    expect(captured[1].payload.hash).toBe(captured[0].payload.hash);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not reuse a semantic session after INIT fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    writeFileSync(entry, 'export const __wywPreval = {};');
    const services = createServices(root, entry);
    services.evalCacheKey = 'stable-semantics';
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = broker as unknown as {
      ensureRunner: jest.Mock<Promise<void>, []>;
      initRunner: jest.Mock<Promise<void>, [Entrypoint, boolean, object]>;
      loadCache: {
        has: (id: string) => boolean;
        set: (id: string, value: unknown) => void;
      };
      request: jest.Mock<Promise<unknown>, [string, unknown]>;
    };
    privateBroker.ensureRunner = jest.fn(async () => {});
    privateBroker.initRunner = jest
      .fn<Promise<void>, [Entrypoint, boolean, object]>()
      .mockRejectedValueOnce(new Error('init failed'))
      .mockResolvedValue(undefined);
    privateBroker.request = jest.fn(async () => ({ values: null }));
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf8')
    );

    try {
      await expect(broker.evaluate(entrypoint, services)).rejects.toThrow(
        'init failed'
      );
      privateBroker.loadCache.set('stale-from-failed-session', {});
      expect(privateBroker.loadCache.has('stale-from-failed-session')).toBe(
        true
      );
      await expect(broker.evaluate(entrypoint, services)).resolves.toEqual({
        dependencies: [],
        values: null,
      });
      expect(privateBroker.loadCache.has('stale-from-failed-session')).toBe(
        false
      );
      expect(
        privateBroker.initRunner.mock.calls.map(
          ([, reuseModules]) => reuseModules
        )
      ).toEqual([false, false]);
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resets a warm runner for the current rebuild and keeps later external retries fail-closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    const leaf = join(root, 'leaf.js');
    const entryCode = [
      "import { value } from './dep.js';",
      'export const __wywPreval = { value: () => value };',
    ].join('\n');
    const depCode = "export { value } from './leaf.js';";

    writeFileSync(entry, entryCode);
    writeFileSync(dep, depCode);
    writeFileSync(leaf, 'export const value = 1;');

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entry);
    const broker = new EvalBroker(services, asyncResolve);
    services.evalBroker = broker;
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      entryCode
    );
    entrypoint.setTransformResult({ code: entryCode, metadata: null });

    try {
      const initial = await broker.evaluate(entrypoint);
      expect(initial.values?.get('value')).toBe(1);

      asyncResolve.mockClear();
      const warm = await broker.evaluate(entrypoint);
      expect(warm.values?.get('value')).toBe(1);
      expect(asyncResolve).not.toHaveBeenCalled();

      // Evict a completed root so its full graph is retained, then remove the
      // dependency without a complete snapshot. The next root request is
      // fs-loaded (loadedCode is undefined), which must still inspect details
      // before construction and discover the unknown transitive graph.
      services.cache.delete('entrypoints', entry);

      // Simulate an eval-only entrypoint being evicted before the transform
      // pipeline could publish a complete dependency snapshot. Keep only the
      // fs hash so an unchanged dep.js cannot hide leaf.js behind one-shot
      // content verification.
      services.cache.add('entrypoints', dep, undefined as never);
      expect(
        services.cache.invalidateIfChanged(dep, depCode, undefined, 'fs')
      ).toBe(false);

      // The evaluated SourceTextModule is warm, so the second EVAL observes no
      // transitive LOAD/RESOLVE with which to reconstruct dep's missing graph.
      // The very first rebuild after a changed leaf must clear that runner;
      // waiting for the storm threshold would already permit stale output.
      writeFileSync(leaf, 'export const value = 2;');

      asyncResolve.mockClear();
      const rebuilt = createEntrypointAfterRecovery(services, () =>
        Entrypoint.createRoot(services, entry, ['__wywPreval'], undefined)
      );
      const refreshed = await broker.evaluate(rebuilt);

      expect(refreshed.values?.get('value')).toBe(2);
      expect(asyncResolve).toHaveBeenCalled();

      // Eval alone does not publish a complete transform graph. The scoped
      // recovery token permits only the current internal rebuild; a later
      // external request must re-arm fail-closed recovery rather than treating
      // that one pass as proof of convergence.
      const lifecycleBeforeRetry = services.cache.getLifecycleVersion();
      expect(() =>
        Entrypoint.createRoot(services, entry, ['__wywPreval'], undefined)
      ).toThrow(expect.objectContaining({ code: 'WYW_CACHE_EPOCH_ABORTED' }));
      expect(services.cache.getLifecycleVersion()).toBeGreaterThan(
        lifecycleBeforeRetry
      );
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('evaluate batching', () => {
    type BatchPrivateBroker = {
      ensureRunner: () => Promise<void>;
      initRunner: (entrypoint: Entrypoint) => Promise<void>;
      onlyByModule: Map<string, string[]>;
      pendingEvals: unknown[];
      request: (
        type: string,
        payload: unknown,
        timeoutMs?: number
      ) => Promise<unknown>;
    };

    const stubBatchInternals = (
      broker: EvalBroker,
      onEval: (id: string) => Promise<{
        values: Record<string, unknown> | null;
        modules?: Record<string, unknown>;
      }>
    ) => {
      const pb = broker as unknown as BatchPrivateBroker;
      pb.ensureRunner = jest.fn(async () => {});
      pb.initRunner = jest.fn(async () => {});
      pb.request = jest.fn(async (type, payload) => {
        if (type !== 'EVAL') {
          throw new Error(`unexpected request type: ${type}`);
        }
        const { id } = payload as { id: string };
        return onEval(id);
      });
      return pb;
    };

    it('coalesces concurrent evaluate() calls into one runner pass', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entries = ['a', 'b', 'c'].map((n) => join(root, `${n}.js`));
      entries.forEach((p) =>
        writeFileSync(p, 'export const __wywPreval = {};')
      );

      const services = createServices(root, entries[0]);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoints = entries.map((p) =>
        Entrypoint.createRoot(
          services,
          p,
          ['__wywPreval'],
          readFileSync(p, 'utf-8')
        )
      );

      const evalOrder: string[] = [];
      const onlySnapshots: Record<string, string[] | undefined> = {};
      const pb = stubBatchInternals(broker, async (id) => {
        evalOrder.push(id);
        // Capture the broker's onlyByModule for this entrypoint at the moment
        // EVAL is sent — proves per-entrypoint state-clear runs between
        // members of the batch.
        onlySnapshots[id] = pb.onlyByModule.get(id);
        return {
          values: { v: serializeValue(`from-${id}`, { allowFunctions: true }) },
        };
      });

      const initSpy = pb.initRunner as jest.Mock;
      const ensureSpy = pb.ensureRunner as jest.Mock;

      const promises = entrypoints.map((ep) => broker.evaluate(ep));
      const results = await Promise.all(promises);

      expect(evalOrder).toEqual(entries);
      results.forEach((r, i) => {
        expect(r.values?.get('v')).toBe(`from-${entries[i]}`);
      });
      entries.forEach((p) => {
        expect(onlySnapshots[p]).toEqual(['__wywPreval']);
      });
      // Each member revalidates the shared runner after claiming its active
      // cache generation. Warm checks are cheap and close inter-member resets.
      expect(ensureSpy).toHaveBeenCalledTimes(3);
      expect(initSpy).toHaveBeenCalledTimes(3);

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('rechecks the runner after an idle reset between batch members', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entryA = join(root, 'a.js');
      const entryB = join(root, 'b.js');
      const source = 'export const __wywPreval = {};';
      writeFileSync(entryA, source);
      writeFileSync(entryB, source);
      const servicesA = createServices(root, entryA);
      const servicesB = createServices(root, entryB);
      const broker = new EvalBroker(
        servicesA,
        jest.fn(async () => null)
      );
      const privateBroker = broker as unknown as {
        currentServices: ReturnType<typeof createServices>;
        ensureRunner: jest.Mock<Promise<void>, []>;
        flushEvalFileDebugLines: (lines?: unknown[]) => void;
        initRunner: jest.Mock<Promise<void>, [Entrypoint, boolean, object]>;
        request: jest.Mock<
          Promise<{ values: Record<string, unknown> }>,
          [string, { id: string }]
        >;
        runner: unknown;
        runnerInputQueue: { write: (payload: string) => Promise<void> } | null;
      };
      const spawnedRunners: Array<{
        kill: jest.Mock;
        removeAllListeners: jest.Mock;
      }> = [];
      privateBroker.ensureRunner = jest.fn(async () => {
        if (privateBroker.runner && privateBroker.runnerInputQueue) return;
        const runner = {
          kill: jest.fn(),
          removeAllListeners: jest.fn(),
        };
        spawnedRunners.push(runner);
        privateBroker.runner = runner;
        privateBroker.runnerInputQueue = { write: async () => {} };
      });
      privateBroker.initRunner = jest.fn(async () => {});
      privateBroker.request = jest.fn(async (_type, { id }) => {
        if (!privateBroker.runnerInputQueue) {
          throw new Error('Eval runner is not ready');
        }
        return {
          values: {
            value: serializeValue(id, { allowFunctions: true }),
          },
        };
      });
      const resetError = new Error('reset after cache A evaluation');
      let resetScheduled = false;
      privateBroker.flushEvalFileDebugLines = () => {
        if (resetScheduled || privateBroker.currentServices !== servicesA) {
          return;
        }
        resetScheduled = true;
        queueMicrotask(() => {
          const recovery = servicesA.cache.startSupersedeStormRecovery(
            resetError,
            entryA,
            servicesA.cacheEpoch
          );
          expect(recovery.started).toBe(true);
          recovery.complete();
        });
      };

      try {
        const entrypointA = Entrypoint.createRoot(
          servicesA,
          entryA,
          ['__wywPreval'],
          source
        );
        const entrypointB = Entrypoint.createRoot(
          servicesB,
          entryB,
          ['__wywPreval'],
          source
        );
        const [resultA, resultB] = await Promise.allSettled([
          broker.evaluate(entrypointA, servicesA),
          broker.evaluate(entrypointB, servicesB),
        ]);

        expect(resetScheduled).toBe(true);
        expect(resultA).toEqual({
          reason: expect.objectContaining({
            cause: resetError,
            code: 'WYW_CACHE_EPOCH_ABORTED',
          }),
          status: 'rejected',
        });
        expect(resultB.status).toBe('fulfilled');
        if (resultB.status === 'fulfilled') {
          expect(resultB.value.values?.get('value')).toBe(entryB);
        }
        expect(spawnedRunners).toHaveLength(2);
        expect(spawnedRunners[0].kill).toHaveBeenCalledTimes(1);
        expect(privateBroker.ensureRunner).toHaveBeenCalledTimes(2);
      } finally {
        broker.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('isolates batch-member failures', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entries = ['a', 'b', 'c'].map((n) => join(root, `${n}.js`));
      entries.forEach((p) =>
        writeFileSync(p, 'export const __wywPreval = {};')
      );

      const services = createServices(root, entries[0]);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoints = entries.map((p) =>
        Entrypoint.createRoot(
          services,
          p,
          ['__wywPreval'],
          readFileSync(p, 'utf-8')
        )
      );

      stubBatchInternals(broker, async (id) => {
        if (id === entries[1]) {
          throw new Error('middle-fail');
        }
        return { values: { v: serializeValue(id, { allowFunctions: true }) } };
      });

      const settled = await Promise.allSettled(
        entrypoints.map((ep) => broker.evaluate(ep))
      );
      expect(settled[0].status).toBe('fulfilled');
      expect(settled[1].status).toBe('rejected');
      expect(settled[2].status).toBe('fulfilled');
      if (settled[1].status === 'rejected') {
        expect(String(settled[1].reason)).toContain('middle-fail');
      }

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('does not publish module exports after an entrypoint is superseded during EVAL', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');
      const initialCode = 'export const __wywPreval = { value: 1 };';
      const replacementCode = 'export const __wywPreval = { value: 2 };';
      writeFileSync(entry, initialCode);

      const services = createServices(root, entry);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        initialCode
      );
      let replacement: Entrypoint | undefined;

      stubBatchInternals(broker, async () => {
        replacement = Entrypoint.createRoot(
          services,
          entry,
          ['__wywPreval'],
          replacementCode
        );
        return {
          modules: {
            [entry]: {
              stale: serializeValue('old-generation', {
                allowFunctions: true,
              }),
            },
          },
          values: {
            value: serializeValue(1, { allowFunctions: true }),
          },
        };
      });

      await expect(broker.evaluate(entrypoint)).rejects.toThrow('superseded');
      expect(replacement).toBeDefined();
      expect(Object.keys(replacement!.exports)).not.toContain('stale');

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('retires the cache epoch when publishing exports partially mutates a live target', () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');
      const dependency = join(root, 'dependency.js');
      const source = 'export const __wywPreval = {};';
      writeFileSync(entry, source);
      writeFileSync(dependency, 'export const first = 1;');

      const services = createServices(root, entry);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        source
      );
      const initialEpoch = services.cacheEpoch;
      const setterError = new Error('second export setter failed');
      const storedExports: Record<string, unknown> = {};
      const writes: string[] = [];
      const exportsProxy = new Proxy(storedExports, {
        set(target, key, value, receiver) {
          writes.push(String(key));
          if (key === 'second') {
            throw setterError;
          }
          return Reflect.set(target, key, value, receiver);
        },
      });
      const evaluatedTarget = {
        dependencies: new Map(),
        evaluated: true as const,
        evaluatedOnly: [],
        exports: exportsProxy,
        ignored: false as const,
      };
      services.cache.add('exports', dependency, ['first', 'second']);
      services.cache.add('entrypoints', dependency, evaluatedTarget as never);

      const privateBroker = getPrivateBroker(broker);
      let thrown: unknown;
      try {
        privateBroker.applyModuleExports(
          {
            [dependency]: {
              first: serializeValue(1, { allowFunctions: true }),
              second: serializeValue(2, { allowFunctions: true }),
            },
          },
          new Map([[dependency, evaluatedTarget]]),
          initialEpoch.owner,
          privateBroker.getCacheGeneration(initialEpoch.owner),
          entrypoint
        );
      } catch (error) {
        thrown = error;
      }

      expect(writes).toEqual(['first', 'second']);
      expect(storedExports).toEqual({ first: 1 });
      expect(thrown).toBe(services.cache.getEpochError(initialEpoch));
      expect(thrown).toEqual(
        expect.objectContaining({
          cause: setterError,
          code: 'WYW_CACHE_EPOCH_ABORTED',
          reason: 'evaluation-side-effect',
        })
      );
      expect(services.cache.getCurrentEpoch()).not.toBe(initialEpoch);
      expect(services.cache.get('entrypoints', dependency)).toBeUndefined();

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('single evaluate() call still runs (batch of one is a no-op)', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'a.js');
      writeFileSync(entry, 'export const __wywPreval = {};');

      const services = createServices(root, entry);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      stubBatchInternals(broker, async (id) => ({
        values: { v: serializeValue(id, { allowFunctions: true }) },
      }));

      const result = await broker.evaluate(entrypoint);
      expect(result.values?.get('v')).toBe(entry);

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });
  });
});
