import { TransformCacheCollection } from '../../cache';
import { EventEmitter } from '../../utils/EventEmitter';
import { loadAndParse } from '../Entrypoint.helpers';
import { rootLog } from '../rootLog';
import type { Services } from '../types';

type RequiredServices = 'options';
export type PartialServices = Partial<Omit<Services, RequiredServices>> &
  Pick<Services, RequiredServices>;

export const withDefaultServices = (services: PartialServices): Services => ({
  cache: services.cache ?? new TransformCacheCollection(),
  cacheEpoch: services.cacheEpoch,
  cacheRecoveryOwner: services.cacheRecoveryOwner,
  emitWarning: services.emitWarning,
  eventEmitter: services.eventEmitter ?? EventEmitter.dummy,
  loadDependencyCode: services.loadDependencyCode,
  loadDependencyCodeKey: services.loadDependencyCodeKey,
  loadAndParseFn: services.loadAndParseFn ?? loadAndParse,
  log: services.log ?? rootLog,
  options: services.options,
  asyncResolveKey: services.asyncResolveKey,
  evalBrokerScope: services.evalBrokerScope,
});
