import fs from 'node:fs';
import { invariant } from 'ts-invariant';

import type { ParentEntrypoint, ITransformFileResult } from '../types';

import { getActionContextOwners } from './ActionContext';
import { BaseEntrypoint } from './BaseEntrypoint';
import { isSuperSet, mergeOnly } from './Entrypoint.helpers';
import type {
  IEntrypointCode,
  IEntrypointDependency,
  IIgnoredEntrypoint,
  IPreevalResult,
} from './Entrypoint.types';
import { EvaluatedEntrypoint } from './EvaluatedEntrypoint';
import { AbortError } from './actions/AbortError';
import type { ActionByType } from './actions/BaseAction';
import { BaseAction } from './actions/BaseAction';
import { UnprocessedEntrypointError } from './actions/UnprocessedEntrypointError';
import type { Services, ActionTypes, ActionQueueItem } from './types';
import { stripQueryAndHash } from '../utils/parseRequest';
import { recordPipelineEntrypoint } from '../debug/pipelineTelemetry';

const EMPTY_FILE = '=== empty file ===';
const DEFAULT_ACTION_CONTEXT = Symbol('defaultActionContext');

// Guards against supersede storms: an oscillating cache invalidation can
// re-create the same entrypoint with a non-widening `only` on every root
// request, looping until the process OOMs. An unknown graph gives us no proof
// that cached dependency output is safe, so the bounded fallback fails loudly
// instead of returning a stale entrypoint.
const SUPERSEDE_STORM_WINDOW_MS = 10_000;
const SUPERSEDE_STORM_LIMIT = 100;

const createSupersedeStormError = (name: string) =>
  Object.assign(
    new Error(
      `[wyw-in-js] Supersede storm detected for ${name}: more than ${SUPERSEDE_STORM_LIMIT} non-widening invalidations within ${SUPERSEDE_STORM_WINDOW_MS}ms. ` +
        'The dependency graph did not converge, so the transform was stopped instead of returning potentially stale output.'
    ),
    {
      code: 'WYW_SUPERSEDE_STORM',
      name: 'SupersedeStormError',
    }
  );

interface ISupersedeWindow {
  blocked?: {
    error: Error;
    sourceCode: string;
  };
  resetVersion: number;
  seenAt: number[];
  lastSeenAt: number;
}

interface ISupersedeTracker {
  byName: Map<string, ISupersedeWindow>;
  lastSweepAt: number;
}

// Keyed by the cache collection so parallel builds and tests don't share
// windows. The per-cache map is swept after a quiet window so a long-lived dev
// server does not retain names that stopped invalidating.
const supersedeWindowsByCache = new WeakMap<object, ISupersedeTracker>();

function getSupersedeTracker(services: Services, now: number) {
  let tracker = supersedeWindowsByCache.get(services.cache);
  if (!tracker) {
    tracker = { byName: new Map(), lastSweepAt: now };
    supersedeWindowsByCache.set(services.cache, tracker);
    return tracker;
  }

  if (now < tracker.lastSweepAt) {
    // Date.now can move backwards when the system clock is adjusted. Old
    // timestamps cannot participate in a meaningful rate window afterwards.
    tracker.byName.clear();
    tracker.lastSweepAt = now;
    return tracker;
  }

  if (now - tracker.lastSweepAt >= SUPERSEDE_STORM_WINDOW_MS) {
    const cutoff = now - SUPERSEDE_STORM_WINDOW_MS;
    for (const [name, window] of tracker.byName) {
      if (window.lastSeenAt <= cutoff) {
        tracker.byName.delete(name);
      }
    }
    tracker.lastSweepAt = now;
  }

  return tracker;
}

function resetSupersedeWindow(services: Services, name: string): void {
  supersedeWindowsByCache.get(services.cache)?.byName.delete(name);
}

