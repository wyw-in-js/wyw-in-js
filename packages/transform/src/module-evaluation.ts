import { AsyncLocalStorage } from 'async_hooks';
import * as vm from 'vm';

import type { Debugger } from '@wyw-in-js/shared';

import type { TransformCacheCollection, TransformCacheEpoch } from './cache';
import { BaseEntrypoint } from './transform/BaseEntrypoint';
import { Entrypoint } from './transform/Entrypoint';
import type { IEvaluatedEntrypoint } from './transform/EvaluatedEntrypoint';
import { AbortError } from './transform/actions/AbortError';
import { isCacheEpochAbortedError } from './transform/actions/CacheEpochAbortedError';
import { isUnprocessedEntrypointError } from './transform/actions/UnprocessedEntrypointError';
import type { Services } from './transform/types';
import { stripQueryAndHash } from './utils/parseRequest';

const NOOP = () => {};
const TROUBLESHOOTING_URL = 'https://wyw-in-js.dev/troubleshooting';

export const buildModulePreamble = (id: string): string => {
  const payload = JSON.stringify(id);
  return [
    `const __wyw_module = __wyw_getModule(${payload});`,
    `let exports = __wyw_module.exports;`,
    `const module = __wyw_module.module;`,
    `const require = __wyw_module.require;`,
    `const __filename = __wyw_module.filename;`,
    `const __dirname = __wyw_module.dirname;`,
    `const __wyw_dynamic_import = __wyw_module.dynamicImport;`,
    ``,
  ].join('\n');
};

export const ensureVmModules = (): void => {
  if (!vm.SourceTextModule || !vm.SyntheticModule) {
    throw new EvalError(
      '[wyw-in-js] vm.SourceTextModule is not available in this runtime. ' +
        'WyW v2 uses a separate eval runner process for ESM evaluation.'
    );
  }
};

type EvaluationModuleData = {
  exports: Record<string | symbol, unknown>;
  module: { exports: Record<string | symbol, unknown> };
};

export type ModuleEvaluationHost = {
  readonly cache: TransformCacheCollection;
  readonly cacheEpoch: TransformCacheEpoch;
  readonly callstack: string[];
  readonly debug: Debugger;
  readonly dependencies: string[];
  readonly expectedEntrypointPublication:
    | Entrypoint
    | IEvaluatedEntrypoint
    | undefined;
  readonly filename: string;
  readonly ignored: boolean;
  readonly moduleImplIdentity: unknown;
  readonly parentModuleIdentity: unknown;
  readonly services: Services;
  assertCurrent(): void;
  ensureContext(filename: string): Promise<{ teardown: () => void }>;
  getEntrypoint(): Entrypoint;
  getExports(): Record<string | symbol, unknown>;
  getIsEvaluated(): boolean;
  getModuleData(id: string): EvaluationModuleData;
  getModuleForEntrypoint(
    entrypoint: Entrypoint | IEvaluatedEntrypoint
  ): Promise<vm.Module>;
  linkModule(module: vm.Module): Promise<void>;
  setExports(value: Record<string | symbol, unknown>): void;
  setIsEvaluated(value: boolean): void;
};

type ActiveEvaluationFlight = {
  cacheEpoch: TransformCacheEpoch;
  entrypoint: Entrypoint;
  host: ModuleEvaluationHost;
  ignored: boolean;
  leasePromotion: EvaluationLeasePromotion;
  moduleImplIdentity: unknown;
  parentModuleIdentity: unknown;
  promise: Promise<void>;
  services: Services;
  transformedCode: string | null;
};

const activeEvaluationFlights = new WeakMap<
  Entrypoint,
  Set<ActiveEvaluationFlight>
>();
const evaluatedEntrypointSources = new WeakMap<
  IEvaluatedEntrypoint,
  Entrypoint
>();

type EvaluationLeaseScope = {
  active: boolean;
  childTail: Promise<void>;
  epoch: TransformCacheEpoch;
  parent: EvaluationLeaseScope | null;
};

