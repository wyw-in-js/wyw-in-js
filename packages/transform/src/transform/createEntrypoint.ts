import fs from 'node:fs';

import type { ParentEntrypoint } from '../types';
import { recordPipelineEntrypoint } from '../debug/pipelineTelemetry';
import { stripQueryAndHash } from '../utils/parseRequest';

import { isSuperSet, mergeOnly } from './Entrypoint.helpers';
import type {
  IEntrypointCode,
  IEntrypointDependency,
  IIgnoredEntrypoint,
} from './Entrypoint.types';
import type { Entrypoint } from './Entrypoint';
import type { IEvaluatedEntrypoint } from './EvaluatedEntrypoint';
import { AbortError } from './actions/AbortError';
import {
  SUPERSEDE_STORM_LIMIT,
  blockSupersedeWindow,
  createSupersedeStormError,
  getBlockedSupersedeError,
  recordNonWideningSupersede,
  resetSupersedeWindow,
} from './supersedeStorm';
import type { Services } from './types';

export type CreateEntrypointOptions = {
  /** @internal Keep a foreign source transaction live while creating a root. */
  externalEntrypoint?: Entrypoint;
  graphTraversalToken?: object;
  mergeCachedOnly?: boolean;
};

type EntrypointCreation = [
  status: 'loop' | 'created' | 'cached',
  entrypoint: Entrypoint,
  expectedCached: Entrypoint | IEvaluatedEntrypoint | undefined,
  published: boolean,
];

export interface EntrypointInit {
  dependencies?: Map<string, IEntrypointDependency>;
  evaluatedOnly: string[];
  exports: Record<string | symbol, unknown> | undefined;
  generation?: number;
  graphTraversalToken: object;
  initialCode: string | undefined;
  invalidateOnDependencyChange?: Set<string>;
  invalidationDependencies?: Map<string, IEntrypointDependency>;
  loadedAndParsed: IEntrypointCode | IIgnoredEntrypoint;
  name: string;
  only: string[];
  originalCode: string | undefined;
  parents: ParentEntrypoint[];
  resolveTasks?: Map<string, Promise<IEntrypointDependency>>;
  services: Services;
}

export interface EntrypointFactory {
  deferOnlySupersede(entrypoint: Entrypoint, only: string[]): void;
  failInvalidation(entrypoint: Entrypoint, error: Error): void;
  instantiate(init: EntrypointInit): Entrypoint;
  isEntrypoint(parent: ParentEntrypoint | null): parent is Entrypoint;
  isProcessing(entrypoint: Entrypoint): boolean;
  supersede(
    entrypoint: Entrypoint,
    newOnlyOrEntrypoint: string[] | Entrypoint,
    services: Services,
    expectedCached: Entrypoint | IEvaluatedEntrypoint | undefined,
    assertExternalEpoch?: () => void
  ): Entrypoint;
}

function hasLoop(
  name: string,
  parent: ParentEntrypoint,
  processed: string[] = []
): boolean {
  if (parent.name === name || processed.includes(parent.name)) {
    return true;
  }

  for (const candidate of parent.parents) {
    if (hasLoop(name, candidate, [...processed, parent.name])) {
      return true;
    }
  }

  return false;
}

