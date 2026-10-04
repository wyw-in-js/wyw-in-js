import fs from 'node:fs';
import { logger } from '@wyw-in-js/shared';

import type { TransformCacheEpoch } from './cacheLifecycle';
import { isFileStatUnchanged, readFileStat, type FileStat } from './fileStat';
import { LoadedSources } from './loadedSource';
import {
  createDependencySnapshot,
  getEffectiveInvalidationDependencies,
  hashContent,
  type IBaseCachedEntrypoint,
  isEntrypointGraphIncomplete,
  isMissingFileError,
  type EntrypointDependencySnapshot,
  type DependencyToCheck,
} from './cacheTypes';
import { stripQueryAndHash } from '../utils/parseRequest';

const cacheLogger = logger.extend('cache');

export interface PendingUnknownGraph {
  dependencies: Set<string>;
  recoveryToken: object;
  sourceHash: string;
}

export abstract class CacheFreshness<
  TEntrypoint extends IBaseCachedEntrypoint,
> {
  private readonly barrelManifestDependencies = new Map<string, Set<string>>();

  private contentHashes = new Map<string, { fs?: string; loaded?: string }>();

  protected readonly loadedSources = new LoadedSources();

  private readonly pendingContentHashSynchronizations = new Map<
    string,
    { hash: string; source: 'fs' | 'loaded' }
  >();

  private fileStats = new Map<string, FileStat>();

  protected readonly publishedEntrypoints = new Set<string>();

  private readonly exportDependencies = new Map<string, Set<string>>();

  private readonly entrypointDependencySnapshots = new Map<
    string,
    EntrypointDependencySnapshot
  >();

  private invalidationVersion = 0;

  private readonly changedFileVersions = new Map<string, number>();

  private readonly entrypointInvalidationVersions = new WeakMap<
    object,
    number
  >();

  private invalidatedFiles = new Map<string, number>();

  private consumedInvalidationVersions = new Map<string, number>();

  /** @internal */
  protected abstract assertEpoch(epoch: TransformCacheEpoch): void;

  /** @internal */
  protected abstract canTraverseUnknownGraph(
    filename: string,
    graphTraversalToken?: object
  ): boolean;

  /** @internal */
  protected abstract deletePendingUnknownGraph(filename: string): void;

  /** @internal */
  protected abstract getCurrentEpoch(): TransformCacheEpoch;

  /** @internal */
  protected abstract getEntrypoint(filename: string): TEntrypoint | undefined;

  /** @internal */
  protected abstract getKey(key: string): string;

  /** @internal */
  protected abstract getPendingUnknownGraph(
    filename: string
  ): PendingUnknownGraph | undefined;

  /** @internal */
  protected abstract invalidateCache(
    cacheName: 'barrelManifests' | 'entrypoints' | 'exports',
    key: string
  ): void;

  /** @internal */
  protected abstract validateGraphTraversal(
    filename: string,
    graphTraversalToken?: object
  ): void;

  protected clearFreshness(
    cacheName: 'barrelManifests' | 'entrypoints' | 'exports' | 'all',
    key?: string
  ): void {
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

  protected clearFreshnessForKeySalt(): void {
    this.loadedSources.clear();
    this.publishedEntrypoints.clear();
    this.entrypointDependencySnapshots.clear();
    this.pendingContentHashSynchronizations.clear();
    this.clearFreshness('all');
  }

  protected clearPendingContentHashSynchronizations(): void {
    this.pendingContentHashSynchronizations.clear();
  }

  protected forgetCacheValue(
    cacheName: 'barrelManifests' | 'entrypoints' | 'exports',
    key: string
  ): void {
    this.contentHashes.delete(key);
    this.loadedSources.delete(key);
    this.pendingContentHashSynchronizations.delete(key);
    if (cacheName === 'entrypoints') {
      this.entrypointDependencySnapshots.delete(this.getKey(key));
    }
    this.clearFreshness(cacheName, key);
  }

  protected migrateFreshnessKeys(remap: (key: string) => string): void {
    const migrate = <TValue>(cache: Map<string, TValue>) => {
      const entries = Array.from(cache.entries());
      cache.clear();
      entries.forEach(([key, value]) => {
        cache.set(remap(key), value);
      });
    };

    migrate(this.barrelManifestDependencies);
    migrate(this.entrypointDependencySnapshots);
    migrate(this.exportDependencies);
    const published = [...this.publishedEntrypoints];
    this.publishedEntrypoints.clear();
    published.forEach((key) => this.publishedEntrypoints.add(remap(key)));
  }

  protected onEntrypointsCleared(): void {
    this.loadedSources.clear();
    this.publishedEntrypoints.clear();
    this.entrypointDependencySnapshots.clear();
    this.pendingContentHashSynchronizations.clear();
  }

  protected recordCachePublication(
    cacheName: 'barrelManifests' | 'entrypoints' | 'exports',
    key: string,
    value: unknown
  ): void {
    if (cacheName === 'entrypoints') {
      this.publishedEntrypoints.add(this.getKey(key));
      if (
        value &&
        typeof value === 'object' &&
        !this.entrypointInvalidationVersions.has(value)
      ) {
        this.entrypointInvalidationVersions.set(
          value,
          this.invalidationVersion
        );
      }
    }
    if (value && typeof value === 'object' && 'initialCode' in value) {
      const entrypoint = value as {
        initialCode?: unknown;
        originalCode?: unknown;
      };
      const isLoaded = typeof entrypoint.initialCode === 'string';
      const source = isLoaded ? 'loaded' : 'fs';
      let resolvedCode: string | undefined;
      if (isLoaded) {
        resolvedCode = entrypoint.initialCode as string;
      } else if (typeof entrypoint.originalCode === 'string') {
        resolvedCode = entrypoint.originalCode;
      }

      if (typeof resolvedCode === 'string') {
        this.setContentHash(
          key,
          source,
          hashContent(resolvedCode),
          true,
          resolvedCode
        );
        return;
      }

      try {
        const fileContent = fs.readFileSync(stripQueryAndHash(key), 'utf8');
        this.setContentHash(key, source, hashContent(fileContent), true);
      } catch {
        this.setContentHash(key, source, hashContent(''), true);
      }
      return;
    }

    if (cacheName === 'barrelManifests' || cacheName === 'exports') {
      try {
        const fileContent = fs.readFileSync(stripQueryAndHash(key), 'utf8');
        this.setContentHash(key, 'fs', hashContent(fileContent), true);
      } catch {
        this.setContentHash(key, 'fs', hashContent(''), true);
      }
    }
  }

  protected resetFreshness(): void {
    this.loadedSources.clear();
    this.contentHashes.clear();
    this.pendingContentHashSynchronizations.clear();
    this.fileStats.clear();
    this.invalidatedFiles.clear();
    this.changedFileVersions.clear();
    this.consumedInvalidationVersions.clear();
  }

  /** @internal Recover preceding loader output after dependency invalidation. */
  public getLoadedCode(filename: string, diskCode: string): string | undefined {
    return this.loadedSources.get(filename, hashContent(diskCode));
  }

  protected snapshotEntrypointDependencies(
    filename: string,
    entrypoint: TEntrypoint
  ): void {
    if (isEntrypointGraphIncomplete(entrypoint)) {
      // An unfinished entrypoint's dependency maps may be incomplete: keep a
      // snapshot from an earlier completed generation instead.
      return;
    }

    this.entrypointDependencySnapshots.set(
      this.getKey(filename),
      createDependencySnapshot(
        entrypoint,
        this.entrypointInvalidationVersions.get(entrypoint) ?? 0
      )
    );
  }

  protected snapshotReplacedEntrypoint(
    key: string,
    previous: TEntrypoint | undefined,
    value: TEntrypoint
  ): void {
    if (previous && previous !== value) {
      this.snapshotEntrypointDependencies(key, previous);
      if (!this.entrypointInvalidationVersions.has(value)) {
        this.entrypointInvalidationVersions.set(
          value,
          this.entrypointInvalidationVersions.get(previous) ?? 0
        );
      }
    }
  }

  public invalidateForFile(filename: string): void {
    this.pendingContentHashSynchronizations.delete(filename);
    (['barrelManifests', 'entrypoints', 'exports'] as const).forEach(
      (cacheName) => {
        this.invalidateCache(cacheName, filename);
      }
    );
    this.markInvalidated(filename);
  }

  private invalidateChangedFile(filename: string): void {
    this.invalidateForFile(filename);
    this.invalidationVersion += 1;
    this.changedFileVersions.set(
      stripQueryAndHash(filename),
      this.invalidationVersion
    );
  }

  protected markInvalidated(filename: string): void {
    const key = stripQueryAndHash(filename);
    const version = this.invalidatedFiles.get(key) ?? 0;
    this.invalidatedFiles.set(key, version + 1);
  }

  public consumeInvalidation(filename: string): boolean {
    const key = stripQueryAndHash(filename);
    const invalidationVersion = this.invalidatedFiles.get(key);
    if (invalidationVersion === undefined) return false;

    const consumedVersion =
      this.consumedInvalidationVersions.get(filename) ?? 0;
    if (consumedVersion >= invalidationVersion) return false;

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
  ): boolean {
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
    source?: 'fs' | 'loaded',
    graphTraversalToken?: object
  ): { changed: boolean; unknownDependencyGraphs: Set<string> };

  /** @internal An explicit epoch may only come from a transform attempt. */
  public invalidateIfChangedWithDetails(
    filename: string,
    content: string,
    source: 'fs' | 'loaded' | undefined,
    graphTraversalToken: object | undefined,
    epoch: TransformCacheEpoch
  ): { changed: boolean; unknownDependencyGraphs: Set<string> };

  public invalidateIfChangedWithDetails(
    filename: string,
    content: string,
    source: 'fs' | 'loaded' = 'loaded',
    graphTraversalToken?: object,
    epoch: TransformCacheEpoch = this.getCurrentEpoch()
  ): { changed: boolean; unknownDependencyGraphs: Set<string> } {
    this.assertEpoch(epoch);
    this.validateGraphTraversal(filename, graphTraversalToken);

    const pendingUnknownGraph = this.getPendingUnknownGraph(filename);
    const sourceHash = hashContent(content);
    const unknownDependencyGraphs = new Set<string>();
    if (pendingUnknownGraph) {
      if (pendingUnknownGraph.sourceHash !== sourceHash) {
        this.deletePendingUnknownGraph(filename);
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
    if (changedFiles.has(filename)) return true;

    const visitedFiles = new Set(previousVisitedFiles);
    const fileEntrypoint = this.getEntrypoint(filename);
    let anyDepChanged = false;
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
        // The loop continues with the next dependency when resolution failed.
        // eslint-disable-next-line no-continue
        if (!dependencyFilename) continue;

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
          dependency.readOnly === true,
          this.getEntrypointInvalidationVersion(filename, fileEntrypoint)
        );
        if (dependencyChanged && !changedFiles.has(dependencyFilename)) {
          anyDepGraphUnknown = true;
          // Unknown is not evidence of a changed dependency. Keep the active
          // generation so it can complete the graph; the caller still sees
          // the unknown graph and must not reuse it without recovery.
        } else if (
          dependencyChanged &&
          invalidateOnDependencyChange?.has(dependencyFilename)
        ) {
          cacheLogger(
            'dependency affecting output has changed, invalidate all for %s',
            filename
          );
          this.invalidateChangedFile(filename);
          changedFiles.add(filename);
          return true;
        } else if (dependencyChanged) {
          anyDepChanged = true;
        }
      }
    }

    const existing = this.contentHashes.get(filename);
    const previousHash = existing?.[source];
    const newHash = hashContent(content);
    const otherSource = source === 'fs' ? 'loaded' : 'fs';
    const otherHash = existing?.[otherSource];
    const pendingSynchronization =
      this.pendingContentHashSynchronizations.get(filename);
    const isExpectedSynchronization =
      previousHash !== newHash &&
      pendingSynchronization?.source === source &&
      pendingSynchronization.hash === newHash;
    const contentChanged =
      previousHash === undefined
        ? otherHash !== undefined &&
          otherHash !== newHash &&
          !isExpectedSynchronization
        : previousHash !== newHash && !isExpectedSynchronization;

    if (contentChanged || anyDepChanged) {
      cacheLogger('content has changed, invalidate all for %s', filename);
      this.setContentHash(filename, source, newHash, false, content);
      this.invalidateChangedFile(filename);
      if (contentChanged) {
        this.forgetEntrypointDependencySnapshot(filename);
        this.expectContentHashSynchronization(
          filename,
          otherSource,
          otherHash,
          newHash
        );
      }
      changedFiles.add(filename);
      return true;
    }

    if (previousHash !== newHash) {
      this.setContentHash(filename, source, newHash, false, content);
    }
    return anyDepGraphUnknown;
  }

  private getEntrypointInvalidationVersion(
    filename: string,
    entrypoint?: TEntrypoint
  ): number {
    return entrypoint
      ? this.entrypointInvalidationVersions.get(entrypoint) ?? 0
      : this.entrypointDependencySnapshots.get(this.getKey(filename))
          ?.invalidationVersion ?? this.invalidationVersion;
  }

  private getDependenciesToCheck(
    filename: string,
    fileEntrypoint?: TEntrypoint
  ): Map<string, DependencyToCheck> {
    const dependenciesToCheck = new Map<string, DependencyToCheck>();
    const graphDependencies = new Set<string>();
    const snapshot = this.entrypointDependencySnapshots.get(
      this.getKey(filename)
    );
    const graphMayBeIncomplete = isEntrypointGraphIncomplete(fileEntrypoint);
    const sources =
      fileEntrypoint && graphMayBeIncomplete && snapshot
        ? [snapshot, fileEntrypoint]
        : [fileEntrypoint ?? snapshot];

    for (const [sourceIndex, source] of sources.entries()) {
      for (const [key, dependency] of source?.dependencies ?? []) {
        const graphKey = sources.length === 1 ? key : `${sourceIndex}:${key}`;
        dependenciesToCheck.set(graphKey, { resolved: dependency.resolved });
        if (dependency.resolved) {
          graphDependencies.add(dependency.resolved);
        }
      }

      for (const [key, dependency] of source?.invalidationDependencies ?? []) {
        const graphKey = sources.length === 1 ? key : `${sourceIndex}:${key}`;
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
    return getEffectiveInvalidationDependencies(fileEntrypoint, snapshot);
  }

  private didDependencyChange(
    dependencyFilename: string,
    visitedFiles: Set<string>,
    changedFiles: Set<string>,
    dependencyChangeMemo: Map<string, boolean>,
    unknownDependencyGraphs: Set<string>,
    forceContentCheck = false,
    graphTraversalToken?: object,
    readOnly = false,
    consumerInvalidationVersion = this.invalidationVersion
  ): boolean {
    if (changedFiles.has(dependencyFilename)) return true;
    const memoKey = `${forceContentCheck ? 'forced' : 'normal'}\0${
      readOnly ? 'read' : 'graph'
    }\0${consumerInvalidationVersion}\0${dependencyFilename}`;
    const memoized = dependencyChangeMemo.get(memoKey);
    if (memoized !== undefined) return memoized;
    if (visitedFiles.has(dependencyFilename)) return false;

    const strippedFilename = stripQueryAndHash(dependencyFilename);
    const cachedStat = this.fileStats.get(dependencyFilename);
    const cachedEntrypoint = this.getEntrypoint(dependencyFilename);
    const hasSnapshot = this.entrypointDependencySnapshots.has(
      this.getKey(dependencyFilename)
    );
    // A read-only consumer depends on the bytes it actually read, not on
    // an analysis/in-flight module's unfinished imports. Executable edges and
    // evicted previously-published modules still need a complete graph.
    const isReadOnlyLeaf =
      readOnly &&
      (cachedEntrypoint
        ? cachedEntrypoint.isProcessing === true ||
          (cachedEntrypoint.processingStarted === false && !hasSnapshot)
        : !this.publishedEntrypoints.has(this.getKey(dependencyFilename)));
    const hasKnownGraph =
      isReadOnlyLeaf ||
      (cachedEntrypoint
        ? !isEntrypointGraphIncomplete(cachedEntrypoint) || hasSnapshot
        : hasSnapshot);
    const allowUnknownGraph = this.canTraverseUnknownGraph(
      dependencyFilename,
      graphTraversalToken
    );
    if (!hasKnownGraph && !allowUnknownGraph) {
      unknownDependencyGraphs.add(dependencyFilename);
    }

    // Another consumer may already have refreshed this file's shared hash.
    // That does not make outputs published before its invalidation current.
    if (
      (this.changedFileVersions.get(stripQueryAndHash(dependencyFilename)) ??
        0) > consumerInvalidationVersion
    ) {
      changedFiles.add(dependencyFilename);
      return true;
    }

    if (cachedStat !== undefined) {
      let currentStat: FileStat;
      try {
        currentStat = readFileStat(strippedFilename);
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
        return this.recordMissingDependency(
          dependencyFilename,
          changedFiles,
          dependencyChangeMemo,
          memoKey
        );
      }

      if (isFileStatUnchanged(currentStat, cachedStat)) {
        const dependencies =
          isReadOnlyLeaf && cachedEntrypoint
            ? new Map<string, DependencyToCheck>()
            : this.getDependenciesToCheck(dependencyFilename, cachedEntrypoint);
        if (
          forceContentCheck &&
          this.didFileContentHashChange(
            dependencyFilename,
            strippedFilename,
            changedFiles
          )
        ) {
          dependencyChangeMemo.set(memoKey, true);
          return true;
        }

        const invalidateOnDependencyChange =
          this.getInvalidateOnDependencyChange(
            dependencyFilename,
            cachedEntrypoint
          );
        const graphIsUnknown =
          !hasKnownGraph ||
          this.contentHashes.get(dependencyFilename)?.fs === undefined;
        if (graphIsUnknown && !allowUnknownGraph) {
          unknownDependencyGraphs.add(dependencyFilename);
        }
        if (
          !cachedEntrypoint &&
          !forceContentCheck &&
          this.didFileContentHashChange(
            dependencyFilename,
            strippedFilename,
            changedFiles
          )
        ) {
          dependencyChangeMemo.set(memoKey, true);
          return true;
        }

        let nestedGraphIsUnknown = false;
        if (dependencies.size > 0) {
          const nextVisitedFiles = new Set(visitedFiles);
          nextVisitedFiles.add(dependencyFilename);
          for (const [, nestedDependency] of dependencies) {
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
                nestedDependency.readOnly === true,
                this.getEntrypointInvalidationVersion(
                  dependencyFilename,
                  cachedEntrypoint
                )
              )
            ) {
              if (changedFiles.has(nestedDependency.resolved)) {
                this.invalidateChangedFile(dependencyFilename);
                changedFiles.add(dependencyFilename);
                dependencyChangeMemo.set(memoKey, true);
                return true;
              }
              nestedGraphIsUnknown = true;
            }
          }
        }

        if (graphIsUnknown) {
          cacheLogger(
            'dependency graph for %s is unknown, conservatively report as changed',
            dependencyFilename
          );
          dependencyChangeMemo.set(memoKey, !allowUnknownGraph);
          return !allowUnknownGraph;
        }
        dependencyChangeMemo.set(memoKey, nestedGraphIsUnknown);
        return nestedGraphIsUnknown;
      }
    }

    let dependencyContent: string;
    try {
      dependencyContent = fs.readFileSync(strippedFilename, 'utf8');
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      return this.recordMissingDependency(
        dependencyFilename,
        changedFiles,
        dependencyChangeMemo,
        memoKey
      );
    }

    const invalidated = this.invalidateIfChangedInternal(
      dependencyFilename,
      dependencyContent,
      isReadOnlyLeaf && cachedEntrypoint
        ? new Set([...visitedFiles, dependencyFilename])
        : visitedFiles,
      'fs',
      changedFiles,
      dependencyChangeMemo,
      forceContentCheck,
      unknownDependencyGraphs,
      graphTraversalToken
    );
    const dependencyChanged =
      invalidated || (!hasKnownGraph && !allowUnknownGraph);
    if (!hasKnownGraph) {
      cacheLogger(
        'dependency graph for %s is unknown after content verification, conservatively report as changed',
        dependencyFilename
      );
    }
    dependencyChangeMemo.set(memoKey, dependencyChanged);
    return dependencyChanged;
  }

  private recordMissingDependency(
    filename: string,
    changedFiles: Set<string>,
    memo: Map<string, boolean>,
    memoKey: string
  ): true {
    this.invalidateChangedFile(filename);
    this.forgetEntrypointDependencySnapshot(filename);
    changedFiles.add(filename);
    memo.set(memoKey, true);
    return true;
  }

  private didFileContentHashChange(
    filename: string,
    strippedFilename: string,
    changedFiles: Set<string>
  ): boolean {
    const previousHash = this.contentHashes.get(filename)?.fs;
    if (previousHash === undefined) return false;

    const recordedFingerprint = this.fileStats.get(filename)?.fingerprint;
    if (recordedFingerprint) {
      try {
        if (
          readFileStat(strippedFilename).fingerprint === recordedFingerprint
        ) {
          return false;
        }
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
    }

    let content: string;
    try {
      content = fs.readFileSync(strippedFilename, 'utf8');
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      this.invalidateChangedFile(filename);
      this.forgetEntrypointDependencySnapshot(filename);
      changedFiles.add(filename);
      return true;
    }

    const nextHash = hashContent(content);
    if (previousHash === nextHash) return false;

    this.setContentHash(filename, 'fs', nextHash);
    this.invalidateChangedFile(filename);
    this.forgetEntrypointDependencySnapshot(filename);
    this.expectContentHashSynchronization(
      filename,
      'loaded',
      this.contentHashes.get(filename)?.loaded,
      nextHash
    );
    changedFiles.add(filename);
    return true;
  }

  public setCacheDependencies(
    cacheName: 'barrelManifests' | 'exports',
    key: string,
    dependencies: Iterable<string>
  ): void {
    const cache =
      cacheName === 'barrelManifests'
        ? this.barrelManifestDependencies
        : this.exportDependencies;
    const nextDependencies = new Set(
      [...dependencies].filter((dependency) => dependency.length > 0)
    );
    const cacheKey = this.getKey(key);
    if (nextDependencies.size === 0) cache.delete(cacheKey);
    else cache.set(cacheKey, nextDependencies);
  }

  /** @internal Cache writes must be fenced by a transform attempt's epoch. */
  public publishCacheDependencies(
    epoch: TransformCacheEpoch,
    cacheName: 'barrelManifests' | 'exports',
    key: string,
    dependencies: Iterable<string>
  ): void {
    this.assertEpoch(epoch);
    this.setCacheDependencies(cacheName, key, dependencies);
  }

  public checkFreshness(filename: string, strippedFilename: string): boolean {
    try {
      const currentStat = readFileStat(strippedFilename);
      if (isFileStatUnchanged(currentStat, this.fileStats.get(filename))) {
        return false;
      }

      const content = fs.readFileSync(strippedFilename, 'utf8');
      this.fileStats.set(filename, currentStat);
      return this.invalidateIfChanged(filename, content, undefined, 'fs');
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      this.invalidateChangedFile(filename);
      this.forgetEntrypointDependencySnapshot(filename);
      return true;
    }
  }

  private getCachedDependencies(filename: string): Set<string> {
    const key = this.getKey(filename);
    return new Set([
      ...(this.barrelManifestDependencies.get(key) ?? []),
      ...(this.exportDependencies.get(key) ?? []),
    ]);
  }

  private hasCachedDependencies(filename: string): boolean {
    return this.getCachedDependencies(filename).size > 0;
  }

  private forgetEntrypointDependencySnapshot(filename: string): void {
    this.entrypointDependencySnapshots.delete(this.getKey(filename));
  }

  private setContentHash(
    filename: string,
    source: 'fs' | 'loaded',
    hash: string,
    isPublication = false,
    loadedCode?: string
  ): void {
    const pending = this.pendingContentHashSynchronizations.get(filename);
    if (
      pending?.source === source &&
      (isPublication || pending.hash === hash)
    ) {
      this.pendingContentHashSynchronizations.delete(filename);
    }

    const current = this.contentHashes.get(filename);
    // A loader may change the representation of the source. Capture the raw
    // baseline when first accepting loaded code, rather than comparing its
    // bytes with transformed output or trusting an unchanged timestamp later.
    // Republishing the same loaded revision must not hide an intervening edit.
    const captureDiskBaseline = source === 'loaded' && current?.loaded !== hash;
    if (current) current[source] = hash;
    else this.contentHashes.set(filename, { [source]: hash });

    if (captureDiskBaseline) {
      try {
        const diskCode = fs.readFileSync(stripQueryAndHash(filename), 'utf8');
        this.contentHashes.get(filename)!.fs = hashContent(diskCode);
        // This is a baseline, not a freshness probe. The first probe must
        // still read bytes even if the timestamp did not move.
        this.fileStats.delete(filename);
      } catch {
        // Virtual/missing sources have no raw baseline. A later unmatched fs
        // revision stays conservative; never infer equivalence from mtime.
      }
    }

    if (source === 'loaded' && loadedCode !== undefined) {
      this.loadedSources.record(
        filename,
        loadedCode,
        this.contentHashes.get(filename)?.fs
      );
    }

    if (source === 'fs') {
      try {
        this.fileStats.set(filename, readFileStat(stripQueryAndHash(filename)));
      } catch {
        // ignore
      }
    }
  }

  private expectContentHashSynchronization(
    filename: string,
    source: 'fs' | 'loaded',
    previousHash: string | undefined,
    nextHash: string
  ): void {
    if (previousHash === undefined || previousHash === nextHash) return;
    this.pendingContentHashSynchronizations.set(filename, {
      hash: nextHash,
      source,
    });
  }
}