type ExplicitEvaluationLeaseBinding = {
  activeCalls: number;
  parent: ExplicitEvaluationLeaseBinding | undefined;
  scope: EvaluationLeaseScope;
};

const evaluationLeaseTails = new WeakMap<object, Promise<void>>();
const evaluationLeaseContext = (process.versions as { bun?: string }).bun
  ? null
  : new AsyncLocalStorage<EvaluationLeaseScope>();
const explicitEvaluationLeaseBindings = new WeakMap<
  TransformCacheEpoch,
  ExplicitEvaluationLeaseBinding
>();
const evaluationFlightsByLeaseScope = new WeakMap<
  EvaluationLeaseScope,
  ActiveEvaluationFlight
>();

type EvaluationLease = {
  release(): void;
  run<T>(callback: (scope: EvaluationLeaseScope) => Promise<T>): Promise<T>;
};

type EvaluationLeasePromotion = {
  request(scope: EvaluationLeaseScope): void;
  waitForRequest(
    afterRevision: number
  ): Promise<EvaluationLeasePromotionRequest>;
};

type EvaluationLeasePromotionRequest = {
  revision: number;
  scope: EvaluationLeaseScope;
};

const isStrictLeaseScopeDescendant = (
  scope: EvaluationLeaseScope,
  ancestor: EvaluationLeaseScope
): boolean => {
  let current = scope.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
};

const createEvaluationLeasePromotion = (): EvaluationLeasePromotion => {
  let latestRequest: EvaluationLeasePromotionRequest | null = null;
  let resolveNextRequest!: (request: EvaluationLeasePromotionRequest) => void;
  let nextRequest = new Promise<EvaluationLeasePromotionRequest>((resolve) => {
    resolveNextRequest = resolve;
  });

  return {
    request: (scope) => {
      if (!scope.active) return;
      const latestScope = latestRequest?.scope;
      if (
        latestScope?.active &&
        !isStrictLeaseScopeDescendant(scope, latestScope)
      ) {
        // Promotion may only move toward the active caller. An ancestor retry
        // must not pull a dependency back above the child that is awaiting it;
        // an active sibling is likewise not a safe causal parent. Both callers
        // can still join the same single-flight promise at its deepest request.
        return;
      }
      const request = {
        revision: (latestRequest?.revision ?? 0) + 1,
        scope,
      };
      latestRequest = request;
      resolveNextRequest(request);
      nextRequest = new Promise<EvaluationLeasePromotionRequest>((resolve) => {
        resolveNextRequest = resolve;
      });
    },
    waitForRequest: (afterRevision) =>
      latestRequest && latestRequest.revision > afterRevision
        ? Promise.resolve(latestRequest)
        : nextRequest,
  };
};

const getActiveEvaluationLeaseScope = (
  epoch: TransformCacheEpoch
): EvaluationLeaseScope | undefined => {
  const asyncScope = evaluationLeaseContext?.getStore();
  if (asyncScope?.active && asyncScope.epoch === epoch) {
    return asyncScope;
  }

  const explicitBinding = explicitEvaluationLeaseBindings.get(epoch);
  return explicitBinding?.activeCalls &&
    explicitBinding.scope.active &&
    explicitBinding.scope.epoch === epoch
    ? explicitBinding.scope
    : undefined;
};