function getBlockedSupersedeError(
  services: Services,
  name: string,
  currentCode: string | undefined
): Error | null {
  const now = Date.now();
  const tracker = getSupersedeTracker(services, now);
  const window = tracker.byName.get(name);
  if (!window?.blocked) {
    return null;
  }

  if (window.resetVersion !== services.cache.getResetVersion()) {
    tracker.byName.delete(name);
    return null;
  }

  if (currentCode !== undefined && currentCode !== window.blocked.sourceCode) {
    tracker.byName.delete(name);
    return null;
  }

  // Repeated attempts are activity, not a quiet interval. Preserve the exact
  // diagnostic object so every retry of unchanged input fails consistently.
  window.lastSeenAt = now;
  return window.blocked.error;
}

function blockSupersedeWindow(
  services: Services,
  name: string,
  sourceCode: string,
  error: Error
): void {
  const now = Date.now();
  const tracker = getSupersedeTracker(services, now);
  const window = tracker.byName.get(name) ?? {
    resetVersion: services.cache.getResetVersion(),
    seenAt: [],
    lastSeenAt: now,
  };
  window.blocked = { error, sourceCode };
  window.resetVersion = services.cache.getResetVersion();
  window.lastSeenAt = now;
  tracker.byName.set(name, window);
}

function recordNonWideningSupersede(services: Services, name: string): number {
  const now = Date.now();
  const tracker = getSupersedeTracker(services, now);
  let window = tracker.byName.get(name);
  if (
    !window ||
    now < window.lastSeenAt ||
    window.resetVersion !== services.cache.getResetVersion()
  ) {
    window = {
      resetVersion: services.cache.getResetVersion(),
      seenAt: [],
      lastSeenAt: now,
    };
    tracker.byName.set(name, window);
  }

  const cutoff = now - SUPERSEDE_STORM_WINDOW_MS;
  window.seenAt = window.seenAt.filter((seenAt) => seenAt > cutoff);
  window.seenAt.push(now);
  window.lastSeenAt = now;

  // A caller may catch the diagnostic and retry. Keep enough timestamps to
  // preserve the over-limit state without letting that retry loop grow this
  // bookkeeping array itself.
  if (window.seenAt.length > SUPERSEDE_STORM_LIMIT + 1) {
    window.seenAt.splice(0, window.seenAt.length - (SUPERSEDE_STORM_LIMIT + 1));
  }

  return window.seenAt.length;
}

type CreateEntrypointOptions = {
  graphTraversalToken?: object;
  mergeCachedOnly?: boolean;
};

function hasLoop(
  name: string,
  parent: ParentEntrypoint,
  processed: string[] = []
): boolean {
  if (parent.name === name || processed.includes(parent.name)) {
    return true;
  }

  for (const p of parent.parents) {
    const found = hasLoop(name, p, [...processed, parent.name]);
    if (found) {
      return found;
    }
  }

  return false;
}

export class Entrypoint extends BaseEntrypoint {
  public readonly evaluated = false;

  public readonly loadedAndParsed: IEntrypointCode | IIgnoredEntrypoint;

  protected onSupersedeHandlers: Array<(newEntrypoint: Entrypoint) => void> =
    [];

  private actionsCache: Map<
    ActionTypes,
    Map<unknown, Map<unknown, WeakMap<Services, BaseAction<ActionQueueItem>>>>
  > = new Map();

  // Tracks how many times resolveImports has settled with `resolved: null`
  // for a given source. Bundler resolvers can return null transiently early
  // in a build (loader context for that file isn't registered yet); after a
  // bounded number of retries we accept the null as authoritative.
  #resolveTaskNullAttempts = new Map<string, number>();

  private static readonly RESOLVE_TASK_MAX_NULL_ATTEMPTS = 2;

  #hasWywMetadata: boolean = false;

  #hasTransformResult = false;

  #isProcessing = false;

  #processingStarted = false;

  #invalidationError: Error | null = null;

  readonly #cacheLifecycleVersion: number;

