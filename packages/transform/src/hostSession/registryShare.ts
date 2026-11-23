/**
 * The registries a host session owns: the ids of the functions in its options
 * and the caches of processor lookups. A share rides on the `StrictOptions`
 * object the session pins, under a symbol key. The pipeline hands options
 * down as spread copies, which keep enumerable symbol keys, so every stage
 * that reads the options reads the share of the session that made them.
 * Options without a share, as with a bare `transform()`, use the registries of
 * the process.
 */
import type { StrictOptions } from '@wyw-in-js/shared';

import type { ProcessorLookupCaches } from '../processors/processorLookup';

const REGISTRY_SHARE = Symbol('wyw-in-js.registryShare');

type FunctionLike = (...args: never[]) => unknown;

export type RegistryShare = {
  /**
   * Ids of the functions of one generation of options, given in the order
   * they are first asked for, so the same options give the same ids.
   */
  functionIds: WeakMap<FunctionLike, number>;
  lastFunctionId: number;
  processorLookups: ProcessorLookupCaches;
};

const createProcessorLookups = (): ProcessorLookupCaches => ({
  definedTags: new Map(),
  packageProcessors: new Map(),
  resolvedTagResolverSources: new Map(),
  tagResolverProcessors: new WeakMap(),
});

export const createRegistryShare = (): RegistryShare => ({
  functionIds: new WeakMap(),
  lastFunctionId: 0,
  processorLookups: createProcessorLookups(),
});

type WithShare = { [REGISTRY_SHARE]?: RegistryShare };

/** Binds a share to the options of a session; returns the share. */
export const attachRegistryShare = (
  options: StrictOptions,
  share: RegistryShare = createRegistryShare()
): RegistryShare => {
  // Enumerable, so that spread copies of the options carry it.
  // eslint-disable-next-line no-param-reassign
  (options as WithShare)[REGISTRY_SHARE] = share;
  return share;
};

/** The share bound to these options, or to the options they were copied from. */
export const readRegistryShare = (
  options: object | null | undefined
): RegistryShare | undefined =>
  options ? (options as WithShare)[REGISTRY_SHARE] : undefined;

/** The id of a function within a share; `null` for anything else. */
export const getSharedFunctionId = (
  share: RegistryShare,
  value: unknown
): number | null => {
  if (typeof value !== 'function') return null;
  const fn = value as FunctionLike;
  const cached = share.functionIds.get(fn);
  if (cached !== undefined) return cached;
  // eslint-disable-next-line no-param-reassign
  share.lastFunctionId += 1;
  share.functionIds.set(fn, share.lastFunctionId);
  return share.lastFunctionId;
};

/** Forgets every processor lookup of the share. */
export const resetProcessorLookups = (share: RegistryShare): void => {
  // eslint-disable-next-line no-param-reassign
  share.processorLookups = createProcessorLookups();
};