const isFlightInLeaseAncestry = (
  scope: EvaluationLeaseScope,
  flight: ActiveEvaluationFlight
): boolean => {
  let current: EvaluationLeaseScope | null = scope;
  while (current) {
    if (evaluationFlightsByLeaseScope.get(current) === flight) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

const isEntrypointInLeaseAncestry = (
  scope: EvaluationLeaseScope,
  entrypoint: Entrypoint
): boolean => {
  let current: EvaluationLeaseScope | null = scope;
  while (current) {
    if (evaluationFlightsByLeaseScope.get(current)?.entrypoint === entrypoint) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

const createReentrantEvaluationCycleError = (filename: string): EvalError =>
  new EvalError(
    `[wyw-in-js] Reentrant Module.evaluate() cycle detected for ${filename}`
  );

const acquireEvaluationLease = (
  epoch: TransformCacheEpoch,
  explicitScope?: EvaluationLeaseScope,
  promotion?: EvaluationLeasePromotion,
  promotionRevision = 0
): EvaluationLease | Promise<EvaluationLease> => {
  const { owner } = epoch;
  const inheritedScope = explicitScope ?? evaluationLeaseContext?.getStore();
  const parentScope =
    inheritedScope?.active && inheritedScope.epoch === epoch
      ? inheritedScope
      : null;
  const topLevelPrevious = evaluationLeaseTails.get(epoch);
  const previous =
    parentScope?.childTail ?? topLevelPrevious ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.then(() => gate);
  if (parentScope) {
    parentScope.childTail = tail;
  } else {
    evaluationLeaseTails.set(epoch, tail);
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseGate();
    if (!parentScope) {
      tail.then(
        () => {
          if (evaluationLeaseTails.get(epoch) === tail) {
            evaluationLeaseTails.delete(epoch);
          }
        },
        () => {}
      );
    }
  };

  const abortAcquire = (error: unknown): never => {
    release();
    if (!parentScope && evaluationLeaseTails.get(epoch) === tail) {
      evaluationLeaseTails.delete(epoch);
    }
    throw error;
  };

  const lease: EvaluationLease = {
    release,
    run: (callback) => {
      const scope: EvaluationLeaseScope = {
        active: true,
        childTail: Promise.resolve(),
        epoch,
        parent: parentScope,
      };
      const execute = async () => {
        try {
          return await callback(scope);
        } finally {
          for (;;) {
            const { childTail } = scope;
            // eslint-disable-next-line no-await-in-loop
            await childTail;
            if (scope.childTail === childTail) break;
          }
          scope.active = false;
        }
      };

      // Bun 1.3 crashes when an AsyncLocalStorage scope spans
      // vm.SourceTextModule evaluation. Production Bun integrations delegate
      // evaluation to Node; direct callers propagate re-entry explicitly while
      // resolver and loader callbacks are active.
      return evaluationLeaseContext
        ? evaluationLeaseContext.run(scope, execute)
        : execute();
    },
  };

  // Preserve Module.evaluate()'s legacy synchronous publication timing when
  // there is no preceding top-level evaluator. Contended and nested callers
  // still cross the asynchronous FIFO barrier below.
  if (!parentScope && topLevelPrevious === undefined) {
    try {
      owner.assertEpoch(epoch);
      return lease;
    } catch (error) {
      return abortAcquire(error);
    }
  }

  return (async () => {
    let removeAbortListener = NOOP;
    try {
      const abortSignal = owner.getEpochAbortSignal(epoch);
      const epochAborted = new Promise<never>((_resolve, reject) => {
        const rejectWithEpochError = () => {
          reject(
            owner.getEpochError(epoch) ??
              new Error('[wyw-in-js] Transform cache epoch was invalidated')
          );
        };
        if (abortSignal.aborted) {
          rejectWithEpochError();
          return;
        }

        abortSignal.addEventListener('abort', rejectWithEpochError, {
          once: true,
        });
        removeAbortListener = () => {
          abortSignal.removeEventListener('abort', rejectWithEpochError);
        };
      });

      let promotedRequest: EvaluationLeasePromotionRequest | null = null;
      let observedPromotionRevision = promotionRevision;
      /* eslint-disable no-await-in-loop */
      for (;;) {
        const nextPromotion = promotion?.waitForRequest(
          observedPromotionRevision
        );
        const request = nextPromotion
          ? await Promise.race([
              previous.then(() => null),
              epochAborted,
              nextPromotion,
            ])
          : (await Promise.race([previous, epochAborted]), null);
        if (!request) break;
        observedPromotionRevision = request.revision;
        if (
          request.scope.active &&
          request.scope.epoch === epoch &&
          request.scope !== parentScope
        ) {
          promotedRequest = request;
          break;
        }
      }
      /* eslint-enable no-await-in-loop */
      if (promotedRequest) {
        // This top-level flight was queued behind the evaluation whose callback
        // is now awaiting it, or an already-promoted sibling is being awaited
        // by an earlier child. Remove the old queue gate, then re-enter under
        // the latest active caller. The revisioned promotion channel remains
        // attached so a queued child can be reparented more than once while the
        // shared single-flight promise keeps its identity.
        release();
        return await acquireEvaluationLease(
          epoch,
          promotedRequest.scope,
          promotion,
          promotedRequest.revision
        );
      }
      owner.assertEpoch(epoch);
      return lease;
    } catch (error) {
      return abortAcquire(error);
    } finally {
      removeAbortListener();
    }
  })();
};

const browserOnlyEvalHintTriggers = [
  'window is not defined',
  "evaluating 'window",
  'document is not defined',
  "evaluating 'document",
  'navigator is not defined',
  "evaluating 'navigator",
  'self is not defined',
  "evaluating 'self",
];

const getBrowserOnlyEvalHint = (error: unknown): string | null => {
  const message = error instanceof Error ? error.message : String(error);
  const looksLikeBrowserOnly = browserOnlyEvalHintTriggers.some((trigger) =>
    message.includes(trigger)
  );
  if (!looksLikeBrowserOnly) return null;

  return [
    '',
    '[wyw-in-js] Evaluation hint:',
    'This usually means browser-only code ran during build-time evaluation.',
    'Move browser-only initialization out of evaluated modules, or mock the import via `importOverrides`.',
    "Example: importOverrides: { 'msw/browser': { mock: './src/__mocks__/msw-browser.js' } }",
    `Docs: ${TROUBLESHOOTING_URL}`,
  ].join('\n');
};

const applyModuleNamespace = (
  entrypointExports: Record<string | symbol, unknown>,
  module: vm.Module,
  moduleData: EvaluationModuleData
): Record<string | symbol, unknown> => {
  const { namespace } = module;
  const keys = Object.keys(namespace);

  if (keys.length === 0 && moduleData.module.exports !== moduleData.exports) {
    return moduleData.module.exports;
  }

  const nextExports = entrypointExports;
  keys.forEach((key) => {
    nextExports[key] = (namespace as Record<string, unknown>)[key];
  });

  return nextExports;
};

export class ModuleEvaluation {
  private evaluationEntrypoints = new Map<
    Entrypoint | IEvaluatedEntrypoint,
    string
  >();

  private evaluationLeaseScope: EvaluationLeaseScope | null = null;

  private evaluationMayHaveSideEffects = false;

  private evaluationPromise: Promise<void> | null = null;

  private evaluationFlight: ActiveEvaluationFlight | null = null;

  private evaluationTransaction: object | null = null;

  constructor(private readonly host: ModuleEvaluationHost) {}

  evaluate(): Promise<void> {
    try {
      this.host.assertCurrent();
    } catch (error) {
      return Promise.reject(error);
    }

    if (this.evaluationPromise) {
      const activeScope = getActiveEvaluationLeaseScope(this.host.cacheEpoch);
      if (
        activeScope &&
        this.evaluationFlight &&
        isEntrypointInLeaseAncestry(
          activeScope,
          this.evaluationFlight.entrypoint
        )
      ) {
        return Promise.reject(
          createReentrantEvaluationCycleError(this.host.filename)
        );
      }
      return this.evaluationPromise;
    }

    if (this.host.getIsEvaluated()) {
      return Promise.resolve();
    }

    const entrypoint = this.host.getEntrypoint();
    const { transformedCode } = entrypoint;
    const activeScope = getActiveEvaluationLeaseScope(this.host.cacheEpoch);
    if (activeScope && isEntrypointInLeaseAncestry(activeScope, entrypoint)) {
      return Promise.reject(
        createReentrantEvaluationCycleError(this.host.filename)
      );
    }
    const activeFlights = activeEvaluationFlights.get(entrypoint);
    const expectedMatchesSource =
      this.host.expectedEntrypointPublication === undefined ||
      this.host.expectedEntrypointPublication === entrypoint ||
      evaluatedEntrypointSources.get(
        this.host.expectedEntrypointPublication as IEvaluatedEntrypoint
      ) === entrypoint;
    const activeFlight = activeFlights
      ? [...activeFlights].find(
          (flight) =>
            expectedMatchesSource &&
            flight.cacheEpoch === this.host.cacheEpoch &&
            flight.ignored === this.host.ignored &&
            flight.moduleImplIdentity === this.host.moduleImplIdentity &&
            flight.parentModuleIdentity === this.host.parentModuleIdentity &&
            flight.services === this.host.services &&
            flight.transformedCode === transformedCode
        )
      : undefined;
    if (activeFlight) {
      if (activeScope) {
        if (isFlightInLeaseAncestry(activeScope, activeFlight)) {
          return Promise.reject(
            createReentrantEvaluationCycleError(this.host.filename)
          );
        }
        activeFlight.leasePromotion.request(activeScope);
      }
      activeFlight.promise.then(
        () => {
          this.host.dependencies.splice(
            0,
            this.host.dependencies.length,
            ...activeFlight.host.dependencies
          );
          this.host.setIsEvaluated(true);
        },
        () => {}
      );
      return activeFlight.promise;
    }

    // Publish the single-flight promise before evaluation starts, then enter
    // evaluateOnce synchronously. The synchronous prefix preserves the legacy
    // cache-publication timing while the pre-published promise closes re-entry
    // from lifecycle callbacks during provisional entrypoint creation.
    let resolveEvaluation!: () => void;
    let rejectEvaluation!: (error: unknown) => void;
    const evaluation = new Promise<void>((resolve, reject) => {
      resolveEvaluation = resolve;
      rejectEvaluation = reject;
    });
    this.evaluationPromise = evaluation;
    const leasePromotion = createEvaluationLeasePromotion();
    const flight: ActiveEvaluationFlight = {
      cacheEpoch: this.host.cacheEpoch,
      entrypoint,
      host: this.host,
      ignored: this.host.ignored,
      leasePromotion,
      moduleImplIdentity: this.host.moduleImplIdentity,
      parentModuleIdentity: this.host.parentModuleIdentity,
      promise: evaluation,
      services: this.host.services,
      transformedCode,
    };
    this.evaluationFlight = flight;
    const flights = activeFlights ?? new Set<ActiveEvaluationFlight>();
    flights.add(flight);
    activeEvaluationFlights.set(entrypoint, flights);
    this.evaluateOnce(flight).then(resolveEvaluation, rejectEvaluation);
    const clearFlight = () => {
      flights.delete(flight);
      if (flights.size === 0) activeEvaluationFlights.delete(entrypoint);
    };
    evaluation.then(
      () => {
        clearFlight();
        if (this.evaluationPromise === evaluation) {
          this.evaluationPromise = null;
        }
        if (this.evaluationFlight === flight) {
          this.evaluationFlight = null;
        }
      },
      () => {
        clearFlight();
        if (this.evaluationPromise === evaluation) {
          this.evaluationPromise = null;
        }
        if (this.evaluationFlight === flight) {
          this.evaluationFlight = null;
        }
      }
    );
    return evaluation;
  }

  getTransaction(): object | null {
    return this.evaluationTransaction;
  }

  markEntrypointMayHaveSideEffects(): void {
    this.evaluationMayHaveSideEffects = true;
  }

  trackEntrypoint(
    entrypoint: Entrypoint | IEvaluatedEntrypoint,
    name: string
  ): void {
    this.evaluationEntrypoints.set(entrypoint, name);
  }

  runInLeaseContext<T>(callback: () => Promise<T>): Promise<T> {
    const scope = this.evaluationLeaseScope;
    if (!scope) return callback();
    if (evaluationLeaseContext) {
      return evaluationLeaseContext.run(scope, callback);
    }

    // Bun cannot carry AsyncLocalStorage through vm.SourceTextModule without
    // crashing. Bind explicitly to the cache epoch (the lease identity), so an
    // extension callback can re-enter through a different Services object that
    // participates in the same transaction. Without a safe causal async context,
    // overlapping direct-Bun callbacks in one epoch are deliberately treated as
    // nested and same-entrypoint overlap fails closed; the binding is removed as
    // soon as the callback settles, so a later retry is unaffected.
    const current = explicitEvaluationLeaseBindings.get(scope.epoch);
    const binding =
      current?.scope === scope
        ? current
        : {
            activeCalls: 0,
            parent: current,
            scope,
          };
    binding.activeCalls += 1;
    explicitEvaluationLeaseBindings.set(scope.epoch, binding);

    const releaseBinding = () => {
      binding.activeCalls -= 1;
      if (
        binding.activeCalls !== 0 ||
        explicitEvaluationLeaseBindings.get(scope.epoch) !== binding
      ) {
        return;
      }

      let { parent } = binding;
      while (parent?.activeCalls === 0) parent = parent.parent;
      if (parent) {
        explicitEvaluationLeaseBindings.set(scope.epoch, parent);
      } else {
        explicitEvaluationLeaseBindings.delete(scope.epoch);
      }
    };

    let result: Promise<T>;
    try {
      result = callback();
    } catch (error) {
      releaseBinding();
      throw error;
    }
    return Promise.resolve(result).finally(releaseBinding);
  }

  assertTransaction(transaction: object): void {
    if (this.evaluationTransaction !== transaction) {
      throw new AbortError('evaluation completed');
    }
    this.host.assertCurrent();
  }

  assertImportCurrent(
    importer: Entrypoint | IEvaluatedEntrypoint,
    transaction?: object
  ): void {
    if (transaction) this.assertTransaction(transaction);
    this.assertImporterCurrent(importer);
  }

  assertImporterCurrent(importer: Entrypoint | IEvaluatedEntrypoint): void {
    this.host.assertCurrent();
    if (importer instanceof Entrypoint) {
      importer.assertCurrentCacheEpoch();
      importer.assertNotSuperseded();
      return;
    }

    this.assertEvaluatedEpoch(importer);
    if (
      this.host.cache.get('entrypoints', this.getEntrypointName(importer)) !==
      importer
    ) {
      throw new AbortError('superseded');
    }
  }

  getEntrypointName(entrypoint: Entrypoint | IEvaluatedEntrypoint): string {
    if (entrypoint instanceof BaseEntrypoint) return entrypoint.name;
    const { name } = entrypoint;
    if (typeof name !== 'string') {
      throw new EvalError(
        '[wyw-in-js] Evaluated entrypoints must expose a string name'
      );
    }
    this.host.assertCurrent();
    if (this.host.cache.get('entrypoints', name) !== entrypoint) {
      throw new AbortError('superseded');
    }
    return name;
  }

  requireTransaction(): object {
    const transaction = this.evaluationTransaction;
    if (!transaction) throw new AbortError('evaluation completed');
    return transaction;
  }

  private async evaluateOnce(flight: ActiveEvaluationFlight): Promise<void> {
    const entrypoint = this.host.getEntrypoint();
    const expectedMatchesSource =
      this.host.expectedEntrypointPublication === undefined ||
      this.host.expectedEntrypointPublication === entrypoint ||
      evaluatedEntrypointSources.get(
        this.host.expectedEntrypointPublication as IEvaluatedEntrypoint
      ) === entrypoint;
    this.host.assertCurrent();
    entrypoint.assertTransformed();
    const { cache, cacheEpoch } = this.host;
    cache.assertEpoch(cacheEpoch);
    let cached: Entrypoint | IEvaluatedEntrypoint | undefined;
    let evaluatedEntrypoint: IEvaluatedEntrypoint | null = null;
    let expectedPublished: Entrypoint | IEvaluatedEntrypoint | undefined;
    const assertEvaluationCurrent = () => {
      cache.assertEpoch(cacheEpoch);
      entrypoint.assertCurrentCacheEpoch();
      entrypoint.assertNotSuperseded();
      if (cache.get('entrypoints', entrypoint.name) !== expectedPublished) {
        throw new AbortError('superseded');
      }
    };
    const assertEvaluationGraphCurrent = () => {
      assertEvaluationCurrent();
      this.evaluationEntrypoints.forEach((name, exporter) => {
        if (exporter instanceof Entrypoint) {
          exporter.assertCurrentCacheEpoch();
          exporter.assertNotSuperseded();
        } else {
          this.assertEvaluatedEpoch(exporter);
        }
        if (cache.get('entrypoints', name) !== exporter) {
          throw new AbortError('superseded');
        }
      });
    };
    const teardownRef: { current: (() => void) | null } = { current: null };
    const explicitScope = getActiveEvaluationLeaseScope(cacheEpoch);
    const acquiredLease = acquireEvaluationLease(
      cacheEpoch,
      explicitScope,
      flight.leasePromotion
    );
    const evaluationLease =
      acquiredLease instanceof Promise ? await acquiredLease : acquiredLease;
    let sideEffectRecoveryError: Error | undefined;
    try {
      await evaluationLease.run(async (scope) => {
        this.evaluationLeaseScope = scope;
        evaluationFlightsByLeaseScope.set(scope, flight);
        this.evaluationMayHaveSideEffects = false;
        this.evaluationEntrypoints.clear();
        this.host.assertCurrent();
        cached = cache.get('entrypoints', entrypoint.name);
        const isSameSourcePublication =
          expectedMatchesSource &&
          cached !== undefined &&
          evaluatedEntrypointSources.get(cached as IEvaluatedEntrypoint) ===
            entrypoint;
        if (
          !isSameSourcePublication &&
          (cached !== this.host.expectedEntrypointPublication ||
            (cached !== undefined && cached !== entrypoint))
        ) {
          throw new AbortError('superseded');
        }

        if (!entrypoint.supersededWith) {
          const created = entrypoint.createEvaluated(this.host.services);
          evaluatedEntrypointSources.set(created, entrypoint);
          entrypoint.assertNotSuperseded();
          if (
            !cache.replacePublished<
              'entrypoints',
              Entrypoint | IEvaluatedEntrypoint
            >(cacheEpoch, 'entrypoints', entrypoint.name, cached, created)
          ) {
            entrypoint.assertNotSuperseded();
            throw new AbortError('superseded');
          }
          evaluatedEntrypoint = created;
        }

        expectedPublished = evaluatedEntrypoint ?? cached;

        const { transformedCode: source } = entrypoint;
        if (!source) {
          this.host.debug(`evaluate`, 'there is nothing to evaluate');
          assertEvaluationCurrent();
          this.host.setIsEvaluated(true);
          return;
        }

        if (this.host.getIsEvaluated()) {
          this.host.debug('evaluate', `is already evaluated`);
          assertEvaluationCurrent();
          return;
        }

        this.host.debug('evaluate');
        this.host.debug.extend('source')('%s', source);

        this.host.setIsEvaluated(true);
        this.evaluationTransaction = {};

        const filename = stripQueryAndHash(this.host.filename);

        if (/\.json$/.test(filename)) {
          // JSON.parse itself is isolated; assigning module.exports is the
          // first operation that can mutate the live entrypoint state.
          const parsed = JSON.parse(source) as Record<string | symbol, unknown>;
          assertEvaluationCurrent();
          this.evaluationMayHaveSideEffects = true;
          this.host.setExports(parsed);
          assertEvaluationGraphCurrent();
          return;
        }

        const contextResult = await this.host.ensureContext(filename);
        teardownRef.current = contextResult.teardown;
        assertEvaluationCurrent();

        // JavaScript exports keep their real object and closure identities.
        // The cache-wide lease serializes independent evaluations. Once the
        // VM starts (or linking inspects a live cached export), a failure must
        // retire the full epoch so no mutated alias remains cache-reachable.
        const module = await this.host.getModuleForEntrypoint(entrypoint);
        assertEvaluationCurrent();
        await this.host.linkModule(module);
        assertEvaluationCurrent();
        this.evaluationMayHaveSideEffects = true;
        await module.evaluate();
        assertEvaluationCurrent();
        const exports = applyModuleNamespace(
          this.host.getExports(),
          module,
          this.host.getModuleData(entrypoint.name)
        );
        if (exports !== this.host.getExports()) {
          this.host.setExports(exports);
        }
        assertEvaluationGraphCurrent();
      });
    } catch (e) {
      this.host.setIsEvaluated(false);
      this.evaluationTransaction = null;
      if (this.evaluationMayHaveSideEffects) {
        const cause = e instanceof Error ? e : new Error(String(e));
        const recovery = cache.startEvaluationSideEffectRecovery(
          cause,
          cacheEpoch,
          this.host.services.cacheRecoveryOwner
        );
        sideEffectRecoveryError = recovery.abortError;
        recovery.complete();
        this.evaluationEntrypoints.clear();
      } else {
        if (evaluatedEntrypoint) {
          cache.replacePublished<
            'entrypoints',
            Entrypoint | IEvaluatedEntrypoint
          >(
            cacheEpoch,
            'entrypoints',
            entrypoint.name,
            evaluatedEntrypoint,
            cached
          );
        }
        this.evaluationEntrypoints.clear();

        // A foreign source owner can retire without changing the target
        // cache's epoch. Remove that exact stale publication, but keep every
        // unrelated target-cache entry and preserve the source owner's exact
        // control error.
        try {
          entrypoint.assertCurrentCacheEpoch();
        } catch (error) {
          if (
            entrypoint.cacheEpoch.owner !== cacheEpoch.owner &&
            cache.get('entrypoints', entrypoint.name) === cached
          ) {
            cache.replacePublished(
              cacheEpoch,
              'entrypoints',
              entrypoint.name,
              cached,
              undefined
            );
          }
          throw error;
        }
        entrypoint.assertNotSuperseded();
        cache.assertEpoch(cacheEpoch);
      }

      if (isUnprocessedEntrypointError(e)) {
        // It will be handled by evalFile scenario
        throw e;
      }

      if (e instanceof AbortError) {
        // Supersede after the VM may have mutated live exports retires the
        // entire attempt. Surface that owned epoch error so transform() can
        // retry from the replacement epoch instead of leaking a raw abort.
        throw sideEffectRecoveryError ?? e;
      }

      if (e instanceof EvalError) {
        this.host.debug('%O', e);

        throw e;
      }

      if (isCacheEpochAbortedError(e)) {
        throw e;
      }

      this.host.debug('%O\n%O', e, this.host.callstack);
      const baseMessage = `${(e as Error).message} in${this.host.callstack.join(
        '\n| '
      )}\n`;
      const hint = getBrowserOnlyEvalHint(e);

      throw new EvalError(hint ? `${baseMessage}${hint}\n` : baseMessage);
    } finally {
      try {
        teardownRef.current?.();
      } finally {
        const leaseScope = this.evaluationLeaseScope;
        if (
          leaseScope &&
          evaluationFlightsByLeaseScope.get(leaseScope) === flight
        ) {
          evaluationFlightsByLeaseScope.delete(leaseScope);
        }
        evaluationLease.release();
        this.evaluationLeaseScope = null;
        this.evaluationTransaction = null;
      }
    }
  }

  private assertEvaluatedEpoch(entrypoint: IEvaluatedEntrypoint): void {
    this.host.assertCurrent();
    if (entrypoint instanceof BaseEntrypoint) {
      entrypoint.cacheEpoch.owner.assertEpoch(entrypoint.cacheEpoch);
      return;
    }
    // cacheEpoch was added after IEvaluatedEntrypoint became public. Read it
    // when present, but keep structural implementations and accessors valid.
    // The surrounding live-export boundary plus publication checks make a
    // reentrant getter fail closed without imposing descriptor requirements.
    const epoch = (
      entrypoint as IEvaluatedEntrypoint & {
        cacheEpoch?: TransformCacheEpoch;
      }
    ).cacheEpoch;
    if (epoch) epoch.owner.assertEpoch(epoch);
  }
}