  #pendingOnly: string[] | null = null;

  #preevalResult: IPreevalResult | null = null;

  #processingPromise: Promise<void> | null = null;

  #resolveProcessing: (() => void) | null = null;

  #supersededWith: Entrypoint | null = null;

  #transformResultCode: string | null = null;

  private constructor(
    services: Services,
    parents: ParentEntrypoint[],
    public readonly initialCode: string | undefined,
    name: string,
    only: string[],
    exports: Record<string | symbol, unknown> | undefined,
    evaluatedOnly: string[],
    loadedAndParsed?: IEntrypointCode | IIgnoredEntrypoint,
    protected readonly resolveTasks = new Map<
      string,
      Promise<IEntrypointDependency>
    >(),
    readonly dependencies = new Map<string, IEntrypointDependency>(),
    readonly invalidationDependencies = new Map<
      string,
      IEntrypointDependency
    >(),
    readonly invalidateOnDependencyChange = new Set<string>(),
    generation = 1,
    private readonly skipCacheInvalidation = false,
    private readonly unknownGraphTraversalToken: object = {}
  ) {
    super(
      services,
      evaluatedOnly,
      exports,
      generation,
      name,
      only,
      parents,
      dependencies,
      invalidationDependencies,
      invalidateOnDependencyChange
    );

    this.#cacheLifecycleVersion = services.cache.getLifecycleVersion();

    this.loadedAndParsed =
      loadedAndParsed ??
      services.loadAndParseFn(
        services,
        name,
        initialCode,
        parents[0]?.log ?? services.log
      );

    if (
      !this.skipCacheInvalidation &&
      this.loadedAndParsed.code !== undefined
    ) {
      services.cache.invalidateIfChanged(
        name,
        this.loadedAndParsed.code,
        undefined,
        this.initialCode === undefined ? 'fs' : 'loaded'
      );
    }

    const code =
      this.loadedAndParsed.evaluator === 'ignored'
        ? '[IGNORED]'
        : this.originalCode || EMPTY_FILE;

    this.log.extend('source')('created %s (%o)\n%s', name, only, code);
  }

  public get ignored() {
    return this.loadedAndParsed.evaluator === 'ignored';
  }

  public get originalCode() {
    return this.loadedAndParsed.code;
  }

  public get supersededWith(): Entrypoint | null {
    return this.#supersededWith?.supersededWith ?? this.#supersededWith;
  }

  public get transformedCode(): string | null {
    return (
      this.#transformResultCode ?? this.supersededWith?.transformedCode ?? null
    );
  }

  public get transformed(): boolean {
    return (
      this.#hasTransformResult || this.supersededWith?.transformed || false
    );
  }

  public get isProcessing(): boolean {
    return this.#isProcessing;
  }

  /**
   * Whether processEntrypoint has ever started on this generation. Stays true
   * after processing ends. False for an analysis root that only resolved
   * imports (static preeval, barrel rewriting) and was never processed.
   */
  public get processingStarted(): boolean {
    return this.#processingStarted;
  }

