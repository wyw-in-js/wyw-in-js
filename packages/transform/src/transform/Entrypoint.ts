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
import {
  EvaluatedEntrypoint,
  type IEvaluatedEntrypoint,
} from './EvaluatedEntrypoint';
import { AbortError } from './actions/AbortError';
import type { ActionByType } from './actions/BaseAction';
import { BaseAction } from './actions/BaseAction';
import { UnprocessedEntrypointError } from './actions/UnprocessedEntrypointError';
import {
  createEntrypoint,
  type CreateEntrypointOptions,
  type EntrypointFactory,
  type EntrypointInit,
} from './createEntrypoint';
import { resetSupersedeWindow } from './supersedeStorm';
import type { Services, ActionTypes, ActionQueueItem } from './types';

const EMPTY_FILE = '=== empty file ===';
const DEFAULT_ACTION_CONTEXT = Symbol('defaultActionContext');

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

  #invalidationError: Error | null = null;

  readonly #cacheLifecycleVersion: number;

  #pendingOnly: string[] | null = null;

  readonly #originalCode: string | undefined;

  #preevalResult: IPreevalResult | null = null;

  #processingPromise: Promise<void> | null = null;

  #resolveProcessing: (() => void) | null = null;

  #supersededWith: Entrypoint | null = null;

  #transformResultCode: string | null = null;

  #transformResultMutation: object | null = null;

  private constructor(
    services: Services,
    parents: ParentEntrypoint[],
    public readonly initialCode: string | undefined,
    name: string,
    only: string[],
    exports: Record<string | symbol, unknown> | undefined,
    evaluatedOnly: string[],
    loadedAndParsed: IEntrypointCode | IIgnoredEntrypoint,
    originalCode: string | undefined,
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
    private readonly unknownGraphTraversalToken: object = {}
  ) {
    const cacheEpoch = services.cacheEpoch ?? services.cache.getCurrentEpoch();
    services.cache.assertEpoch(cacheEpoch);
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
    services.cache.assertEpoch(cacheEpoch);

    // Keep the released lifecycle API independent from internal cache epochs.
    // Namespace rotations retire an epoch without advancing the compatibility
    // lifecycle counter, so substituting cacheEpoch.version here would make
    // callers miss a later recovery.
    this.#cacheLifecycleVersion = services.cache.getLifecycleVersion();

    this.loadedAndParsed = loadedAndParsed;
    this.#originalCode = originalCode;

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
    return this.#originalCode;
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

  private get invalidationError(): Error | null {
    return (
      this.#invalidationError ??
      this.cacheEpoch.owner.getEpochError(this.cacheEpoch) ??
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

  /** @internal Translate traversal ownership for services overrides. */
  public getGraphTraversalTokenForServices(services: Services): object {
    this.assertCurrentCacheEpoch();
    this.assertNotSuperseded();
    const targetEpoch = services.cacheEpoch ?? services.cache.getCurrentEpoch();
    services.cache.assertEpoch(targetEpoch);
    return targetEpoch.owner === this.cacheEpoch.owner
      ? this.unknownGraphTraversalToken
      : services.cache.createGraphTraversalToken(
          targetEpoch,
          services.cacheRecoveryOwner
        );
  }

  /** @internal Action execution fences are owned by the transform pipeline. */
  public assertCurrentCacheEpoch(): void {
    this.cacheEpoch.owner.assertEpoch(this.cacheEpoch);
    const traversalError = this.services.cache.getGraphTraversalTokenError(
      this.unknownGraphTraversalToken
    );
    if (traversalError) {
      throw traversalError;
    }
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

  private static readonly creationFactory: EntrypointFactory = {
    deferOnlySupersede: (entrypoint, only) =>
      entrypoint.deferOnlySupersede(only),
    failInvalidation: (entrypoint, error) => entrypoint.failInvalidation(error),
    instantiate: (init: EntrypointInit) => {
      const {
        dependencies = new Map(),
        evaluatedOnly,
        exports,
        generation = 1,
        graphTraversalToken,
        initialCode,
        invalidateOnDependencyChange = new Set(),
        invalidationDependencies = new Map(),
        loadedAndParsed,
        name,
        only,
        originalCode,
        parents,
        resolveTasks = new Map(),
        services,
      } = init;

      return new Entrypoint(
        services,
        parents,
        initialCode,
        name,
        only,
        exports,
        evaluatedOnly,
        loadedAndParsed,
        originalCode,
        resolveTasks,
        dependencies,
        invalidationDependencies,
        invalidateOnDependencyChange,
        generation,
        graphTraversalToken
      );
    },
    isEntrypoint: (parent): parent is Entrypoint =>
      parent instanceof Entrypoint,
    isProcessing: (entrypoint) => entrypoint.#isProcessing,
    supersede: (
      entrypoint,
      newOnlyOrEntrypoint,
      services,
      expectedCached,
      assertExternalEpoch
    ) =>
      entrypoint.supersede(
        newOnlyOrEntrypoint,
        services,
        expectedCached,
        assertExternalEpoch
      ),
  };

  protected static create(
    services: Services,
    parent: ParentEntrypoint | null,
    name: string,
    only: string[],
    loadedCode: string | undefined,
    options: CreateEntrypointOptions = {}
  ): Entrypoint | 'loop' {
    return createEntrypoint(
      Entrypoint.creationFactory,
      services,
      parent,
      name,
      only,
      loadedCode,
      options
    );
  }

  public addDependency(dependency: IEntrypointDependency): void {
    this.assertCurrentCacheEpoch();
    this.resolveTasks.delete(dependency.source);
    this.dependencies.set(dependency.source, dependency);
  }

  public addInvalidationDependency(dependency: IEntrypointDependency): void {
    this.assertCurrentCacheEpoch();
    this.resolveTasks.delete(dependency.source);
    this.invalidationDependencies.set(dependency.source, dependency);
  }

  public addResolveTask(
    name: string,
    dependency: Promise<IEntrypointDependency>
  ): void {
    this.assertCurrentCacheEpoch();
    // Bounded retry of transient null resolutions. The first time a
    // resolveTask settles to null, evict it from the cache so the next
    // consumer re-attempts the resolver. After RESOLVE_TASK_MAX_NULL_ATTEMPTS
    // failures the entry stays cached so we don't thrash. Successful (non-null)
    // resolutions remain cached normally; this branch only ever fires for null.
    const tracked = dependency.then((resolved) => {
      this.assertCurrentCacheEpoch();
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
    this.assertCurrentCacheEpoch();
    this.assertNotSuperseded();
    if (this.#supersededWith || this.#pendingOnly === null) {
      return null;
    }

    const mergedOnly = mergeOnly(this.only, this.#pendingOnly);

    if (isSuperSet(this.only, mergedOnly)) {
      this.#pendingOnly = null;
      return null;
    }

    this.log('apply deferred supersede (%o -> %o)', this.only, mergedOnly);

    const targetEpoch = services.cacheEpoch ?? services.cache.getCurrentEpoch();
    services.cache.assertEpoch(targetEpoch);
    const expectedCached = services.cache.get('entrypoints', this.name);
    if (targetEpoch.owner !== this.cacheEpoch.owner) {
      // A successor cannot safely belong to two cache owners: superseding this
      // source-owned object while publishing only to the target leaves the
      // source cache pointing at a poisoned entrypoint. Materialize a detached
      // target retry and keep the source lineage valid instead.
      if (expectedCached !== undefined) {
        throw new AbortError('superseded');
      }

      const pendingOnly = this.#pendingOnly;
      const detached = Entrypoint.create(
        services,
        this.parents[0] ?? null,
        this.name,
        mergedOnly,
        this.initialCode,
        {
          externalEntrypoint: this,
          graphTraversalToken: this.getGraphTraversalTokenForServices(services),
          mergeCachedOnly: false,
        }
      );
      invariant(detached !== 'loop', 'loop detected');
      services.cache.assertEpoch(targetEpoch);
      this.assertCurrentCacheEpoch();
      this.assertNotSuperseded();
      detached.assertCurrentCacheEpoch();
      detached.assertNotSuperseded();
      if (this.#pendingOnly === pendingOnly) {
        this.#pendingOnly = null;
      }
      return detached;
    }

    if (expectedCached !== this) {
      throw new AbortError('superseded');
    }

    const nextEntrypoint = this.supersede(mergedOnly, services, expectedCached);

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
    this.assertCurrentCacheEpoch();
    this.assertNotSuperseded();
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
      cached.assertCurrentCacheEpoch();
      this.assertNotSuperseded();
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
    try {
      services.eventEmitter.entrypointEvent(this.seqId, {
        type: 'actionCreated',
        actionType,
        actionIdx: newAction.idx,
      });
      newAction.assertCurrentCacheEpoch();
      this.assertNotSuperseded();
    } catch (error) {
      if (serviceScopes.get(services) === newAction) {
        serviceScopes.delete(services);
      }
      throw error;
    }

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
    this.assertCurrentCacheEpoch();
    this.assertNotSuperseded();

    const graphTraversalToken =
      this.getGraphTraversalTokenForServices(services);

    return Entrypoint.create(services, this, name, only, loadedCode, {
      graphTraversalToken,
    });
  }

  public createEvaluated(services: Services = this.services) {
    this.assertCurrentCacheEpoch();
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

    // EvaluatedEntrypoint construction emits a public `created` event through
    // the target services. That callback may retire either owner, so fence the
    // target and the copied source state before a caller can publish the clone.
    services.cache.assertEpoch(evaluated.cacheEpoch);
    this.assertCurrentCacheEpoch();
    this.assertNotSuperseded();

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
    this.assertCurrentCacheEpoch();
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
    this.assertCurrentCacheEpoch();
    this.#hasTransformResult = true;
    this.#hasWywMetadata = hasWywMetadata;
    this.#transformResultCode = code;

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
    this.assertCurrentCacheEpoch();
    this.assertNotSuperseded();
    const targetEpoch = services.cacheEpoch ?? services.cache.getCurrentEpoch();
    services.cache.assertEpoch(targetEpoch);
    const previousHasTransformResult = this.#hasTransformResult;
    const previousHasWywMetadata = this.#hasWywMetadata;
    const previousTransformResultCode = this.#transformResultCode;
    const previousTransformResultMutation = this.#transformResultMutation;
    const transformResultMutation = {};
    this.#transformResultMutation = transformResultMutation;
    this.#hasTransformResult = true;
    this.#hasWywMetadata = Boolean(res?.metadata);
    this.#transformResultCode = res?.code ?? null;

    try {
      services.eventEmitter.entrypointEvent(this.seqId, {
        isNull: res === null,
        type: 'setTransformResult',
      });
      services.cache.assertEpoch(targetEpoch);
      this.assertCurrentCacheEpoch();
      this.assertNotSuperseded();
      resetSupersedeWindow(services, this.name);
    } catch (error) {
      // A lifecycle callback may have committed a newer transform result on
      // the same object. Roll back only while this write still owns the state.
      if (this.#transformResultMutation === transformResultMutation) {
        this.#hasTransformResult = previousHasTransformResult;
        this.#hasWywMetadata = previousHasWywMetadata;
        this.#transformResultCode = previousTransformResultCode;
        this.#transformResultMutation = previousTransformResultMutation;
      }
      throw error;
    }
  }

  public setPreevalResult(result: IPreevalResult): void {
    this.assertCurrentCacheEpoch();
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
    services: Services,
    expectedCached: Entrypoint | IEvaluatedEntrypoint | undefined,
    assertExternalEpoch?: () => void
  ): Entrypoint {
    this.assertCurrentCacheEpoch();
    this.assertNotSuperseded();
    const targetEpoch = services.cacheEpoch ?? services.cache.getCurrentEpoch();
    services.cache.assertEpoch(targetEpoch);
    const widensOnly = !(newOnlyOrEntrypoint instanceof Entrypoint);
    const graphTraversalToken =
      targetEpoch.owner === this.cacheEpoch.owner
        ? this.unknownGraphTraversalToken
        : services.cache.createGraphTraversalToken(
            targetEpoch,
            services.cacheRecoveryOwner
          );
    let publicationExpected = expectedCached;
    if (widensOnly && this.#originalCode !== undefined) {
      if (
        services.cache.get('entrypoints', this.name) !== publicationExpected
      ) {
        throw new AbortError('superseded');
      }
      const parsedInvalidation = services.cache.invalidateIfChangedWithDetails(
        this.name,
        this.#originalCode,
        this.initialCode === undefined ? 'fs' : 'loaded',
        graphTraversalToken,
        targetEpoch
      );
      publicationExpected = services.cache.get('entrypoints', this.name);
      this.assertCurrentCacheEpoch();
      this.assertNotSuperseded();
      assertExternalEpoch?.();

      if (parsedInvalidation.unknownDependencyGraphs.size > 0) {
        const recovery = services.cache.startUnknownGraphRecovery(
          this.name,
          parsedInvalidation.unknownDependencyGraphs,
          this.#originalCode,
          graphTraversalToken
        );
        if (recovery.started) {
          recovery.complete();
        }
        throw recovery.abortError;
      }
    }
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
          this.#originalCode,
          this.resolveTasks,
          this.dependencies,
          this.invalidationDependencies,
          this.invalidateOnDependencyChange,
          this.generation + 1,
          graphTraversalToken
        )
      : newOnlyOrEntrypoint;

    this.assertCurrentCacheEpoch();
    this.assertNotSuperseded();
    newEntrypoint.assertCurrentCacheEpoch();
    newEntrypoint.assertNotSuperseded();
    assertExternalEpoch?.();

    services.eventEmitter.entrypointEvent(this.seqId, {
      type: 'superseded',
      with: newEntrypoint.seqId,
    });
    this.assertCurrentCacheEpoch();
    this.assertNotSuperseded();
    newEntrypoint.assertCurrentCacheEpoch();
    newEntrypoint.assertNotSuperseded();
    assertExternalEpoch?.();
    this.log(
      'superseded by %s (%o -> %o)',
      newEntrypoint.name,
      this.only,
      newEntrypoint.only
    );
    if (widensOnly) {
      newEntrypoint.#preevalResult = this.#preevalResult;
    }

    const previousPendingOnly = this.#pendingOnly;
    const previousSupersededWith = this.#supersededWith;
    this.#pendingOnly = null;
    this.#supersededWith = newEntrypoint;
    try {
      this.onSupersedeHandlers.forEach((handler) => {
        handler(newEntrypoint);
        this.assertCurrentCacheEpoch();
        newEntrypoint.assertCurrentCacheEpoch();
        newEntrypoint.assertNotSuperseded();
        if (this.#supersededWith !== newEntrypoint) {
          throw new AbortError('superseded');
        }
        assertExternalEpoch?.();
      });

      if (
        !services.cache.replacePublished(
          newEntrypoint.cacheEpoch,
          'entrypoints',
          this.name,
          publicationExpected,
          newEntrypoint
        )
      ) {
        throw new AbortError('superseded');
      }
    } catch (error) {
      this.#pendingOnly = previousPendingOnly;
      this.#supersededWith = previousSupersededWith;
      if (services.cache.get('entrypoints', this.name) === newEntrypoint) {
        services.cache.replacePublished(
          newEntrypoint.cacheEpoch,
          'entrypoints',
          this.name,
          newEntrypoint,
          publicationExpected
        );
      }
      throw error;
    }

    return newEntrypoint;
  }
}