export function createEntrypoint(
  factory: EntrypointFactory,
  services: Services,
  parent: ParentEntrypoint | null,
  name: string,
  only: string[],
  loadedCode: string | undefined,
  options: CreateEntrypointOptions
): Entrypoint | 'loop' {
  const { cache, eventEmitter } = services;
  const cacheEpoch = services.cacheEpoch ?? cache.getCurrentEpoch();
  cache.assertEpoch(cacheEpoch);

  const guardedEntrypoints = [
    factory.isEntrypoint(parent) ? parent : null,
    options.externalEntrypoint ?? null,
  ].filter(
    (candidate, index, all): candidate is Entrypoint =>
      candidate !== null && all.indexOf(candidate) === index
  );
  const assertExternalState =
    guardedEntrypoints.length === 0
      ? undefined
      : () => {
          guardedEntrypoints.forEach((entrypoint) => {
            entrypoint.assertCurrentCacheEpoch();
            entrypoint.assertNotSuperseded();
          });
        };
  const hasForeignOwner = guardedEntrypoints.some(
    (entrypoint) => entrypoint.cacheEpoch.owner !== cacheEpoch.owner
  );

  const runCreate = (): EntrypointCreation => {
    cache.assertEpoch(cacheEpoch);
    assertExternalState?.();
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    const creation = innerCreateEntrypoint(
      factory,
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
      options,
      assertExternalState
    );
    const [createdStatus, createdEntrypoint] = creation;

    recordPipelineEntrypoint(
      parent === null,
      loadedCode !== undefined,
      createdStatus,
      createdEntrypoint.only
    );

    createdEntrypoint.assertCurrentCacheEpoch();
    createdEntrypoint.assertNotSuperseded();
    assertExternalState?.();

    return creation;
  };

  const assertCreationCurrent = (creation: EntrypointCreation): void => {
    const [status, entrypoint, expectedCached] = creation;
    cache.assertEpoch(cacheEpoch);
    entrypoint.assertCurrentCacheEpoch();
    entrypoint.assertNotSuperseded();
    assertExternalState?.();

    const expectedCurrent = status === 'cached' ? expectedCached : entrypoint;
    if (cache.get('entrypoints', name) !== expectedCurrent) {
      throw new AbortError('superseded');
    }
  };

  const commitCreation = (creation: EntrypointCreation): EntrypointCreation => {
    const [status, entrypoint, expectedCached, published] = creation;
    entrypoint.assertCurrentCacheEpoch();
    entrypoint.assertNotSuperseded();
    assertExternalState?.();

    if (
      status !== 'cached' &&
      !published &&
      !cache.replacePublished(
        entrypoint.cacheEpoch,
        'entrypoints',
        name,
        expectedCached,
        entrypoint
      )
    ) {
      entrypoint.assertNotSuperseded();
      assertExternalState?.();
      throw new AbortError('superseded');
    }

    assertCreationCurrent(creation);

    if (
      parent &&
      !entrypoint.parents.some((candidate) => candidate.name === parent.name)
    ) {
      entrypoint.parents.push(parent);
    }

    return creation;
  };

  let creation: EntrypointCreation;
  if (hasForeignOwner) {
    // A target telemetry callback cannot be part of the source cache's
    // transaction. Emit the lifecycle boundary before touching target state,
    // then fence both owners and perform the mutation synchronously.
    eventEmitter.perf('createEntrypoint', () => {
      cache.assertEpoch(cacheEpoch);
      assertExternalState?.();
    });
    cache.assertEpoch(cacheEpoch);
    assertExternalState?.();
    creation = commitCreation(runCreate());
  } else {
    creation = eventEmitter.perf('createEntrypoint', () =>
      commitCreation(runCreate())
    );

    // The finish callback runs after commit and may synchronously create a
    // newer value in the same epoch. Verify identity as well as the epoch so
    // the outer creation cannot report or overwrite stale state.
    assertCreationCurrent(creation);
  }

  const [status, entrypoint] = creation;
  return status === 'loop' ? 'loop' : entrypoint;
}

