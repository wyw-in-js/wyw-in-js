import { createHash } from 'crypto';
import fs from 'node:fs';
import { logger } from '@wyw-in-js/shared';

import {
  getPipelineCodeSha256Hex,
  primePipelineCodeSha256Hex,
  recordPipelineCacheClear,
  recordPipelineCacheRequest,
  recordPipelineCacheSalt,
} from './debug/pipelineTelemetry';
import type { BarrelManifestCacheEntry } from './transform/barrelManifest.types';
import type { Entrypoint } from './transform/Entrypoint';
import type { IEvaluatedEntrypoint } from './transform/EvaluatedEntrypoint';
import { getFileIdx } from './utils/getFileIdx';
import { stripQueryAndHash } from './utils/parseRequest';

function hashContent(content: string) {
  const cached = getPipelineCodeSha256Hex(content);
  if (cached) return cached;

  const sha256Hex = createHash('sha256').update(content).digest('hex');
  primePipelineCodeSha256Hex(content, sha256Hex);
  return sha256Hex;
}

function isMissingFileError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const { code } = error as NodeJS.ErrnoException;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

interface IBaseCachedEntrypoint {
  dependencies: Map<string, { resolved: string | null }>;
  hasTransformResult?: boolean;
  initialCode?: string;
  isProcessing?: boolean;
  invalidateOnDependencyChange?: Set<string>;
  invalidationDependencies?: Map<string, { resolved: string | null }>;
  transformed?: boolean;
}

type EntrypointDependencySnapshot = Pick<
  IBaseCachedEntrypoint,
  'dependencies' | 'invalidationDependencies' | 'invalidateOnDependencyChange'
>;

const isEntrypointGraphIncomplete = (
  entrypoint: IBaseCachedEntrypoint | undefined
) =>
  Boolean(
    entrypoint?.isProcessing ||
      entrypoint?.transformed === false ||
      entrypoint?.hasTransformResult === false
  );

interface ICaches<TEntrypoint extends IBaseCachedEntrypoint> {
  barrelManifests: Map<string, BarrelManifestCacheEntry>;
  entrypoints: Map<string, TEntrypoint>;
  exports: Map<string, string[]>;
}

type MapValue<T> = T extends Map<string, infer V> ? V : never;

interface IGraphTraversalTokenOwner {
  getLifecycleError(version: number): Error | null;
  getLifecycleVersion(): number;
  getScopedRecoveryError(
    version: number,
    visited: ReadonlySet<string>,
    token?: object
  ): Error | null | undefined;
}

const graphTraversalTokenStates = new WeakMap<
  object,
  { owner: IGraphTraversalTokenOwner; version: number; visited: Set<string> }
>();

const cacheLogger = logger.extend('cache');

const cacheNames = ['barrelManifests', 'entrypoints', 'exports'] as const;
type CacheNames = (typeof cacheNames)[number];

const loggers = cacheNames.reduce(
  (acc, key) => ({
    ...acc,
    [key]: cacheLogger.extend(key),
  }),
  {} as Record<CacheNames, typeof logger>
);

export class TransformCacheCollection<
  TEntrypoint extends IBaseCachedEntrypoint = Entrypoint | IEvaluatedEntrypoint,
