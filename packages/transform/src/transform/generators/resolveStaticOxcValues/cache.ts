/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { isAbsolute } from 'path';

import { defineFileScopedStore } from '../../../cache/fileScopedStore';
import type { FileScopedStore } from '../../../cache/fileScopedStore';
import { oxcShaker } from '../../../shaker';
import { runOxcPreevalStage } from '../../../utils/oxcPreevalStage';
import { stripQueryAndHash } from '../../../utils/parseRequest';
import type { ITransformAction } from '../../types';
import { isEnvDisabled, parseProgram } from './environment';
import type {
  StaticExportCacheEntry,
  StaticExportResult,
  StaticFileAnalysis,
  StaticFileHashCacheEntry,
  StaticMetadataPreevalCacheEntry,
} from './types';
import { STATIC_EXPORT_MAX_NULL_ATTEMPTS } from './types';

// The stores belong to the transform cache collection, which forgets a file's
// entries in invalidateForFile. Within a file, an entry is keyed without the
// content hash, so a new version replaces the previous one.
const staticFileAnalysisStore =
  defineFileScopedStore<StaticFileAnalysis>('staticFileAnalysis');

const staticFileHashStore =
  defineFileScopedStore<StaticFileHashCacheEntry>('staticFileHash');

const staticExportResultStore =
  defineFileScopedStore<StaticExportCacheEntry>('staticExportResult');

const staticMetadataPreevalStore =
  defineFileScopedStore<StaticMetadataPreevalCacheEntry>(
    'staticMetadataPreeval'
  );

export const hashStaticContent = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex');

export const getWeakCacheMap = <TValue>(
  caches: WeakMap<object, Map<string, TValue>>,
  key: object
): Map<string, TValue> => {
  let cache = caches.get(key);
  if (!cache) {
    cache = new Map();
    caches.set(key, cache);
  }

  return cache;
};

export const isStaticResolveCacheEnabled = (): boolean => {
  const envValue = process.env.WYW_STATIC_RESOLVE_CACHE?.trim().toLowerCase();
  if (envValue) {
    return !isEnvDisabled(envValue);
  }

  return true;
};

export const staticCachePrefix = (action: ITransformAction): string =>
  `${action.services.cache.getKeySalt() ?? ''}\0${
    action.services.options.root ?? ''
  }`;

export const staticFileAnalysisCache = (
  action: ITransformAction
): FileScopedStore<StaticFileAnalysis> =>
  action.services.cache.fileScopedStore(staticFileAnalysisStore);

export const staticFileHashCache = (
  action: ITransformAction
): FileScopedStore<StaticFileHashCacheEntry> =>
  action.services.cache.fileScopedStore(staticFileHashStore);

export const staticExportResultCache = (
  action: ITransformAction
): FileScopedStore<StaticExportCacheEntry> =>
  action.services.cache.fileScopedStore(staticExportResultStore);

export const staticMetadataPreevalCache = (
  action: ITransformAction
): FileScopedStore<StaticMetadataPreevalCacheEntry> =>
  action.services.cache.fileScopedStore(staticMetadataPreevalStore);

export const staticFileCacheKey = (
  action: ITransformAction,
  filename: string
): string => `${staticCachePrefix(action)}\0${stripQueryAndHash(filename)}`;

export const staticExportCacheKey = (
  action: ITransformAction,
  filename: string,
  exportedName: string
): string => `${staticFileCacheKey(action, filename)}\0${exportedName}`;

// An entry computed for another version of the file, or for the same file
// under another query, is a miss; writing the current one replaces it.
const isEntryFor = (
  entry: { codeHash: string; filename: string },
  filename: string,
  codeHash: string
): boolean => entry.codeHash === codeHash && entry.filename === filename;

export const getStaticFileContentHash = (
  action: ITransformAction,
  dependency: string
): string | null => {
  const filename = stripQueryAndHash(dependency);
  if (!isAbsolute(filename)) {
    return null;
  }

  let stat;
  try {
    stat = statSync(filename);
  } catch {
    return null;
  }

  if (!stat.isFile()) {
    return null;
  }

  const cache = staticFileHashCache(action);
  const cached = cache.get(filename, filename);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.hash;
  }

  let hash: string;
  try {
    hash = hashStaticContent(readFileSync(filename));
  } catch {
    return null;
  }

  cache.set(filename, filename, {
    hash,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  });
  return hash;
};