  private get invalidationError(): Error | null {
    return (
      this.#invalidationError ??
      this.services.cache.getLifecycleError(this.#cacheLifecycleVersion) ??
      this.services.cache.getGraphTraversalTokenError(
        this.unknownGraphTraversalToken
      ) ??
      this.#supersededWith?.invalidationError ??
      null
    );
  }

  public get cacheLifecycleVersion(): number {
    return this.#cacheLifecycleVersion;
  }

  public get graphTraversalToken(): object {
    return this.unknownGraphTraversalToken;
  }

  public static createRoot(
    services: Services,
    name: string,
    only: string[],
    loadedCode: string | undefined,
    options: CreateEntrypointOptions = {}
  ): Entrypoint {
    const created = Entrypoint.create(
      services,
      null,
      name,
      only,
      loadedCode,
      options
    );
    invariant(created !== 'loop', 'loop detected');

    return created;
  }

  protected static create(
    services: Services,
    parent: ParentEntrypoint | null,
    name: string,
    only: string[],
    loadedCode: string | undefined,
    options: CreateEntrypointOptions = {}
  ): Entrypoint | 'loop' {
    const { cache, eventEmitter } = services;
    return eventEmitter.perf('createEntrypoint', () => {
      const [status, entrypoint] = Entrypoint.innerCreate(
        services,
        parent
          ? {
              evaluated: parent.evaluated,
              log: parent.log,
              name: parent.name,
              parents: parent.parents,
              seqId: parent.seqId,
            }
          : null,
        name,
        only,
        loadedCode,
        options
      );

      recordPipelineEntrypoint(
        parent === null,
        loadedCode !== undefined,
        status,
        entrypoint.only
      );

      if (status !== 'cached') {
        cache.add('entrypoints', name, entrypoint);
      }

      return status === 'loop' ? 'loop' : entrypoint;
    });
  }

  private static innerCreate(
    services: Services,
    parent: ParentEntrypoint | null,
    name: string,
    only: string[],
    loadedCode: string | undefined,
    options: CreateEntrypointOptions
  ): ['loop' | 'created' | 'cached', Entrypoint] {
    const { cache } = services;

    const cached = cache.get('entrypoints', name);
    let graphTraversalToken =
      options.graphTraversalToken ?? cache.createGraphTraversalToken();
    let changed = false;
    let currentCode = loadedCode;
    let unknownDependencyGraphs = new Set<string>();
    if (loadedCode !== undefined) {
      ({ changed, unknownDependencyGraphs } =
        cache.invalidateIfChangedWithDetails(
          name,
          loadedCode,
          'loaded',
          options.graphTraversalToken
        ));
    } else {
      try {
        currentCode = fs.readFileSync(stripQueryAndHash(name), 'utf8');
      } catch {
        changed = false;
      }

      if (currentCode !== undefined) {
        ({ changed, unknownDependencyGraphs } =
          cache.invalidateIfChangedWithDetails(
            name,
            currentCode,
            'fs',
            options.graphTraversalToken
          ));
      }
    }

    const blockedError = getBlockedSupersedeError(services, name, currentCode);
    if (blockedError) {
      throw blockedError;
    }

    const recoveredFromUnknownGraph = unknownDependencyGraphs.size > 0;
    if (recoveredFromUnknownGraph) {
      changed = true;
      graphTraversalToken = {};
      const recoveryError = cache.beginUnknownGraphRecovery(
        name,
        unknownDependencyGraphs,
        currentCode!,
        graphTraversalToken
      );
      services.evalBroker?.resetAfterCacheInvalidation(
        cache,
        recoveryError,
        'unknown-dependency-graph'
      );
    }

    if (!recoveredFromUnknownGraph && !cached?.evaluated && cached?.ignored) {
      return ['cached', cached];
    }

    // A root without bundler code (an analysis root, on-demand eval
    // preparation) targets a file the bundler may already have handed over.
    // loadAndParse re-parses that loaded code instead of the bytes on disk, so
    // the new generation must carry it as loaded code as well: hashed as the
    // disk content it would report a change, evict the cached generation and
    // forget its dependency snapshot on every such root.
    const reusableEntrypoint =
      loadedCode === undefined ? cache.get('entrypoints', name) : undefined;
    const entrypointCode =
      loadedCode ??
      (typeof reusableEntrypoint?.initialCode === 'string'
        ? reusableEntrypoint.initialCode
        : undefined);

    const exports = recoveredFromUnknownGraph ? undefined : cached?.exports;
    const evaluatedOnly =
      changed || recoveredFromUnknownGraph ? [] : cached?.evaluatedOnly ?? [];
    const mergedOnly =
      !recoveredFromUnknownGraph &&
      options.mergeCachedOnly !== false &&
      cached?.only
        ? mergeOnly(cached.only, only)
        : [...only];
    const reusableEvaluatedState =
      !recoveredFromUnknownGraph &&
      !changed &&
      cached?.evaluated &&
      cached.loadedAndParsed !== undefined;
    const canReuseEvaluatedTransformResult =
      reusableEvaluatedState &&
      isSuperSet(cached.evaluatedOnly, mergedOnly) &&
      cached.hasTransformResult &&
      cached.loadedAndParsed !== undefined;

    if (cached?.evaluated) {
      cached.log('is already evaluated with', cached.evaluatedOnly);
    }

    if (canReuseEvaluatedTransformResult) {
      const isLoop = parent && hasLoop(name, parent);
      const reusedEntrypoint = new Entrypoint(
        services,
        parent ? [parent] : [],
        entrypointCode,
        name,
        mergedOnly,
        exports,
        evaluatedOnly,
        cached.loadedAndParsed,
        undefined,
        cached.dependencies,
        cached.invalidationDependencies,
        cached.invalidateOnDependencyChange,
        cached.generation + 1,
        true,
        graphTraversalToken
      );

      reusedEntrypoint.reuseTransformResult(
        cached.transformResultCode,
        cached.hasWywMetadata
      );
      if (
        'preevalResult' in cached &&
        cached.preevalResult !== null &&
        cached.preevalResult !== undefined
      ) {
        reusedEntrypoint.setPreevalResult(cached.preevalResult);
      }

      return [isLoop ? 'loop' : 'cached', reusedEntrypoint];
    }

    if (!recoveredFromUnknownGraph && !changed && cached && !cached.evaluated) {
      const isLoop = parent && hasLoop(name, parent);
      if (isLoop) {
        parent.log('[createEntrypoint] %s is a loop', name);
      }

      if (parent && !cached.parents.map((p) => p.name).includes(parent.name)) {
        cached.parents.push(parent);
      }

      if (isSuperSet(cached.only, mergedOnly)) {
        cached.log('is cached', name);
        return [isLoop ? 'loop' : 'cached', cached];
      }

      cached.log(
        'is cached, but with different `only` %o (the cached one %o)',
        only,
        cached?.only
      );

      if (cached.#isProcessing) {
        if (parent === null) {
          cached.log(
            'is being processed during root request, supersede immediately (%o -> %o)',
            cached.only,
            mergedOnly
          );
          return [
            isLoop ? 'loop' : 'created',
            cached.supersede(mergedOnly, services),
          ];
        }

        cached.deferOnlySupersede(mergedOnly);
        cached.log(
          'is being processed, defer supersede (%o -> %o)',
          cached.only,
          mergedOnly
        );
        return [isLoop ? 'loop' : 'cached', cached];
      }

      return [
        isLoop ? 'loop' : 'created',
        cached.supersede(mergedOnly, services),
      ];
    }

    if (cached) {
      const cachedCode =
        cached.initialCode === undefined
          ? cached.loadedAndParsed?.code
          : cached.initialCode;
      const requestedCodeIsUnchanged =
        currentCode !== undefined && currentCode === cachedCode;

      if (!requestedCodeIsUnchanged) {
        // A real source edit starts a new lineage. It must supersede normally,
        // regardless of how much invalidation traffic preceded it.
        resetSupersedeWindow(services, name);
      } else if (!cached.evaluated && isSuperSet(cached.only, mergedOnly)) {
        const count = recordNonWideningSupersede(services, name);
        if (count > SUPERSEDE_STORM_LIMIT) {
          const error = createSupersedeStormError(name);
          cached.failInvalidation(error);
          cache.beginSupersedeStormRecovery(error);
          blockSupersedeWindow(services, name, currentCode!, error);
          services.evalBroker?.resetAfterCacheInvalidation(
            cache,
            error,
            'supersede-storm'
          );
          throw error;
        }
      }
    }

    const newEntrypoint = new Entrypoint(
      services,
      parent ? [parent] : [],
      entrypointCode,
      name,
      mergedOnly,
      exports,
      evaluatedOnly,
      reusableEvaluatedState ? cached.loadedAndParsed : undefined,
      !recoveredFromUnknownGraph && cached && 'resolveTasks' in cached
        ? cached.resolveTasks
        : undefined,
      !recoveredFromUnknownGraph && cached && 'dependencies' in cached
        ? cached.dependencies
        : undefined,
      !recoveredFromUnknownGraph &&
      cached &&
      'invalidationDependencies' in cached
        ? cached.invalidationDependencies
        : undefined,
      !recoveredFromUnknownGraph &&
      cached &&
      'invalidateOnDependencyChange' in cached
        ? cached.invalidateOnDependencyChange
        : undefined,
      cached ? cached.generation + 1 : 1,
      false,
      graphTraversalToken
    );

    if (
      reusableEvaluatedState &&
      'preevalResult' in cached &&
      cached.preevalResult !== null &&
      cached.preevalResult !== undefined
    ) {
      newEntrypoint.setPreevalResult(cached.preevalResult);
    }

    if (cached && !cached.evaluated) {
      cached.log('is cached, but with different code');
      cached.supersede(newEntrypoint, services);
    }

    return ['created', newEntrypoint];
  }

  public addDependency(dependency: IEntrypointDependency): void {
    this.resolveTasks.delete(dependency.source);
    this.dependencies.set(dependency.source, dependency);
  }

  public addInvalidationDependency(dependency: IEntrypointDependency): void {
    this.resolveTasks.delete(dependency.source);
    this.invalidationDependencies.set(dependency.source, dependency);
  }

  public addResolveTask(
    name: string,
    dependency: Promise<IEntrypointDependency>
  ): void {
    // Bounded retry of transient null resolutions. The first time a
    // resolveTask settles to null, evict it from the cache so the next
    // consumer re-attempts the resolver. After RESOLVE_TASK_MAX_NULL_ATTEMPTS
    // failures the entry stays cached so we don't thrash. Successful (non-null)
    // resolutions remain cached normally; this branch only ever fires for null.
    const tracked = dependency.then((resolved) => {
      if (resolved.resolved !== null) {
        return resolved;
      }

      const attempts = (this.#resolveTaskNullAttempts.get(name) ?? 0) + 1;
      this.#resolveTaskNullAttempts.set(name, attempts);
      if (
        attempts < Entrypoint.RESOLVE_TASK_MAX_NULL_ATTEMPTS &&
        this.resolveTasks.get(name) === tracked
      ) {
        this.resolveTasks.delete(name);
      }

      return resolved;
    });
    this.resolveTasks.set(name, tracked);
  }

  public applyDeferredSupersede(services: Services = this.services) {
    if (this.#supersededWith || this.#pendingOnly === null) {
      return null;
    }

    const mergedOnly = mergeOnly(this.only, this.#pendingOnly);
    this.#pendingOnly = null;

    if (isSuperSet(this.only, mergedOnly)) {
      return null;
    }

    this.log('apply deferred supersede (%o -> %o)', this.only, mergedOnly);

    const nextEntrypoint = this.supersede(mergedOnly, services);
    services.cache.add('entrypoints', this.name, nextEntrypoint);

    return nextEntrypoint;
  }

  public assertNotSuperseded() {
    const { invalidationError } = this;
    if (invalidationError) {
      throw invalidationError;
    }

    if (this.supersededWith) {
      this.log('superseded');
      throw new AbortError('superseded');
    }
  }

  public assertTransformed() {
    const { invalidationError } = this;
    if (invalidationError) {
      throw invalidationError;
    }

    if (this.transformedCode === null) {
      this.log('not transformed');
      throw new UnprocessedEntrypointError(this.supersededWith ?? this);
    }
  }

  public beginProcessing() {
    this.#isProcessing = true;
    this.#processingStarted = true;
    if (!this.#processingPromise) {
      this.#processingPromise = new Promise<void>((resolve) => {
        this.#resolveProcessing = resolve;
      });
    }
  }

  public createAction<
    TType extends ActionTypes,
    TAction extends ActionByType<TType>,
  >(
    actionType: TType,
    data: TAction['data'],
    abortSignal: AbortSignal | null = null,
    actionContext: unknown = DEFAULT_ACTION_CONTEXT,
    services: Services = this.services
  ): BaseAction<TAction> {
    const actionContextOwners = getActionContextOwners(actionContext);
    if (actionContextOwners && !actionContextOwners.has(this)) {
      actionContextOwners.set(this, () => this.clearActions(actionContext));
    }

    if (!this.actionsCache.has(actionType)) {
      this.actionsCache.set(actionType, new Map());
    }

    const contexts = this.actionsCache.get(actionType)!;
    if (!contexts.has(actionContext)) {
      contexts.set(actionContext, new Map());
    }

    const cache = contexts.get(actionContext)!;
    if (!cache.has(data)) {
      cache.set(data, new WeakMap());
    }

    const serviceScopes = cache.get(data)!;
    const cached = serviceScopes.get(services);
    if (cached && !cached.abortSignal?.aborted) {
      return cached as BaseAction<TAction>;
    }

    const newAction = new BaseAction<TAction>(
      actionType as TAction['type'],
      services,
      this,
      data,
      abortSignal,
      actionContext
    );

    serviceScopes.set(services, newAction);

    services.eventEmitter.entrypointEvent(this.seqId, {
      type: 'actionCreated',
      actionType,
      actionIdx: newAction.idx,
    });

    return newAction;
  }

  private clearActions(actionContext: unknown): void {
    this.actionsCache.forEach((contexts, actionType) => {
      contexts.delete(actionContext);
      if (contexts.size === 0) {
        this.actionsCache.delete(actionType);
      }
    });
  }

  public createChild(
    name: string,
    only: string[],
    loadedCode?: string,
    services: Services = this.services
  ): Entrypoint | 'loop' {
    this.assertNotSuperseded();
    return Entrypoint.create(services, this, name, only, loadedCode, {
      graphTraversalToken: this.unknownGraphTraversalToken,
    });
  }

  public createEvaluated(services: Services = this.services) {
    const evaluatedOnly = mergeOnly(this.evaluatedOnly, this.only);
    this.log('create EvaluatedEntrypoint for %o', evaluatedOnly);

    const evaluated = new EvaluatedEntrypoint(
      services,
      evaluatedOnly,
      this.exportsProxy,
      this.generation + 1,
      this.name,
      this.only,
      this.parents,
      this.dependencies,
      this.invalidationDependencies,
      this.invalidateOnDependencyChange
    );

    evaluated.initialCode = this.initialCode;
    evaluated.hasTransformResult = this.#hasTransformResult;
    evaluated.hasWywMetadata = this.#hasWywMetadata;
    evaluated.loadedAndParsed = this.loadedAndParsed;
    evaluated.preevalResult = this.#preevalResult;
    evaluated.transformResultCode = this.#transformResultCode;

    return evaluated;
  }

  public endProcessing() {
    this.#isProcessing = false;
    this.#resolveProcessing?.();
    this.#resolveProcessing = null;
    this.#processingPromise = null;
  }

  public getDependency(name: string): IEntrypointDependency | undefined {
    return this.dependencies.get(name);
  }

  public getPreevalResult(): IPreevalResult | null {
    return this.#preevalResult;
  }

  public getInvalidationDependency(
    name: string
  ): IEntrypointDependency | undefined {
    return this.invalidationDependencies.get(name);
  }

  public markInvalidateOnDependencyChange(filename: string): void {
    this.invalidateOnDependencyChange.add(filename);
  }

  public getResolveTask(
    name: string
  ): Promise<IEntrypointDependency> | undefined {
    return this.resolveTasks.get(name);
  }

  public hasWywMetadata() {
    return this.#hasWywMetadata;
  }

  public waitForProcessing(): Promise<void> {
    return this.#processingPromise ?? Promise.resolve();
  }

  public reuseTransformResult(
    code: string | null,
    hasWywMetadata: boolean
  ): void {
    this.#hasTransformResult = true;
    this.#hasWywMetadata = hasWywMetadata;
    this.#transformResultCode = code;

    // Reusing a completed transform is also successful convergence. The next
    // invalidation starts a new lineage instead of inheriting the attempts
    // that led to this reusable result.
    this.services.cache.completeUnknownGraphRecovery(this.name, this);
    resetSupersedeWindow(this.services, this.name);
  }

  public onSupersede(callback: (newEntrypoint: Entrypoint) => void) {
    if (this.#supersededWith) {
      callback(this.#supersededWith);
      return () => {};
    }

    this.onSupersedeHandlers.push(callback);

    return () => {
      const index = this.onSupersedeHandlers.indexOf(callback);
      if (index >= 0) {
        this.onSupersedeHandlers.splice(index, 1);
      }
    };
  }

  public setTransformResult(
    res: ITransformFileResult | null,
    services: Services = this.services
  ) {
    this.#hasTransformResult = true;
    this.#hasWywMetadata = Boolean(res?.metadata);
    this.#transformResultCode = res?.code ?? null;

    // A completed transform releases the superseded generations that led to
    // it. A later dependency rebuild is a new lineage and must get its own
    // diagnostic budget instead of inheriting a nearly-full storm window.
    services.cache.completeUnknownGraphRecovery(this.name, this);
    resetSupersedeWindow(services, this.name);

    services.eventEmitter.entrypointEvent(this.seqId, {
      isNull: res === null,
      type: 'setTransformResult',
    });
  }

  public setPreevalResult(result: IPreevalResult): void {
    this.#preevalResult = result;
  }

  private failInvalidation(error: Error): void {
    // invalidateIfChanged evicts the cache entry before the guard runs, but an
    // earlier workflow may still hold this object. Poison that retained
    // reference so it cannot publish the transform that the guard rejected.
    this.#invalidationError ??= error;
  }

  private deferOnlySupersede(only: string[]) {
    this.#pendingOnly = this.#pendingOnly
      ? mergeOnly(this.#pendingOnly, only)
      : [...only];
  }

  private supersede(
    newOnlyOrEntrypoint: string[] | Entrypoint,
    services: Services = this.services
  ): Entrypoint {
    this.#pendingOnly = null;
    const widensOnly = !(newOnlyOrEntrypoint instanceof Entrypoint);
    const newEntrypoint = widensOnly
      ? new Entrypoint(
          services,
          this.parents,
          this.initialCode,
          this.name,
          newOnlyOrEntrypoint,
          this.exports,
          this.evaluatedOnly,
          this.loadedAndParsed,
          this.resolveTasks,
          this.dependencies,
          this.invalidationDependencies,
          this.invalidateOnDependencyChange,
          this.generation + 1,
          false,
          this.unknownGraphTraversalToken
        )
      : newOnlyOrEntrypoint;

    services.eventEmitter.entrypointEvent(this.seqId, {
      type: 'superseded',
      with: newEntrypoint.seqId,
    });
    this.log(
      'superseded by %s (%o -> %o)',
      newEntrypoint.name,
      this.only,
      newEntrypoint.only
    );
    if (widensOnly) {
      newEntrypoint.#preevalResult = this.#preevalResult;
    }

    this.#supersededWith = newEntrypoint;
    this.onSupersedeHandlers.forEach((handler) => handler(newEntrypoint));

    return newEntrypoint;
  }
}