> {
  public readonly barrelManifests: Map<string, BarrelManifestCacheEntry>;

  public readonly entrypoints: Map<string, TEntrypoint>;

  public readonly exports: Map<string, string[]>;

  private readonly barrelManifestDependencies = new Map<string, Set<string>>();

  private contentHashes = new Map<string, { fs?: string; loaded?: string }>();

  private fileMtimes = new Map<string, number>();

  private readonly exportDependencies = new Map<string, Set<string>>();

  private readonly entrypointDependencySnapshots = new Map<
    string,
    EntrypointDependencySnapshot
  >();

  private keySalt: string | null = null;

  private invalidatedFiles = new Map<string, number>();

  private consumedInvalidationVersions = new Map<string, number>();

  private resetVersion = 0;

  private lifecycleError: Error | null = null;

  private lifecycleVersion = 0;

  // Recovery errors keyed by the file whose graph was incomplete. Bounded by
  // the number of distinct files ever recovered, and cleared with the cache.
  private readonly fileRecoveryErrors = new Map<
    string,
    { error: Error; version: number }
  >();

  private readonly pendingUnknownGraphs = new Map<
    string,
    {
      dependencies: Set<string>;
      recoveryToken: object;
      sourceHash: string;
    }
  >();

  constructor(caches: Partial<ICaches<TEntrypoint>> = {}) {
    this.barrelManifests = caches.barrelManifests || new Map();
    this.entrypoints = caches.entrypoints || new Map();
    this.exports = caches.exports || new Map();
  }

  public setKeySalt(keySalt: string | null) {
    const prevKeySalt = this.keySalt;
    if (prevKeySalt === keySalt) {
      recordPipelineCacheSalt(prevKeySalt, keySalt, 'unchanged');
      return;
    }

    this.keySalt = keySalt;
    this.resetVersion += 1;

    if (prevKeySalt === null && keySalt) {
      recordPipelineCacheSalt(prevKeySalt, keySalt, 'migrate');
      const migrate = <TValue>(cache: Map<string, TValue>) => {
        const entries = Array.from(cache.entries());
        cache.clear();
        entries.forEach(([key, value]) => {
          cache.set(this.getKey(key), value);
        });
      };

      migrate(this.barrelManifests);
      migrate(this.entrypoints);
      migrate(this.exports);
      migrate(this.barrelManifestDependencies);
      migrate(this.entrypointDependencySnapshots);
      migrate(this.exportDependencies);
      return;
    }

    const clearReason = keySalt === null ? 'salt-disable' : 'salt-change';
    recordPipelineCacheSalt(
      prevKeySalt,
      keySalt,
      keySalt === null ? 'disable' : 'clear'
    );
    recordPipelineCacheClear(
      'barrelManifests',
      clearReason,
      this.barrelManifests.size
    );
    this.barrelManifests.clear();
    recordPipelineCacheClear('entrypoints', clearReason, this.entrypoints.size);
    this.entrypoints.clear();
    recordPipelineCacheClear('exports', clearReason, this.exports.size);
    this.exports.clear();
    this.entrypointDependencySnapshots.clear();
    this.pendingUnknownGraphs.clear();
    this.fileRecoveryErrors.clear();
    this.clearCacheDependencies('all');
  }

  private getKey(key: string) {
    if (!this.keySalt) return key;
    return `${key}::${this.keySalt}`;
  }

  public getKeySalt() {
    return this.keySalt;
  }

  public getLifecycleVersion(): number {
    return this.lifecycleVersion;
  }

  public getResetVersion(): number {
    return this.resetVersion;
  }

  public getLifecycleError(version: number): Error | null {
    return version === this.lifecycleVersion ? null : this.lifecycleError;
  }

  /**
   * The recovery error for a generation of `filename` that was created before a
   * recovery of that same file, so it read the state the recovery cleared. An
   * unrelated file transforming concurrently on the same cache never inherits
   * it, and a generation created after the recovery starts clean.
   */
  public getRecoveryError(
    filename: string,
    sinceVersion: number,
    graphTraversalToken?: object
  ): Error | null {
    const recovery = this.fileRecoveryErrors.get(filename);
    if (!recovery) {
      return null;
    }

    if (recovery.version > sinceVersion) {
      return recovery.error;
    }

    // While this file's own recovery has not converged, only the traversal that
    // opened the recovery may work with it. Any other generation -- a stale
    // parent creating a child, or a re-request reusing the recovering
    // entrypoint's token -- must not be published from an incomplete graph.
    const pending = this.pendingUnknownGraphs.get(filename);
    if (pending && graphTraversalToken !== pending.recoveryToken) {
      return recovery.error;
    }

    return null;
  }

  public createGraphTraversalToken(): object {
    const token = {};
    graphTraversalTokenStates.set(token, {
      owner: this,
      version: this.lifecycleVersion,
      visited: new Set(),
    });
    return token;
  }

  public getGraphTraversalTokenError(token: object): Error | null {
    const state = graphTraversalTokenStates.get(token);
    if (!state) {
      return null;
    }

    const owner = state.owner === this ? this : state.owner;
    if (owner.getLifecycleVersion() === state.version) return null;

    const scopedError = owner.getScopedRecoveryError(
      state.version,
      state.visited,
      token
    );
    // A traversal that never read a file with an unconverged recovery kept
    // reading state no recovery invalidated, so it stays usable: a concurrent
    // transform on a shared cache must not fail for another file's incomplete
    // graph.
    if (scopedError === undefined) {
      return null;
    }

    return (
      owner.getLifecycleError(state.version) ??
      scopedError ??
      Object.assign(
        new Error(
          '[wyw-in-js] Dependency-graph traversal outlived its cache lifecycle.'
        ),
        { name: 'StaleDependencyGraphTraversalError' }
      )
    );
  }

  /**
   * How a recovery since `version` affects a traversal that read `visited`.
   * `undefined` means no recovery reached it; an `Error` is the recovery to
   * report; `null` means it was reached by a recovery with no error to name.
   */
  public getScopedRecoveryError(
    version: number,
    visited: ReadonlySet<string>,
    token?: object
  ): Error | null | undefined {
    // A traversal that opened a recovery of its own can no longer complete the
    // graph it was assembling once a later recovery clears the cache under it.
    const ownsUnconvergedRecovery =
      token !== undefined && this.ownsPendingRecovery(token);

    for (const [filename, recovery] of this.fileRecoveryErrors) {
      if (recovery.version <= version) {
        continue;
      }

      // Reading a file that a recovery reset is what makes a traversal stale.
      // A traversal that read nothing a recovery touched keeps working -- that
      // is what stops one file's reset from failing every concurrent transform.
      if (ownsUnconvergedRecovery || visited.has(filename)) {
        return recovery.error;
      }
    }

    // A global reset carries no subject, so it retires every traversal.
    return this.lifecycleError ?? undefined;
  }

  private ownsPendingRecovery(token: object): boolean {
    for (const pending of this.pendingUnknownGraphs.values()) {
      if (pending.recoveryToken === token) {
        return true;
      }
    }

    return false;
  }

  public beginUnknownGraphRecovery(
    filename: string,
    unknownDependencies: ReadonlySet<string>,
    sourceCode: string,
    recoveryToken: object
  ): Error {
    const error = Object.assign(
      new Error(
        `[wyw-in-js] Resetting transform and evaluation caches for ${filename} because the dependency graph is incomplete (${[
          ...unknownDependencies,
        ].join(', ')}).`
      ),
      {
        code: 'WYW_UNKNOWN_DEPENDENCY_GRAPH_RESET',
        name: 'UnknownDependencyGraphResetError',
      }
    );

    this.beginFailClosedRecovery(error, filename);
    graphTraversalTokenStates.set(recoveryToken, {
      owner: this,
      version: this.lifecycleVersion,
      visited: new Set([filename]),
    });
    this.pendingUnknownGraphs.set(filename, {
      dependencies: new Set(unknownDependencies),
      recoveryToken,
      sourceHash: hashContent(sourceCode),
    });
    return error;
  }

  public completeUnknownGraphRecovery(
    filename: string,
    publishedEntrypoint?: TEntrypoint
  ): void {
    if (
      publishedEntrypoint !== undefined &&
      this.get('entrypoints', filename) !== publishedEntrypoint
    ) {
      return;
    }

    this.pendingUnknownGraphs.delete(filename);
  }

  public beginSupersedeStormRecovery(error: Error, filename?: string): void {
    this.beginFailClosedRecovery(error, filename);
  }

  private beginFailClosedRecovery(error: Error, subject?: string): void {
    const pendingUnknownGraphs = new Map(this.pendingUnknownGraphs);
    const { resetVersion } = this;
    this.lifecycleVersion += 1;
    // A recovery is triggered by one file's incomplete graph. Poison only that
    // file: an unrelated transform running concurrently on the same shared
    // cache rebuilds from the cleared state instead of inheriting an error
    // about a file it never referenced.
    if (subject === undefined) {
      this.lifecycleError = error;
    } else {
      this.fileRecoveryErrors.set(subject, {
        error,
        version: this.lifecycleVersion,
      });
    }
    this.clear('all');
    // This is an internal recovery attempt, not an explicit configuration or
    // user cache reset. Preserve the supersede budget across retries so a
    // graph that never converges still reaches the bounded diagnostic.
    this.resetVersion = resetVersion;
    pendingUnknownGraphs.forEach((pending, filename) => {
      this.pendingUnknownGraphs.set(filename, pending);
    });
    this.contentHashes.clear();
    this.fileMtimes.clear();
    this.invalidatedFiles.clear();
    this.consumedInvalidationVersions.clear();
  }

  public add<
    TCache extends CacheNames,
    TValue extends MapValue<ICaches<TEntrypoint>[TCache]>,
  >(cacheName: TCache, key: string, value: TValue): void {
    const cache = this[cacheName] as Map<string, TValue>;
    const cacheKey = this.getKey(key);
    loggers[cacheName]('%s:add %s %f', getFileIdx(key), key, () => {
      if (value === undefined) {
        return cache.has(cacheKey) ? 'removed' : 'noop';
      }

      if (!cache.has(cacheKey)) {
        return 'added';
      }

      return cache.get(cacheKey) === value ? 'unchanged' : 'updated';
    });

    if (value === undefined) {
      cache.delete(cacheKey);
      this.contentHashes.delete(key);
      if (cacheName === 'entrypoints') {
        this.entrypointDependencySnapshots.delete(cacheKey);
      }
      this.clearCacheDependencies(cacheName, key);
      return;
    }

    if (cacheName === 'entrypoints') {
      const previous = cache.get(cacheKey) as TEntrypoint | undefined;
      if (previous && previous !== (value as unknown as TEntrypoint)) {
        // Direct replacement (for example applyDeferredSupersede) bypasses
        // invalidate/delete. Preserve the previous completed graph before an
        // unfinished successor replaces it.
        this.snapshotEntrypointDependencies(key, previous);
      }
    }

    this.clearCacheDependencies(cacheName, key);
    cache.set(cacheKey, value);

    if (
      cacheName === 'entrypoints' &&
      !isEntrypointGraphIncomplete(value as unknown as IBaseCachedEntrypoint)
    ) {
      this.completeUnknownGraphRecovery(key);
    }

    // Keep the last complete entrypoint snapshot while a replacement is live.
    // Its dependency maps are incomplete while it is processing, so checks
    // merge them with the retained graph. If the replacement is evicted before
    // it finishes, the previous complete graph remains the safe fallback. A
    // real source change explicitly forgets it in invalidateIfChanged.

    if ('initialCode' in value) {
      const maybeOriginalCode = (value as unknown as { originalCode?: unknown })
        .originalCode;
      const isLoaded = typeof value.initialCode === 'string';
      const source = isLoaded ? 'loaded' : 'fs';

      let resolvedCode: string | undefined;
      if (isLoaded) {
        resolvedCode = value.initialCode;
      } else if (typeof maybeOriginalCode === 'string') {
        resolvedCode = maybeOriginalCode;
      }

      if (resolvedCode !== undefined) {
        this.setContentHash(key, source, hashContent(resolvedCode));
        return;
      }

      try {
        const fileContent = fs.readFileSync(stripQueryAndHash(key), 'utf8');
        this.setContentHash(key, source, hashContent(fileContent));
      } catch {
        this.setContentHash(key, source, hashContent(''));
      }

      return;
    }

    if (cacheName === 'barrelManifests' || cacheName === 'exports') {
      try {
        const fileContent = fs.readFileSync(stripQueryAndHash(key), 'utf8');
        this.setContentHash(key, 'fs', hashContent(fileContent));
      } catch {
        this.setContentHash(key, 'fs', hashContent(''));
      }
    }
  }

  public clear(cacheName: CacheNames | 'all'): void {
    if (cacheName === 'all') {
      cacheNames.forEach((name) => {
        this.clear(name);
      });

      return;
    }

    loggers[cacheName]('clear');
    const cache = this[cacheName] as Map<string, unknown>;

    recordPipelineCacheClear(cacheName, 'explicit', cache.size);
    cache.clear();
    if (cacheName === 'entrypoints') {
      this.resetVersion += 1;
      this.entrypointDependencySnapshots.clear();
      this.pendingUnknownGraphs.clear();
    }
    this.clearCacheDependencies(cacheName);
  }

  public delete(cacheName: CacheNames, key: string): void {
    this.invalidate(cacheName, key);
  }

  public get<
    TCache extends CacheNames,
    TValue extends MapValue<ICaches<TEntrypoint>[TCache]>,
  >(cacheName: TCache, key: string): TValue | undefined {
    const cache = this[cacheName] as Map<string, TValue>;
    const res = cache.get(this.getKey(key));

    loggers[cacheName]('get', key, res === undefined ? 'miss' : 'hit');
    recordPipelineCacheRequest(cacheName, 'get', res !== undefined);
    return res;
  }

  public has(cacheName: CacheNames, key: string): boolean {
    const cache = this[cacheName] as Map<string, unknown>;
    const res = cache.has(this.getKey(key));

    loggers[cacheName]('has', key, res);
    recordPipelineCacheRequest(cacheName, 'has', res);
    return res;
  }

  public invalidate(cacheName: CacheNames, key: string): void {
    const cache = this[cacheName] as Map<string, unknown>;
    const cacheKey = this.getKey(key);

    if (!cache.has(cacheKey)) {
      return;
    }

    loggers[cacheName]('invalidate', key);

    if (cacheName === 'entrypoints') {
      this.snapshotEntrypointDependencies(
        key,
        cache.get(cacheKey) as TEntrypoint
      );
    }

    cache.delete(cacheKey);
    recordPipelineCacheClear(cacheName, 'invalidate', 1);
    this.clearCacheDependencies(cacheName, key);
  }

  public invalidateForFile(filename: string) {
    cacheNames.forEach((cacheName) => {
      this.invalidate(cacheName, filename);
    });

    const key = stripQueryAndHash(filename);
    const version = this.invalidatedFiles.get(key) ?? 0;
    this.invalidatedFiles.set(key, version + 1);
  }

  public consumeInvalidation(filename: string) {
    const key = stripQueryAndHash(filename);
    const invalidationVersion = this.invalidatedFiles.get(key);

    if (invalidationVersion === undefined) {
      return false;
    }

    const consumedVersion =
      this.consumedInvalidationVersions.get(filename) ?? 0;
    if (consumedVersion >= invalidationVersion) {
      return false;
    }

    this.consumedInvalidationVersions.set(filename, invalidationVersion);
    return true;
  }

  public invalidateIfChanged(
    filename: string,
    content: string,
    previousVisitedFiles?: Set<string>,
    source: 'fs' | 'loaded' = 'loaded',
    changedFiles = new Set<string>(),
    dependencyChangeMemo = new Map<string, boolean>(),
    forceContentCheck = false
  ) {
    return this.invalidateIfChangedInternal(
      filename,
      content,
      previousVisitedFiles,
      source,
      changedFiles,
      dependencyChangeMemo,
      forceContentCheck,
      new Set(),
      undefined
    );
  }

  public invalidateIfChangedWithDetails(
    filename: string,
    content: string,
    source: 'fs' | 'loaded' = 'loaded',
    graphTraversalToken?: object
  ): {
    changed: boolean;
    unknownDependencyGraphs: Set<string>;
  } {
    const graphTraversalTokenError = graphTraversalToken
      ? this.getGraphTraversalTokenError(graphTraversalToken)
      : null;
    if (graphTraversalTokenError) {
      // A file with its own unconverged recovery reports that, rather than the
      // generic staleness of the traversal it was retired with.
      throw this.pendingUnknownGraphs.has(filename)
        ? this.fileRecoveryErrors.get(filename)?.error ??
          graphTraversalTokenError
        : graphTraversalTokenError;
    }

    if (graphTraversalToken) {
      graphTraversalTokenStates.get(graphTraversalToken)?.visited.add(filename);
    }

    const pendingUnknownGraph = this.pendingUnknownGraphs.get(filename);
    const sourceHash = hashContent(content);
    const unknownDependencyGraphs = new Set<string>();
    if (pendingUnknownGraph) {
      if (pendingUnknownGraph.sourceHash !== sourceHash) {
        // A genuine root edit begins a new recovery lineage. Unknown edges
        // found while inspecting the new source below will be recorded
        // separately.
        this.pendingUnknownGraphs.delete(filename);
      } else if (pendingUnknownGraph.recoveryToken !== graphTraversalToken) {
        pendingUnknownGraph.dependencies.forEach((dependency) => {
          unknownDependencyGraphs.add(dependency);
        });
      }
    }
    const changed = this.invalidateIfChangedInternal(
      filename,
      content,
      undefined,
      source,
      new Set(),
      new Map(),
      false,
      unknownDependencyGraphs,
      graphTraversalToken
    );

    return { changed, unknownDependencyGraphs };
  }

  private invalidateIfChangedInternal(
    filename: string,
    content: string,
    previousVisitedFiles: Set<string> | undefined,
    source: 'fs' | 'loaded',
    changedFiles: Set<string>,
    dependencyChangeMemo: Map<string, boolean>,
    forceContentCheck: boolean,
    unknownDependencyGraphs: Set<string>,
    graphTraversalToken?: object
  ): boolean {
    if (changedFiles.has(filename)) {
      return true;
    }

    const visitedFiles = new Set(previousVisitedFiles);
    const fileEntrypoint = this.get('entrypoints', filename);
    let anyDepChanged = false;

    if (
      !visitedFiles.has(filename) &&
      (fileEntrypoint ||
        this.entrypointDependencySnapshots.has(this.getKey(filename)) ||
        this.hasCachedDependencies(filename))
    ) {
      visitedFiles.add(filename);
      const invalidateOnDependencyChange = this.getInvalidateOnDependencyChange(
        filename,
        fileEntrypoint
      );
      const dependenciesToCheck = this.getDependenciesToCheck(
        filename,
        fileEntrypoint
      );

      for (const [, dependency] of dependenciesToCheck) {
        const dependencyFilename = dependency.resolved;

        if (dependencyFilename) {
          const dependencyChanged = this.didDependencyChange(
            dependencyFilename,
            visitedFiles,
            changedFiles,
            dependencyChangeMemo,
            unknownDependencyGraphs,
            forceContentCheck ||
              invalidateOnDependencyChange?.has(dependencyFilename) ||
              false,
            graphTraversalToken
          );

          if (
            dependencyChanged &&
            invalidateOnDependencyChange?.has(dependencyFilename)
          ) {
            cacheLogger(
              'dependency affecting output has changed, invalidate all for %s',
              filename
            );
            this.invalidateForFile(filename);
            changedFiles.add(filename);

            return true;
          }

          if (dependencyChanged) {
            anyDepChanged = true;
          }
        }
      }
    }

    const existing = this.contentHashes.get(filename);
    const previousHash = existing?.[source];
    const newHash = hashContent(content);

    if (previousHash === undefined) {
      const otherSource = source === 'fs' ? 'loaded' : 'fs';
      const otherHash = existing?.[otherSource];
      const contentChanged = otherHash !== undefined && otherHash !== newHash;

      if (contentChanged || anyDepChanged) {
        cacheLogger('content has changed, invalidate all for %s', filename);
        this.setContentHash(filename, source, newHash);
        this.invalidateForFile(filename);
        if (contentChanged) {
          this.forgetEntrypointDependencySnapshot(filename);
        }
        changedFiles.add(filename);

        return true;
      }

      this.setContentHash(filename, source, newHash);
      return false;
    }

    const contentChanged = previousHash !== newHash;
    if (contentChanged || anyDepChanged) {
      cacheLogger('content has changed, invalidate all for %s', filename);
      this.setContentHash(filename, source, newHash);
      this.invalidateForFile(filename);
      if (contentChanged) {
        this.forgetEntrypointDependencySnapshot(filename);
      }
      changedFiles.add(filename);

      return true;
    }

    return false;
  }

  private getDependenciesToCheck(
    filename: string,
    fileEntrypoint?: TEntrypoint
  ): Map<string, { resolved: string | null }> {
    const dependenciesToCheck = new Map<string, { resolved: string | null }>();
    const snapshot = this.entrypointDependencySnapshots.get(
      this.getKey(filename)
    );
    const graphMayBeIncomplete = isEntrypointGraphIncomplete(fileEntrypoint);
    const dependencySources =
      fileEntrypoint && graphMayBeIncomplete && snapshot
        ? [snapshot, fileEntrypoint]
        : [fileEntrypoint ?? snapshot];

    for (const [sourceIndex, dependencySource] of dependencySources.entries()) {
      for (const [key, dependency] of dependencySource?.dependencies ?? []) {
        const graphKey =
          dependencySources.length === 1 ? key : `${sourceIndex}:${key}`;
        dependenciesToCheck.set(graphKey, dependency);
      }

      for (const [
        key,
        dependency,
      ] of dependencySource?.invalidationDependencies ?? []) {
        const graphKey =
          dependencySources.length === 1 ? key : `${sourceIndex}:${key}`;
        if (!dependenciesToCheck.has(graphKey)) {
          dependenciesToCheck.set(graphKey, dependency);
        }
      }
    }

    for (const dependencyFilename of this.getCachedDependencies(filename)) {
      if (
        ![...dependenciesToCheck.values()].some(
          (dependency) => dependency.resolved === dependencyFilename
        )
      ) {
        dependenciesToCheck.set(dependencyFilename, {
          resolved: dependencyFilename,
        });
      }
    }

    return dependenciesToCheck;
  }

  private getInvalidateOnDependencyChange(
    filename: string,
    fileEntrypoint?: TEntrypoint
  ): Set<string> | undefined {
    const snapshot = this.entrypointDependencySnapshots.get(
      this.getKey(filename)
    );
    if (
      fileEntrypoint &&
      isEntrypointGraphIncomplete(fileEntrypoint) &&
      snapshot
    ) {
      return new Set([
        ...(snapshot.invalidateOnDependencyChange ?? []),
        ...(fileEntrypoint.invalidateOnDependencyChange ?? []),
      ]);
    }

    return (
      fileEntrypoint?.invalidateOnDependencyChange ??
      snapshot?.invalidateOnDependencyChange
    );
  }

  private didDependencyChange(
    dependencyFilename: string,
    visitedFiles: Set<string>,
    changedFiles: Set<string>,
    dependencyChangeMemo: Map<string, boolean>,
    unknownDependencyGraphs: Set<string>,
    forceContentCheck = false,
    graphTraversalToken?: object
  ): boolean {
    if (changedFiles.has(dependencyFilename)) {
      return true;
    }

    const dependencyMemoKey = `${
      forceContentCheck ? 'forced' : 'normal'
    }\0${dependencyFilename}`;
    const memoized = dependencyChangeMemo.get(dependencyMemoKey);
    if (memoized !== undefined) {
      return memoized;
    }

    if (visitedFiles.has(dependencyFilename)) {
      return false;
    }

    if (graphTraversalToken) {
      graphTraversalTokenStates
        .get(graphTraversalToken)
        ?.visited.add(dependencyFilename);
    }

    const strippedDependencyFilename = stripQueryAndHash(dependencyFilename);
    const cachedMtime = this.fileMtimes.get(dependencyFilename);
    const cachedEntrypoint = this.get('entrypoints', dependencyFilename);
    const hasRetainedSnapshot = this.entrypointDependencySnapshots.has(
      this.getKey(dependencyFilename)
    );
    const graphMayBeIncomplete = isEntrypointGraphIncomplete(cachedEntrypoint);
    const hasKnownDependencyGraph = cachedEntrypoint
      ? !graphMayBeIncomplete || hasRetainedSnapshot
      : hasRetainedSnapshot;
    const allowUnknownDependencyGraph = this.canTraverseUnknownGraph(
      dependencyFilename,
      graphTraversalToken
    );
    if (!hasKnownDependencyGraph && !allowUnknownDependencyGraph) {
      // Record this independently of the mtime/hash fast path. The first
      // verification after a cache clear may need to seed its fs hash, but
      // reading the module's own bytes still cannot prove that its missing
      // transitive graph is complete.
      unknownDependencyGraphs.add(dependencyFilename);
    }

    if (cachedMtime !== undefined) {
      let currentMtime: number;

      try {
        currentMtime = fs.statSync(strippedDependencyFilename).mtimeMs;
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }

        this.invalidateForFile(dependencyFilename);
        this.forgetEntrypointDependencySnapshot(dependencyFilename);
        changedFiles.add(dependencyFilename);
        dependencyChangeMemo.set(dependencyMemoKey, true);
        return true;
      }

      if (currentMtime === cachedMtime) {
        const nestedDependencies = this.getDependenciesToCheck(
          dependencyFilename,
          cachedEntrypoint
        );

        if (
          forceContentCheck &&
          this.didFileContentHashChange(
            dependencyFilename,
            strippedDependencyFilename,
            changedFiles
          )
        ) {
          dependencyChangeMemo.set(dependencyMemoKey, true);
          return true;
        }

        const invalidateOnDependencyChange =
          this.getInvalidateOnDependencyChange(
            dependencyFilename,
            cachedEntrypoint
          );
        const fsHash = this.contentHashes.get(dependencyFilename)?.fs;
        const dependencyGraphIsUnknown =
          !hasKnownDependencyGraph || fsHash === undefined;
        if (dependencyGraphIsUnknown && !allowUnknownDependencyGraph) {
          unknownDependencyGraphs.add(dependencyFilename);
        }

        if (!cachedEntrypoint) {
          // A missing entrypoint can be cache churn. Verify its own source,
          // then continue through the lightweight dependency snapshot taken
          // when the entrypoint was evicted.
          if (
            !forceContentCheck &&
            this.didFileContentHashChange(
              dependencyFilename,
              strippedDependencyFilename,
              changedFiles
            )
          ) {
            dependencyChangeMemo.set(dependencyMemoKey, true);
            return true;
          }
        }

        if (nestedDependencies.size > 0) {
          const nextVisitedFiles = new Set(visitedFiles);
          nextVisitedFiles.add(dependencyFilename);

          for (const [, nestedDependency] of nestedDependencies) {
            if (
              nestedDependency.resolved &&
              this.didDependencyChange(
                nestedDependency.resolved,
                nextVisitedFiles,
                changedFiles,
                dependencyChangeMemo,
                unknownDependencyGraphs,
                forceContentCheck ||
                  invalidateOnDependencyChange?.has(
                    nestedDependency.resolved
                  ) ||
                  false,
                graphTraversalToken
              )
            ) {
              this.invalidateForFile(dependencyFilename);
              changedFiles.add(dependencyFilename);
              dependencyChangeMemo.set(dependencyMemoKey, true);
              return true;
            }
          }
        }

        if (dependencyGraphIsUnknown) {
          // Auxiliary export/barrel dependencies are useful edges, so inspect
          // them above and invalidate their caches when they change. They are
          // still only a partial graph, though. Without a complete entrypoint
          // graph, an evicted or unfinished module may hide another changed
          // transitive dependency. Remain fail-closed until a complete graph
          // is restored; the supersede guard bounds a failure to converge.
          cacheLogger(
            'dependency graph for %s is unknown, conservatively report as changed',
            dependencyFilename
          );
          dependencyChangeMemo.set(
            dependencyMemoKey,
            !allowUnknownDependencyGraph
          );
          return !allowUnknownDependencyGraph;
        }

        dependencyChangeMemo.set(dependencyMemoKey, false);
        return false;
      }
    }

    let dependencyContent: string;

    try {
      dependencyContent = fs.readFileSync(strippedDependencyFilename, 'utf8');
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      this.invalidateForFile(dependencyFilename);
      this.forgetEntrypointDependencySnapshot(dependencyFilename);
      changedFiles.add(dependencyFilename);
      dependencyChangeMemo.set(dependencyMemoKey, true);
      return true;
    }

    const invalidated = this.invalidateIfChangedInternal(
      dependencyFilename,
      dependencyContent,
      visitedFiles,
      'fs',
      changedFiles,
      dependencyChangeMemo,
      forceContentCheck,
      unknownDependencyGraphs,
      graphTraversalToken
    );

    const dependencyChanged =
      invalidated || (!hasKnownDependencyGraph && !allowUnknownDependencyGraph);
    if (!hasKnownDependencyGraph) {
      cacheLogger(
        'dependency graph for %s is unknown after content verification, conservatively report as changed',
        dependencyFilename
      );
    }
    dependencyChangeMemo.set(dependencyMemoKey, dependencyChanged);
    return dependencyChanged;
  }

  private canTraverseUnknownGraph(
    filename: string,
    graphTraversalToken?: object
  ): boolean {
    if (!graphTraversalToken) {
      return false;
    }

    const tokenState = graphTraversalTokenStates.get(graphTraversalToken);
    if (
      tokenState?.owner !== this ||
      tokenState.version !== this.lifecycleVersion
    ) {
      return false;
    }

    const pending = this.pendingUnknownGraphs.get(filename);
    return !pending || pending.recoveryToken === graphTraversalToken;
  }

  private didFileContentHashChange(
    filename: string,
    strippedFilename: string,
    changedFiles: Set<string>
  ): boolean {
    const previousHash = this.contentHashes.get(filename)?.fs;
    if (previousHash === undefined) {
      return false;
    }

    let content: string;
    try {
      content = fs.readFileSync(strippedFilename, 'utf8');
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      this.invalidateForFile(filename);
      this.forgetEntrypointDependencySnapshot(filename);
      changedFiles.add(filename);
      return true;
    }

    const nextHash = hashContent(content);
    if (previousHash === nextHash) {
      return false;
    }

    this.setContentHash(filename, 'fs', nextHash);
    this.invalidateForFile(filename);
    this.forgetEntrypointDependencySnapshot(filename);
    changedFiles.add(filename);
    return true;
  }

  public setCacheDependencies(
    cacheName: 'barrelManifests' | 'exports',
    key: string,
    dependencies: Iterable<string>
  ): void {
    const cache = this.getDependencyCache(cacheName);
    const nextDependencies = new Set(
      [...dependencies].filter((dependency) => dependency.length > 0)
    );
    const cacheKey = this.getKey(key);

    if (nextDependencies.size === 0) {
      cache.delete(cacheKey);
      return;
    }

    cache.set(cacheKey, nextDependencies);
  }

  /**
   * Fast check if a file changed on disk since last seen.
   * Uses mtime as a fast path and only reads the file if mtime differs.
   */
  public checkFreshness(filename: string, strippedFilename: string): boolean {
    try {
      const currentMtime = fs.statSync(strippedFilename).mtimeMs;
      const cachedMtime = this.fileMtimes.get(filename);

      if (cachedMtime !== undefined && currentMtime === cachedMtime) {
        return false;
      }

      const content = fs.readFileSync(strippedFilename, 'utf8');
      this.fileMtimes.set(filename, currentMtime);

      if (this.invalidateIfChanged(filename, content, undefined, 'fs')) {
        return true;
      }

      return false;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      this.invalidateForFile(filename);
      this.forgetEntrypointDependencySnapshot(filename);
      return true;
    }
  }

  private clearCacheDependencies(cacheName: CacheNames | 'all', key?: string) {
    if (cacheName === 'all') {
      this.barrelManifestDependencies.clear();
      this.exportDependencies.clear();
      return;
    }

    if (cacheName === 'barrelManifests') {
      if (key === undefined) {
        this.barrelManifestDependencies.clear();
      } else {
        this.barrelManifestDependencies.delete(this.getKey(key));
      }
      return;
    }

    if (cacheName === 'exports') {
      if (key === undefined) {
        this.exportDependencies.clear();
      } else {
        this.exportDependencies.delete(this.getKey(key));
      }
    }
  }

  private getCachedDependencies(filename: string): Set<string> {
    const key = this.getKey(filename);

    return new Set([
      ...(this.barrelManifestDependencies.get(key) ?? []),
      ...(this.exportDependencies.get(key) ?? []),
    ]);
  }

  private getDependencyCache(cacheName: 'barrelManifests' | 'exports') {
    return cacheName === 'barrelManifests'
      ? this.barrelManifestDependencies
      : this.exportDependencies;
  }

  private hasCachedDependencies(filename: string): boolean {
    return this.getCachedDependencies(filename).size > 0;
  }

  private snapshotEntrypointDependencies(
    filename: string,
    entrypoint: TEntrypoint
  ): void {
    if (
      entrypoint.isProcessing ||
      entrypoint.transformed === false ||
      entrypoint.hasTransformResult === false
    ) {
      // An unfinished entrypoint's dependency maps may be incomplete: take no
      // snapshot, but keep one from an earlier completed generation. The
      // previous complete graph still allows conservative dependency checks;
      // deleting it would force repeated unknown-graph invalidation.
      return;
    }

    const copy = (
      dependencies: Map<string, { resolved: string | null }> | undefined
    ): Map<string, { resolved: string | null }> =>
      new Map(
        Array.from(dependencies ?? [], ([key, dependency]) => [
          key,
          { resolved: dependency.resolved },
        ])
      );

    this.entrypointDependencySnapshots.set(this.getKey(filename), {
      dependencies: copy(entrypoint.dependencies),
      invalidationDependencies: copy(entrypoint.invalidationDependencies),
      invalidateOnDependencyChange: new Set(
        entrypoint.invalidateOnDependencyChange ?? []
      ),
    });
  }

  private forgetEntrypointDependencySnapshot(filename: string): void {
    this.entrypointDependencySnapshots.delete(this.getKey(filename));
  }

  private setContentHash(
    filename: string,
    source: 'fs' | 'loaded',
    hash: string
  ) {
    const current = this.contentHashes.get(filename);
    if (current) {
      current[source] = hash;
    } else {
      this.contentHashes.set(filename, { [source]: hash });
    }

    if (source === 'fs') {
      try {
        this.fileMtimes.set(
          filename,
          fs.statSync(stripQueryAndHash(filename)).mtimeMs
        );
      } catch {
        // ignore
      }
    }
  }
}
