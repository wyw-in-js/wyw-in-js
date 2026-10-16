import { formatKeys } from '../transform/helpers/onceWarnings';
import { TransformWorkerPool } from './pool';
import type { TransformWorkerScopeConfig } from './protocol';
import { findNonTransferableOptions } from './protocol';
import type { TransformWorkerScope } from './scope';

/** Adapter option: `true` uses the default worker count. */
export type ParallelTransformsOption = boolean | number | undefined;

export type ParallelTransformsOptions = {
  /** Reports, once per reason, why transforms stay on the calling thread. */
  onFallback?: (message: string) => void;
  parallel: ParallelTransformsOption;
  /** An adapter-specific reason to keep every transform on this thread. */
  unsupported?: string | false | null;
};

export interface ParallelTransforms {
  dispose(): Promise<void>;
  disposeEvalBrokers(): void;
  /** Drops one scope and its caches in every worker. */
  disposeScope(key: string): void;
  invalidateForFile(filename: string): void;
  /**
   * Returns the worker scope for `key`, starting the pool and creating the
   * scope on first use, or null if the scope options cannot be sent to a
   * worker thread.
   */
  scope(
    key: string,
    config: () => TransformWorkerScopeConfig
  ): TransformWorkerScope | null;
  /** Starts the workers ahead of the first transform. */
  start(): void;
}

const fallbackMessage = (reason: string) =>
  `Transforms run on the main thread because ${reason}.`;

const describeOptions = (keys: string[]) =>
  `${formatKeys(keys)} ${keys.length > 1 ? 'options' : 'option'}`;

// Plugin options can move to a config file that every worker loads; the
// adapter's own options, such as a `preprocessor` function, cannot.
const findNonTransferableScopeReason = ({
  pluginOptions,
  ...config
}: TransformWorkerScopeConfig): string | null => {
  const fromPlugin = findNonTransferableOptions(pluginOptions);
  const fromAdapter = findNonTransferableOptions(config);
  if (fromPlugin.length === 0) {
    return fromAdapter.length > 0
      ? `the ${describeOptions(
          fromAdapter
        )} cannot be passed to a worker thread`
      : null;
  }

  const pluginReason = `the ${describeOptions(
    fromPlugin
  )} cannot be passed to a worker thread; define ${
    fromPlugin.length > 1 ? 'them' : 'it'
  } in a wyw-in-js config file instead`;

  return fromAdapter.length > 0
    ? `${pluginReason}. The ${describeOptions(
        fromAdapter
      )} cannot be passed to a worker thread either`
    : pluginReason;
};

/**
 * Shared adapter glue for running transforms in worker threads: owns the pool
 * and its scopes, and decides which scopes have to stay on the calling thread.
 * Returns null when parallel transforms are disabled.
 *
 * @experimental Intended for wyw-in-js integrations; may change in a minor
 * release.
 */
export const createParallelTransforms = ({
  onFallback,
  parallel,
  unsupported,
}: ParallelTransformsOptions): ParallelTransforms | null => {
  if (!parallel) {
    return null;
  }

  if (unsupported) {
    onFallback?.(fallbackMessage(unsupported));
    return null;
  }

  const workers = typeof parallel === 'number' ? parallel : undefined;
  const scopes = new Map<string, TransformWorkerScope | null>();
  const reported = new Set<string>();
  let pool: TransformWorkerPool | null = null;

  return {
    async dispose() {
      const current = pool;
      pool = null;
      scopes.clear();
      await current?.dispose();
    },
    disposeEvalBrokers() {
      scopes.forEach((scope) => scope?.disposeEvalBroker());
    },
    disposeScope(key) {
      const scope = scopes.get(key);
      scopes.delete(key);
      scope?.dispose();
    },
    invalidateForFile(filename) {
      scopes.forEach((scope) => scope?.invalidateForFile(filename));
    },
    scope(key, getConfig) {
      const existing = scopes.get(key);
      if (existing !== undefined) {
        return existing;
      }

      const config = getConfig();
      const reason = findNonTransferableScopeReason(config);
      if (reason !== null) {
        if (!reported.has(reason)) {
          reported.add(reason);
          onFallback?.(fallbackMessage(reason));
        }

        scopes.set(key, null);
        return null;
      }

      pool ??= new TransformWorkerPool({ workers });
      const scope = pool.createScope(config);
      scopes.set(key, scope);
      return scope;
    },
    start() {
      pool ??= new TransformWorkerPool({ workers });
    },
  };
};
