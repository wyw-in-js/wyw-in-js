import { logger } from '@wyw-in-js/shared';

import {
  recordPipelineCacheClear,
  recordPipelineCacheRequest,
} from './debug/pipelineTelemetry';
import {
  CacheLifecycle,
  type TransformCacheEpoch,
} from './cache/cacheLifecycle';
import {
  type IBaseCachedEntrypoint,
  isEntrypointGraphIncomplete,
} from './cache/cacheTypes';
import type { BarrelManifestCacheEntry } from './transform/barrelManifest.types';
import type { Entrypoint } from './transform/Entrypoint';
import type { IEvaluatedEntrypoint } from './transform/EvaluatedEntrypoint';
import { getFileIdx } from './utils/getFileIdx';

interface ICaches<TEntrypoint extends IBaseCachedEntrypoint> {
  barrelManifests: Map<string, BarrelManifestCacheEntry>;
  entrypoints: Map<string, TEntrypoint>;
  /** @internal Cache views must be created by transform internals. */
  epochOwner: TransformCacheCollection<IBaseCachedEntrypoint>;
  exports: Map<string, string[]>;
}

type MapValue<T> = T extends Map<string, infer V> ? V : never;

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
> extends CacheLifecycle<TEntrypoint> {
  public readonly barrelManifests: Map<string, BarrelManifestCacheEntry>;

  public readonly entrypoints: Map<string, TEntrypoint>;

  public readonly exports: Map<string, string[]>;

  constructor(caches: Partial<ICaches<TEntrypoint>> = {}) {
    super(caches.epochOwner);
    this.barrelManifests = caches.barrelManifests || new Map();
    this.entrypoints = caches.entrypoints || new Map();
    this.exports = caches.exports || new Map();
  }

  protected clearAllCachesForRecovery(): void {
    this.clear('all');
  }

  protected clearCachesForKeySaltChange(reason: string): void {
    recordPipelineCacheClear(
      'barrelManifests',
      reason,
      this.barrelManifests.size
    );
    this.barrelManifests.clear();
    recordPipelineCacheClear('entrypoints', reason, this.entrypoints.size);
    this.entrypoints.clear();
    recordPipelineCacheClear('exports', reason, this.exports.size);
    this.exports.clear();
  }

  protected getEntrypoint(filename: string): TEntrypoint | undefined {
    return this.get('entrypoints', filename);
  }

  protected hasPublishedEntrypoint(
    filename: string,
    publishedEntrypoint: TEntrypoint
  ): boolean {
    return this.get('entrypoints', filename) === publishedEntrypoint;
  }

  protected invalidateCache(cacheName: CacheNames, key: string): void {
    this.invalidate(cacheName, key);
  }

  protected migrateCacheKeys(remap: (key: string) => string): void {
    const migrate = <TValue>(cache: Map<string, TValue>) => {
      const entries = Array.from(cache.entries());
      cache.clear();
      entries.forEach(([key, value]) => {
        cache.set(remap(key), value);
      });
    };

    migrate(this.barrelManifests);
    migrate(this.entrypoints);
    migrate(this.exports);
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
      if (!cache.has(cacheKey)) return 'added';
      return cache.get(cacheKey) === value ? 'unchanged' : 'updated';
    });

    if (value === undefined) {
      cache.delete(cacheKey);
      this.forgetCacheValue(cacheName, key);
      return;
    }

    if (cacheName === 'entrypoints') {
      this.snapshotReplacedEntrypoint(
        key,
        cache.get(cacheKey) as TEntrypoint | undefined,
        value as unknown as TEntrypoint
      );
    }

    this.clearFreshness(cacheName, key);
    cache.set(cacheKey, value);

    if (
      cacheName === 'entrypoints' &&
      !isEntrypointGraphIncomplete(value as unknown as IBaseCachedEntrypoint)
    ) {
      this.completeUnknownGraphRecovery(key);
    }
    this.recordCachePublication(cacheName, key, value);
  }

  /** @internal Cache writes must be fenced by a transform attempt's epoch. */
  public publish<
    TCache extends CacheNames,
    TValue extends MapValue<ICaches<TEntrypoint>[TCache]>,
  >(
    epoch: TransformCacheEpoch,
    cacheName: TCache,
    key: string,
    value: TValue
  ): void {
    this.assertEpoch(epoch);
    this.add(cacheName, key, value);
  }

  /** @internal Atomically replace a transform attempt's observed value. */
  public replacePublished<
    TCache extends CacheNames,
    TValue extends MapValue<ICaches<TEntrypoint>[TCache]>,
  >(
    epoch: TransformCacheEpoch,
    cacheName: TCache,
    key: string,
    expected: TValue | undefined,
    value: TValue | undefined
  ): boolean {
    this.assertEpoch(epoch);
    const cache = this[cacheName] as Map<string, TValue>;
    if (cache.get(this.getKey(key)) !== expected) return false;
    this.add(cacheName, key, value as TValue);
    return true;
  }

  /** @internal Atomically evict a transform attempt's observed value. */
  public invalidatePublished<
    TCache extends CacheNames,
    TValue extends MapValue<ICaches<TEntrypoint>[TCache]>,
  >(
    epoch: TransformCacheEpoch,
    cacheName: TCache,
    key: string,
    expected: TValue | undefined
  ): boolean {
    this.assertEpoch(epoch);
    const cache = this[cacheName] as Map<string, TValue>;
    if (cache.get(this.getKey(key)) !== expected) return false;
    this.invalidate(cacheName, key);
    return true;
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
      this.recordEntrypointsCleared();
      this.onEntrypointsCleared();
    }
    this.clearFreshness(cacheName);
  }

  public delete(cacheName: CacheNames, key: string): void {
    this.invalidate(cacheName, key);
  }

  /** @internal Cache writes must be fenced by a transform attempt's epoch. */
  public removePublished(
    epoch: TransformCacheEpoch,
    cacheName: CacheNames,
    key: string
  ): void {
    this.assertEpoch(epoch);
    this.delete(cacheName, key);
  }

  public get<
    TCache extends CacheNames,
    TValue extends MapValue<ICaches<TEntrypoint>[TCache]>,
  >(cacheName: TCache, key: string): TValue | undefined {
    const cache = this[cacheName] as Map<string, TValue>;
    const result = cache.get(this.getKey(key));
    loggers[cacheName]('get', key, result === undefined ? 'miss' : 'hit');
    recordPipelineCacheRequest(cacheName, 'get', result !== undefined);
    return result;
  }

  public has(cacheName: CacheNames, key: string): boolean {
    const cache = this[cacheName] as Map<string, unknown>;
    const result = cache.has(this.getKey(key));
    loggers[cacheName]('has', key, result);
    recordPipelineCacheRequest(cacheName, 'has', result);
    return result;
  }

  public invalidate(cacheName: CacheNames, key: string): void {
    const cache = this[cacheName] as Map<string, unknown>;
    const cacheKey = this.getKey(key);
    if (!cache.has(cacheKey)) return;

    loggers[cacheName]('invalidate', key);
    if (cacheName === 'entrypoints') {
      this.snapshotEntrypointDependencies(
        key,
        cache.get(cacheKey) as TEntrypoint
      );
    }
    cache.delete(cacheKey);
    recordPipelineCacheClear(cacheName, 'invalidate', 1);
    this.clearFreshness(cacheName, key);
  }
}

export { CacheKeySaltBusyError } from './cache/cacheLifecycle';
export type { TransformCacheEpoch } from './cache/cacheLifecycle';