export const collectStaticDependencyHashes = (
  action: ITransformAction,
  dependencies: string[]
): Map<string, string> | null => {
  const hashes = new Map<string, string>();
  for (const dependency of dependencies) {
    const hash = getStaticFileContentHash(action, dependency);
    if (!hash) {
      return null;
    }

    hashes.set(stripQueryAndHash(dependency), hash);
  }

  return hashes;
};

export const areStaticDependencyHashesCurrent = (
  action: ITransformAction,
  dependencyHashes: Map<string, string>
): boolean => {
  for (const [dependency, expectedHash] of dependencyHashes) {
    if (getStaticFileContentHash(action, dependency) !== expectedHash) {
      return false;
    }
  }

  return true;
};

export const getStaticExportCachedResult = (
  action: ITransformAction,
  filename: string,
  exportedName: string,
  codeHash: string
): StaticExportResult | null | undefined => {
  if (!isStaticResolveCacheEnabled()) {
    return undefined;
  }

  const cache = staticExportResultCache(action);
  const cacheKey = staticExportCacheKey(action, filename, exportedName);
  const cached = cache.get(filename, cacheKey);
  if (!cached || !isEntryFor(cached, filename, codeHash)) {
    return undefined;
  }

  if (cached.result === null) {
    // Bounded retry: until the attempt counter has been bumped enough times
    // that we accept the null as stable, treat it as a cache miss so the
    // caller re-walks. The counter is updated in setStaticExportCachedResult.
    if (cached.attempts < STATIC_EXPORT_MAX_NULL_ATTEMPTS) {
      return undefined;
    }
    return null;
  }

  if (areStaticDependencyHashesCurrent(action, cached.dependencyHashes)) {
    return cached.result;
  }

  cache.delete(filename, cacheKey);
  return undefined;
};

export const setStaticExportCachedResult = (
  action: ITransformAction,
  filename: string,
  exportedName: string,
  codeHash: string,
  result: StaticExportResult | null
): void => {
  if (!isStaticResolveCacheEnabled()) {
    return;
  }

  const cache = staticExportResultCache(action);
  const cacheKey = staticExportCacheKey(action, filename, exportedName);
  if (!result) {
    const existing = cache.get(filename, cacheKey);
    const attempts =
      existing &&
      existing.result === null &&
      isEntryFor(existing, filename, codeHash)
        ? existing.attempts + 1
        : 1;
    cache.set(filename, cacheKey, {
      attempts,
      codeHash,
      filename,
      result: null,
    });
    return;
  }

  const dependencyHashes = collectStaticDependencyHashes(
    action,
    result.dependencies
  );
  if (!dependencyHashes) {
    return;
  }

  cache.set(filename, cacheKey, {
    codeHash,
    dependencyHashes,
    filename,
    result,
  });
};

export const getStaticFileAnalysis = (
  action: ITransformAction,
  filename: string
): StaticFileAnalysis | null => {
  const loadedAndParsed = action.services.loadAndParseFn(
    action.services,
    filename,
    undefined,
    action.services.log
  );
  if (
    loadedAndParsed.evaluator === 'ignored' ||
    loadedAndParsed.evaluator !== oxcShaker
  ) {
    return null;
  }

  const { code } = loadedAndParsed;
  const codeHash = hashStaticContent(code);
  const cache = staticFileAnalysisCache(action);
  const cacheKey = staticFileCacheKey(action, filename);
  const cached = cache.get(filename, cacheKey);
  if (cached && isEntryFor(cached, filename, codeHash)) {
    return cached;
  }

  const analysis = {
    code,
    codeHash,
    filename,
    program: parseProgram(code, filename),
  };
  cache.set(filename, cacheKey, analysis);
  return analysis;
};

export const getStaticMetadataPreevalResult = (
  action: ITransformAction,
  filename: string,
  code: string,
  codeHash: string
): ReturnType<typeof runOxcPreevalStage> | null => {
  const cache = staticMetadataPreevalCache(action);
  const cacheKey = staticFileCacheKey(action, filename);
  const cached = cache.get(filename, cacheKey);
  if (cached && isEntryFor(cached, filename, codeHash)) {
    return cached.result;
  }

  const root = action.services.options.root ?? process.cwd();
  try {
    const result = action.services.eventEmitter.perf(
      'transform:preeval:staticMetadata',
      () =>
        runOxcPreevalStage(
          code,
          {
            filename,
            root,
          },
          {
            ...action.services.options.pluginOptions,
            eventEmitter: action.services.eventEmitter,
          }
        )
    );
    cache.set(filename, cacheKey, { codeHash, filename, result });
    return result;
  } catch {
    cache.set(filename, cacheKey, { codeHash, filename, result: null });
    return null;
  }
};
