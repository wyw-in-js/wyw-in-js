import { TransformWorkerPool } from './pool';
import type { TransformWorkerScopeConfig } from './protocol';
import { findNonTransferableOption } from './protocol';
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

const findNonTransferableScopeOption = ({
  pluginOptions,
  ...config
}: TransformWorkerScopeConfig): string | null =>
  findNonTransferableOption(pluginOptions) ?? findNonTransferableOption(config);

/**
 * Shared adapter glue for running transforms in worker threads: owns the pool
 * and its scopes, and decides which scopes have to stay on the calling thread.
 * Returns null when parallel transforms are disabled.
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
      const nonTransferable = findNonTransferableScopeOption(config);
      if (nonTransferable !== null) {
        const reason = `the \`${nonTransferable}\` option cannot be passed to a worker thread; define it in a wyw-in-js config file instead`;
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
