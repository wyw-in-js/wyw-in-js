import {
  TransformCacheCollection,
  type TransformCacheEpoch,
} from '../../cache';
import { EventEmitter } from '../../utils/EventEmitter';
import type { BarrelManifestCacheEntry } from '../barrelManifest.types';
import type { Services } from '../types';

type OxcBarrelCacheContext = {
  cacheEpoch: TransformCacheEpoch;
  services: Services;
};

export const createOxcBarrelAnalysisServices = (
  services: Services,
  cacheEpoch: TransformCacheEpoch
): Services => ({
  ...services,
  cache: new TransformCacheCollection({
    barrelManifests: services.cache.barrelManifests,
    epochOwner: cacheEpoch.owner,
    exports: services.cache.exports,
  }),
  cacheEpoch,
  eventEmitter: EventEmitter.dummy,
});

export const publishOxcBarrelExports = (
  context: OxcBarrelCacheContext,
  filename: string,
  exports: string[]
): void =>
  context.services.cache.publish(
    context.cacheEpoch,
    'exports',
    filename,
    exports
  );

export const publishOxcBarrelManifest = (
  context: OxcBarrelCacheContext,
  filename: string,
  manifest: BarrelManifestCacheEntry
): void =>
  context.services.cache.publish(
    context.cacheEpoch,
    'barrelManifests',
    filename,
    manifest
  );

export const publishOxcBarrelDependencies = (
  context: OxcBarrelCacheContext,
  cacheName: 'barrelManifests' | 'exports',
  filename: string,
  dependencies: Iterable<string>
): void =>
  context.services.cache.publishCacheDependencies(
    context.cacheEpoch,
    cacheName,
    filename,
    dependencies
  );
