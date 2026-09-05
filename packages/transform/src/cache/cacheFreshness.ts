import fs from 'node:fs';
import { logger } from '@wyw-in-js/shared';

import type { TransformCacheEpoch } from './cacheLifecycle';
import {
  hashContent,
  type IBaseCachedEntrypoint,
  isEntrypointGraphIncomplete,
  isMissingFileError,
  type EntrypointDependencySnapshot,
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

  private readonly pendingContentHashSynchronizations = new Map<
    string,
    { hash: string; source: 'fs' | 'loaded' }
  >();

  private fileMtimes = new Map<string, number>();

  private readonly exportDependencies = new Map<string, Set<string>>();

  private readonly entrypointDependencySnapshots = new Map<
    string,
    EntrypointDependencySnapshot
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
  }

  protected onEntrypointsCleared(): void {
    this.entrypointDependencySnapshots.clear();
    this.pendingContentHashSynchronizations.clear();
  }

  protected recordCachePublication(
    cacheName: 'barrelManifests' | 'entrypoints' | 'exports',
    key: string,
    value: unknown
  ): void {
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
        this.setContentHash(key, source, hashContent(resolvedCode), true);
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
    this.contentHashes.clear();
    this.pendingContentHashSynchronizations.clear();
    this.fileMtimes.clear();
    this.invalidatedFiles.clear();
    this.consumedInvalidationVersions.clear();
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

  protected snapshotReplacedEntrypoint(
    key: string,
    previous: TEntrypoint | undefined,
    value: TEntrypoint
  ): void {
    if (previous && previous !== value) {
      this.snapshotEntrypointDependencies(key, previous);
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
        if (dependencyChanged) anyDepChanged = true;
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
      this.setContentHash(filename, source, newHash);
      this.invalidateForFile(filename);
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
      this.setContentHash(filename, source, newHash);
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
    const sources =
      fileEntrypoint && graphMayBeIncomplete && snapshot
        ? [snapshot, fileEntrypoint]
        : [fileEntrypoint ?? snapshot];

    for (const [sourceIndex, source] of sources.entries()) {
      for (const [key, dependency] of source?.dependencies ?? []) {
        dependenciesToCheck.set(
          sources.length === 1 ? key : `${sourceIndex}:${key}`,
          dependency
        );
      }
      for (const [key, dependency] of source?.invalidationDependencies ?? []) {
        const graphKey = sources.length === 1 ? key : `${sourceIndex}:${key}`;
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
    if (changedFiles.has(dependencyFilename)) return true;

    const memoKey = `${
      forceContentCheck ? 'forced' : 'normal'
    }\0${dependencyFilename}`;
    const memoized = dependencyChangeMemo.get(memoKey);
    if (memoized !== undefined) return memoized;
    if (visitedFiles.has(dependencyFilename)) return false;

    const strippedFilename = stripQueryAndHash(dependencyFilename);
    const cachedMtime = this.fileMtimes.get(dependencyFilename);
    const cachedEntrypoint = this.getEntrypoint(dependencyFilename);
    const hasSnapshot = this.entrypointDependencySnapshots.has(
      this.getKey(dependencyFilename)
    );
    const hasKnownGraph = cachedEntrypoint
      ? !isEntrypointGraphIncomplete(cachedEntrypoint) || hasSnapshot
      : hasSnapshot;
    const allowUnknownGraph = this.canTraverseUnknownGraph(
      dependencyFilename,
      graphTraversalToken
    );
    if (!hasKnownGraph && !allowUnknownGraph) {
      unknownDependencyGraphs.add(dependencyFilename);
    }

    if (cachedMtime !== undefined) {
      let currentMtime: number;
      try {
        currentMtime = fs.statSync(strippedFilename).mtimeMs;
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
        return this.recordMissingDependency(
          dependencyFilename,
          changedFiles,
          dependencyChangeMemo,
          memoKey
        );
      }

      if (currentMtime === cachedMtime) {
        const dependencies = this.getDependenciesToCheck(
          dependencyFilename,
          cachedEntrypoint
        );
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
                graphTraversalToken
              )
            ) {
              this.invalidateForFile(dependencyFilename);
              changedFiles.add(dependencyFilename);
              dependencyChangeMemo.set(memoKey, true);
              return true;
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
        dependencyChangeMemo.set(memoKey, false);
        return false;
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
      visitedFiles,
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
    this.invalidateForFile(filename);
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

    let content: string;
    try {
      content = fs.readFileSync(strippedFilename, 'utf8');
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      this.invalidateForFile(filename);
      this.forgetEntrypointDependencySnapshot(filename);
      changedFiles.add(filename);
      return true;
    }

    const nextHash = hashContent(content);
    if (previousHash === nextHash) return false;

    this.setContentHash(filename, 'fs', nextHash);
    this.invalidateForFile(filename);
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
      const currentMtime = fs.statSync(strippedFilename).mtimeMs;
      const cachedMtime = this.fileMtimes.get(filename);
      if (cachedMtime !== undefined && currentMtime === cachedMtime) {
        return false;
      }

      const content = fs.readFileSync(strippedFilename, 'utf8');
      this.fileMtimes.set(filename, currentMtime);
      return this.invalidateIfChanged(filename, content, undefined, 'fs');
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      this.invalidateForFile(filename);
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
    isPublication = false
  ): void {
    const pending = this.pendingContentHashSynchronizations.get(filename);
    if (
      pending?.source === source &&
      (isPublication || pending.hash === hash)
    ) {
      this.pendingContentHashSynchronizations.delete(filename);
    }

    const current = this.contentHashes.get(filename);
    if (current) current[source] = hash;
    else this.contentHashes.set(filename, { [source]: hash });

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
