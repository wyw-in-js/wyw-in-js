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
  ignored?: boolean;
  initialCode?: string;
  isProcessing?: boolean;
  processingStarted?: boolean;
  invalidateOnDependencyChange?: Set<string>;
  invalidationDependencies?: Map<string, { resolved: string | null }>;
  transformed?: boolean;
}

type EntrypointDependencySnapshot = Pick<
  IBaseCachedEntrypoint,
  'dependencies' | 'invalidationDependencies' | 'invalidateOnDependencyChange'
>;

interface IDependencyToCheck {
  resolved: string | null;
  // The parent only read this file (invalidation dependency or barrel
  // manifest entry) instead of importing it as a module.
  readOnly?: boolean;
}

const isEntrypointGraphIncomplete = (
  entrypoint: IBaseCachedEntrypoint | undefined
) =>
  // An ignored entrypoint (asset, file matched by an `ignore` rule) is never
  // processed, so it never gets a transform result. Its graph is complete and
  // empty; its own content hash is all there is to verify.
  !entrypoint?.ignored &&
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
}

const graphTraversalTokenStates = new WeakMap<
  object,
  { owner: IGraphTraversalTokenOwner; version: number }
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

  // Disk mtime observed when a bundler handed us the `loaded` code of a file.
  // Lets a later fs read tell "the loader chain transforms this file" (same
  // mtime, different bytes) apart from "the file changed on disk".
  private loadedMtimes = new Map<string, number>();

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

  private readonly pendingUnknownGraphs = new Map<
    string,
    {
      dependencies: Set<string>;
      recoveryToken: object;
      sourceHash: string;
    }
  >();

  // Files this cache has published as entrypoints in the current lifecycle,
  // evicted ones included. Only such a module can have lost a transitive graph
  // to an eviction. A file outside this set that a parent lists as an
  // invalidation or barrel-manifest dependency was merely read (static preeval,
  // side-effect provenance, barrel analysis); its content hash is the whole
  // contract.
  private readonly publishedEntrypoints = new Set<string>();

  constructor(caches: Partial<ICaches<TEntrypoint>> = {}) {
    this.barrelManifests = caches.barrelManifests || new Map();
    this.entrypoints = caches.entrypoints || new Map();
    this.exports = caches.exports || new Map();
    for (const key of this.entrypoints.keys()) {
      this.publishedEntrypoints.add(key);
    }
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
    this.publishedEntrypoints.clear();
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

  public createGraphTraversalToken(): object {
    const token = {};
    graphTraversalTokenStates.set(token, {
      owner: this,
      version: this.lifecycleVersion,
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

    return (
      owner.getLifecycleError(state.version) ??
      Object.assign(
        new Error(
          '[wyw-in-js] Dependency-graph traversal outlived its cache lifecycle.'
        ),
        { name: 'StaleDependencyGraphTraversalError' }
      )
    );
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

    this.beginFailClosedRecovery(error);
    graphTraversalTokenStates.set(recoveryToken, {
      owner: this,
      version: this.lifecycleVersion,
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

  public beginSupersedeStormRecovery(error: Error): void {
    this.beginFailClosedRecovery(error);
  }

  private beginFailClosedRecovery(error: Error): void {
    const pendingUnknownGraphs = new Map(this.pendingUnknownGraphs);
    const { resetVersion } = this;
    this.lifecycleVersion += 1;
    this.lifecycleError = error;
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
    this.loadedMtimes.clear();
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
      this.loadedMtimes.delete(key);
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
    if (cacheName === 'entrypoints') {
      this.publishedEntrypoints.add(key);
    }

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
      this.publishedEntrypoints.clear();
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
      throw graphTraversalTokenError;
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
    // A dependency whose graph is unknown is reported as changed to the caller
    // (invalidateIfChangedWithDetails also lists it), but it is not evidence
    // that this file is stale: only a verified change evicts.
    let anyDepGraphUnknown = false;

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
            graphTraversalToken,
            dependency.readOnly === true
          );

          if (dependencyChanged && !changedFiles.has(dependencyFilename)) {
            anyDepGraphUnknown = true;
          } else if (
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
          } else if (dependencyChanged) {
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
      // Loaded code routinely differs from the bytes on disk: any transpiling
      // loader before wyw produces that. When the first fs read of a file finds
      // the disk untouched since the bundler handed over its code, the mismatch
      // is representation only; seed the fs hash instead of evicting an
      // entrypoint the bundler still considers current. A moved mtime, or
      // loaded code arriving for a disk-built entrypoint, stays a real change.
      const contentChanged =
        otherHash !== undefined &&
        otherHash !== newHash &&
        !(source === 'fs' && this.isUnchangedOnDiskSinceLoad(filename));

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
      return anyDepGraphUnknown;
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

    return anyDepGraphUnknown;
  }

  private getDependenciesToCheck(
    filename: string,
    fileEntrypoint?: TEntrypoint
  ): Map<string, IDependencyToCheck> {
    const dependenciesToCheck = new Map<string, IDependencyToCheck>();
    const graphDependencies = new Set<string>();
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
        dependenciesToCheck.set(graphKey, { resolved: dependency.resolved });
        if (dependency.resolved) {
          graphDependencies.add(dependency.resolved);
        }
      }

      for (const [
        key,
        dependency,
      ] of dependencySource?.invalidationDependencies ?? []) {
        const graphKey =
          dependencySources.length === 1 ? key : `${sourceIndex}:${key}`;
        if (!dependenciesToCheck.has(graphKey)) {
          dependenciesToCheck.set(graphKey, {
            resolved: dependency.resolved,
            readOnly: true,
          });
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
          readOnly: true,
        });
      }
    }

    // The same file can be a module-graph edge under one specifier and an
    // invalidation dependency under another; the graph edge wins.
    for (const dependency of dependenciesToCheck.values()) {
      if (dependency.resolved && graphDependencies.has(dependency.resolved)) {
        dependency.readOnly = false;
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
    graphTraversalToken?: object,
    readOnly = false
  ): boolean {
    if (changedFiles.has(dependencyFilename)) {
      return true;
    }

    const dependencyMemoKey = `${forceContentCheck ? 'forced' : 'normal'}\0${
      readOnly ? 'read' : 'graph'
    }\0${dependencyFilename}`;
    const memoized = dependencyChangeMemo.get(dependencyMemoKey);
    if (memoized !== undefined) {
      return memoized;
    }

    if (visitedFiles.has(dependencyFilename)) {
      return false;
    }

    const strippedDependencyFilename = stripQueryAndHash(dependencyFilename);
    const cachedMtime = this.fileMtimes.get(dependencyFilename);
    const cachedEntrypoint = this.get('entrypoints', dependencyFilename);
    const hasRetainedSnapshot = this.entrypointDependencySnapshots.has(
      this.getKey(dependencyFilename)
    );
    const graphMayBeIncomplete = isEntrypointGraphIncomplete(cachedEntrypoint);
    // A file the parent only read has no transitive graph to lose when this
    // cache never processed it as a module. Static preeval, side-effect
    // provenance and barrel analysis register the files they read through
    // checkFreshness (no entrypoint, no snapshot) or through an analysis root
    // (Entrypoint.createRoot in resolveDependency and rewriteOxcBarrelImports)
    // that only resolves imports and never starts processing. Its content hash
    // is the whole contract, and its partially filled dependency map is not a
    // graph to traverse. The same holds while a concurrent transform is still
    // processing the file as a module: the reader consumed the bytes, not the
    // module's imports, and the in-flight entrypoint verified those bytes
    // against the cache when it was created. Module-graph edges, modules that
    // stopped processing without a result and evicted once-published modules
    // stay fail-closed.
    const isReadOnlyLeaf =
      readOnly &&
      (cachedEntrypoint
        ? cachedEntrypoint.isProcessing === true ||
          (cachedEntrypoint.processingStarted === false && !hasRetainedSnapshot)
        : !this.publishedEntrypoints.has(dependencyFilename));
    const hasKnownDependencyGraph =
      isReadOnlyLeaf ||
      (cachedEntrypoint
        ? !graphMayBeIncomplete || hasRetainedSnapshot
        : hasRetainedSnapshot);
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
        // An analysis root's dependency map only holds the imports it resolved
        // for the reader; barrel and export dependencies of a never-loaded
        // file are still useful edges.
        const nestedDependencies =
          isReadOnlyLeaf && cachedEntrypoint
            ? new Map<string, IDependencyToCheck>()
            : this.getDependenciesToCheck(dependencyFilename, cachedEntrypoint);

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

        let nestedGraphIsUnknown = false;
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
                graphTraversalToken,
                nestedDependency.readOnly === true
              )
            ) {
              if (changedFiles.has(nestedDependency.resolved)) {
                this.invalidateForFile(dependencyFilename);
                changedFiles.add(dependencyFilename);
                dependencyChangeMemo.set(dependencyMemoKey, true);
                return true;
              }

              // The nested graph could not be verified, but nothing in it is
              // known to have changed. Report that upwards without evicting
              // this module: a module that is still processing would never
              // get a snapshot, and its transform result would land on an
              // object the cache no longer holds, leaving a once-published
              // file without a graph for the rest of the lifecycle.
              nestedGraphIsUnknown = true;
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

        dependencyChangeMemo.set(dependencyMemoKey, nestedGraphIsUnknown);
        return nestedGraphIsUnknown;
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

    // Marking an analysis root as visited skips its dependency traversal and
    // leaves the content comparison, for the same reason as above.
    const visitedFilesForContentCheck =
      isReadOnlyLeaf && cachedEntrypoint
        ? new Set([...visitedFiles, dependencyFilename])
        : visitedFiles;
    const invalidated = this.invalidateIfChangedInternal(
      dependencyFilename,
      dependencyContent,
      visitedFilesForContentCheck,
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
    if (isEntrypointGraphIncomplete(entrypoint)) {
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

  private isUnchangedOnDiskSinceLoad(filename: string): boolean {
    const loadedMtime = this.loadedMtimes.get(filename);
    if (loadedMtime === undefined) {
      return false;
    }

    try {
      return fs.statSync(stripQueryAndHash(filename)).mtimeMs === loadedMtime;
    } catch {
      return false;
    }
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

    try {
      const { mtimeMs } = fs.statSync(stripQueryAndHash(filename));
      if (source === 'fs') {
        this.fileMtimes.set(filename, mtimeMs);
      } else {
        this.loadedMtimes.set(filename, mtimeMs);
      }
    } catch {
      // ignore
    }
  }
}