function innerCreateEntrypoint(
  factory: EntrypointFactory,
  services: Services,
  parent: ParentEntrypoint | null,
  name: string,
  only: string[],
  loadedCode: string | undefined,
  options: CreateEntrypointOptions,
  assertExternalEpoch?: () => void
): EntrypointCreation {
  const { cache } = services;
  const cacheEpoch = services.cacheEpoch ?? cache.getCurrentEpoch();
  cache.assertEpoch(cacheEpoch);

  const cached = cache.get('entrypoints', name);
  const graphTraversalToken =
    options.graphTraversalToken ??
    cache.createGraphTraversalToken(cacheEpoch, services.cacheRecoveryOwner);
  let changed = false;
  let currentCode = loadedCode;
  let unknownDependencyGraphs = new Set<string>();
  if (loadedCode !== undefined) {
    ({ changed, unknownDependencyGraphs } =
      cache.invalidateIfChangedWithDetails(
        name,
        loadedCode,
        'loaded',
        options.graphTraversalToken,
        cacheEpoch
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
          options.graphTraversalToken,
          cacheEpoch
        ));
    }
  }

  // Cache invalidation above is intentional and synchronous. From this point
  // every constructor/event callback is reentrant, so retain the exact value
  // that a later publication is allowed to replace.
  let expectedCached = cache.get('entrypoints', name);
  const assertExpectedCached = () => {
    cache.assertEpoch(cacheEpoch);
    assertExternalEpoch?.();
    if (cache.get('entrypoints', name) !== expectedCached) {
      throw new AbortError('superseded');
    }
  };

  const blockedError = getBlockedSupersedeError(services, name, currentCode);
  if (blockedError) {
    throw blockedError;
  }

  const recoveredFromUnknownGraph = unknownDependencyGraphs.size > 0;
  if (recoveredFromUnknownGraph) {
    const recovery = cache.startUnknownGraphRecovery(
      name,
      unknownDependencyGraphs,
      currentCode!,
      graphTraversalToken
    );
    if (recovery.started) {
      recovery.complete();
    }

    throw recovery.abortError;
  }

  if (!recoveredFromUnknownGraph && !cached?.evaluated && cached?.ignored) {
    return ['cached', cached, expectedCached, false];
  }

  let exports = recoveredFromUnknownGraph ? undefined : cached?.exports;
  let evaluatedOnly =
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
    const reusedLoadedAndParsed = cached.loadedAndParsed!;
    assertExpectedCached();
    const reusedOriginalCode = reusedLoadedAndParsed.code;
    assertExpectedCached();
    const reusedEntrypoint = factory.instantiate({
      dependencies: cached.dependencies,
      evaluatedOnly,
      exports,
      generation: cached.generation + 1,
      graphTraversalToken,
      initialCode: loadedCode,
      invalidateOnDependencyChange: cached.invalidateOnDependencyChange,
      invalidationDependencies: cached.invalidationDependencies,
      loadedAndParsed: reusedLoadedAndParsed,
      name,
      only: mergedOnly,
      originalCode: reusedOriginalCode,
      parents: parent ? [parent] : [],
      services,
    });
    assertExternalEpoch?.();

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

    return [
      isLoop ? 'loop' : 'cached',
      reusedEntrypoint,
      expectedCached,
      false,
    ];
  }

  if (!recoveredFromUnknownGraph && !changed && cached && !cached.evaluated) {
    const isLoop = parent && hasLoop(name, parent);
    if (isLoop) {
      parent.log('[createEntrypoint] %s is a loop', name);
    }

    if (isSuperSet(cached.only, mergedOnly)) {
      cached.log('is cached', name);
      return [isLoop ? 'loop' : 'cached', cached, expectedCached, false];
    }

    cached.log(
      'is cached, but with different `only` %o (the cached one %o)',
      only,
      cached.only
    );

    if (factory.isProcessing(cached)) {
      if (parent === null) {
        cached.log(
          'is being processed during root request, supersede immediately (%o -> %o)',
          cached.only,
          mergedOnly
        );
        return [
          isLoop ? 'loop' : 'created',
          factory.supersede(
            cached,
            mergedOnly,
            services,
            expectedCached,
            assertExternalEpoch
          ),
          expectedCached,
          true,
        ];
      }

      factory.deferOnlySupersede(cached, mergedOnly);
      cached.log(
        'is being processed, defer supersede (%o -> %o)',
        cached.only,
        mergedOnly
      );
      return [isLoop ? 'loop' : 'cached', cached, expectedCached, false];
    }

    return [
      isLoop ? 'loop' : 'created',
      factory.supersede(
        cached,
        mergedOnly,
        services,
        expectedCached,
        assertExternalEpoch
      ),
      expectedCached,
      true,
    ];
  }

  let requestedCodeIsUnchanged = false;
  if (cached) {
    const cachedCode =
      cached.initialCode === undefined
        ? cached.loadedAndParsed?.code
        : cached.initialCode;
    assertExpectedCached();
    requestedCodeIsUnchanged =
      currentCode !== undefined && currentCode === cachedCode;

    if (!requestedCodeIsUnchanged) {
      // A real source edit starts a new lineage. It must supersede normally,
      // regardless of how much invalidation traffic preceded it.
      resetSupersedeWindow(services, name);
    } else if (!cached.evaluated && isSuperSet(cached.only, mergedOnly)) {
      const count = recordNonWideningSupersede(services, name);
      if (count > SUPERSEDE_STORM_LIMIT) {
        const error = createSupersedeStormError(name);
        factory.failInvalidation(cached, error);
        const recovery = cache.startSupersedeStormRecovery(
          error,
          name,
          cacheEpoch,
          services.cacheRecoveryOwner
        );
        blockSupersedeWindow(services, name, currentCode!, error);
        if (recovery.started) {
          recovery.complete();
        } else {
          throw recovery.abortError;
        }
        throw error;
      }
    }
  }

  assertExpectedCached();
  const nextLoadedAndParsed = reusableEvaluatedState
    ? cached.loadedAndParsed!
    : services.loadAndParseFn(
        services,
        name,
        loadedCode,
        parent?.log ?? services.log
      );
  assertExpectedCached();
  const nextOriginalCode = nextLoadedAndParsed.code;
  assertExpectedCached();

  let parsedCodeChanged = false;
  if (nextOriginalCode !== undefined) {
    const parsedInvalidation = cache.invalidateIfChangedWithDetails(
      name,
      nextOriginalCode,
      loadedCode === undefined ? 'fs' : 'loaded',
      graphTraversalToken,
      cacheEpoch
    );
    parsedCodeChanged = parsedInvalidation.changed;
    parsedInvalidation.unknownDependencyGraphs.forEach((dependency) =>
      unknownDependencyGraphs.add(dependency)
    );
    expectedCached = cache.get('entrypoints', name);
    assertExternalEpoch?.();

    if (parsedInvalidation.unknownDependencyGraphs.size > 0) {
      const recovery = cache.startUnknownGraphRecovery(
        name,
        parsedInvalidation.unknownDependencyGraphs,
        nextOriginalCode,
        graphTraversalToken
      );
      if (recovery.started) {
        recovery.complete();
      }
      throw recovery.abortError;
    }

    if (parsedCodeChanged) {
      exports = undefined;
      evaluatedOnly = [];
    }
  }

  const reusePreparedState = reusableEvaluatedState && !parsedCodeChanged;
  // A dependency-only invalidation evicts the current entrypoint before its
  // replacement is constructed. Keep the known edges while that unchanged
  // source is rebuilt. A real source edit still starts with empty state.
  const retainDependencyGraph =
    cached !== undefined && requestedCodeIsUnchanged && !parsedCodeChanged;
  let retainedDependencies;
  let retainedInvalidationDependencies;
  let retainedInvalidateOnDependencyChange;
  if (retainDependencyGraph && cached) {
    if (reusePreparedState) {
      retainedDependencies = cached.dependencies;
      retainedInvalidationDependencies = cached.invalidationDependencies;
      retainedInvalidateOnDependencyChange =
        cached.invalidateOnDependencyChange;
    } else {
      retainedDependencies = new Map(cached.dependencies);
      retainedInvalidationDependencies = new Map(
        cached.invalidationDependencies
      );
      retainedInvalidateOnDependencyChange = new Set(
        cached.invalidateOnDependencyChange
      );
    }
  }

  const newEntrypoint = factory.instantiate({
    dependencies: retainedDependencies,
    evaluatedOnly,
    exports,
    generation: cached ? cached.generation + 1 : 1,
    graphTraversalToken,
    initialCode: loadedCode,
    invalidateOnDependencyChange: retainedInvalidateOnDependencyChange,
    invalidationDependencies: retainedInvalidationDependencies,
    loadedAndParsed: nextLoadedAndParsed,
    name,
    only: mergedOnly,
    originalCode: nextOriginalCode,
    parents: parent ? [parent] : [],
    services,
  });
  assertExternalEpoch?.();

  if (
    reusePreparedState &&
    'preevalResult' in cached &&
    cached.preevalResult !== null &&
    cached.preevalResult !== undefined
  ) {
    newEntrypoint.setPreevalResult(cached.preevalResult);
  }

  const published = Boolean(cached && !cached.evaluated);
  if (cached && !cached.evaluated) {
    cached.log('is cached, but with different code');
    factory.supersede(
      cached,
      newEntrypoint,
      services,
      expectedCached,
      assertExternalEpoch
    );
  }

  return ['created', newEntrypoint, expectedCached, published];
}
