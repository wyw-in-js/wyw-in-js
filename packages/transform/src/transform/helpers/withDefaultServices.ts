import { TransformCacheCollection } from '../../cache';
import { EventEmitter } from '../../utils/EventEmitter';
import { loadAndParse } from '../Entrypoint.helpers';
import { rootLog } from '../rootLog';
import type { Services } from '../types';

type RequiredServices = 'options';
export type PartialServices = Partial<Omit<Services, RequiredServices>> &
  Pick<Services, RequiredServices>;

export const withDefaultServices = ({
  cache = new TransformCacheCollection(),
  cacheEpoch,
  emitWarning,
  eventEmitter = EventEmitter.dummy,
  loadDependencyCode,
  loadDependencyCodeKey,
  loadAndParseFn = loadAndParse,
  log = rootLog,
  options,
  asyncResolveKey,
  evalBrokerScope,
}: PartialServices): Services => ({
  cache,
  cacheEpoch,
  emitWarning,
  eventEmitter,
  loadDependencyCode,
  loadDependencyCodeKey,
  loadAndParseFn,
  log,
  options,
  asyncResolveKey,
  evalBrokerScope,
});
