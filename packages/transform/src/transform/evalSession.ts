import { createHash } from 'crypto';
import path from 'path';

import type { StrictOptions } from '@wyw-in-js/shared';

import { getEvalBroker } from '../eval/broker';
import { encodeGlobals } from '../eval/serialize';

import { asyncResolveImports } from './generators/resolveImports';
import type { Handler, IResolveImportsAction, Services } from './types';

type AsyncResolve = (
  what: string,
  importer: string,
  stack: string[]
) => Promise<string | null>;

type ResolverFn = (...args: unknown[]) => unknown;

const memoizedAsyncResolve = new WeakMap<
  AsyncResolve,
  Handler<'async' | 'sync', IResolveImportsAction>
>();

const resolverIds = new WeakMap<ResolverFn, number>();
let resolverId = 0;

const getResolverId = (fn: unknown) => {
  if (typeof fn !== 'function') return null;
  const resolver = fn as ResolverFn;
  const cached = resolverIds.get(resolver);
  if (cached) return cached;
  resolverId += 1;
  resolverIds.set(resolver, resolverId);
  return resolverId;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const canonicalizeForHash = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForHash(item));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeForHash(value[key])])
    );
  }

  return value;
};

export const getEvalCacheKey = (
  pluginOptions: StrictOptions,
  asyncResolveKey: string | undefined,
  asyncResolve: AsyncResolve,
  loadDependencyCode?: Services['loadDependencyCode'],
  root?: string,
  loadDependencyCodeKey?: string
) => {
  const evalOptions = pluginOptions.eval ?? {};
  const payload = JSON.stringify({
    errors: evalOptions.errors,
    resolver: evalOptions.resolver,
    require: evalOptions.require,
    runtime: evalOptions.runtime,
    strategy: evalOptions.strategy,
    globals: canonicalizeForHash(encodeGlobals(evalOptions.globals ?? {})),
    customResolver: getResolverId(evalOptions.customResolver),
    customLoader: getResolverId(evalOptions.customLoader),
    // Bundlers can recreate transport callbacks per file. Stable scope keys
    // attest unchanged semantics without conflating resolver and loader axes.
    bundlerResolver: asyncResolveKey ?? getResolverId(asyncResolve),
    bundlerLoader: loadDependencyCodeKey ?? getResolverId(loadDependencyCode),
    overrideContext: getResolverId(pluginOptions.overrideContext),
    importOverrides: pluginOptions.importOverrides ?? null,
    extensions: pluginOptions.extensions,
    features: pluginOptions.features,
    root: root ? path.resolve(root) : null,
  });

  return createHash('sha256').update(payload).digest('hex');
};

export const configureEvalSession = (
  services: Services,
  pluginOptions: StrictOptions,
  asyncResolve: AsyncResolve,
  precomputedEvalCacheKey?: string
): Handler<'async' | 'sync', IResolveImportsAction> => {
  const evalCacheKey =
    precomputedEvalCacheKey ??
    getEvalCacheKey(
      pluginOptions,
      services.asyncResolveKey,
      asyncResolve,
      services.loadDependencyCode,
      services.options.root,
      services.loadDependencyCodeKey
    );

  if (precomputedEvalCacheKey === undefined) {
    services.cache.setKeySalt(evalCacheKey);
  } else if (services.cache.getKeySalt() !== evalCacheKey) {
    throw new Error(
      '[wyw-in-js] Evaluation cache key changed outside its active lease'
    );
  }
  // `Services` is the mutable per-transform session object; this wires the
  // eval-specific session state behind the evalSession module boundary.
  // eslint-disable-next-line no-param-reassign
  services.asyncResolve = asyncResolve;
  // eslint-disable-next-line no-param-reassign
  services.evalCacheKey = evalCacheKey;
  // eslint-disable-next-line no-param-reassign
  services.evalBroker = getEvalBroker(services, asyncResolve, evalCacheKey);

  if (!memoizedAsyncResolve.has(asyncResolve)) {
    const resolveImports = function resolveImports(
      this: IResolveImportsAction
    ) {
      return asyncResolveImports.call(this, asyncResolve);
    };

    memoizedAsyncResolve.set(asyncResolve, resolveImports);
  }

  return memoizedAsyncResolve.get(asyncResolve)!;
};
