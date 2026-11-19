/**
 * The engines a host session can run on: in process, or in worker threads,
 * where each session is an engine scope inside every worker and its host half
 * stays on the calling thread. A session that cannot run in a worker stays on
 * the calling thread with an in-process engine of the same keys.
 */
import { TransformWorkerPool } from '../parallel/pool';
import { findNonTransferableOptions } from '../parallel/protocol';
import { formatKeys } from '../transform/helpers/onceWarnings';
import { EventEmitter } from '../utils/EventEmitter';

import { createJsEngine, createSessionKeys } from './jsEngine';
import type {
  CreateHostEngine,
  EngineHost,
  EngineScope,
  EngineSession,
  HostEngine,
} from './types';

// An object of functions, such as a `window` stub in `eval.globals`, has a
// path per function: name the first few and count the rest.
const NAMED_OPTIONS = 5;

const describeOptions = (keys: readonly string[]): string =>
  keys.length > NAMED_OPTIONS
    ? `${formatKeys(keys.slice(0, NAMED_OPTIONS))} and ${
        keys.length - NAMED_OPTIONS
      } more options`
    : `${formatKeys(keys)} ${keys.length > 1 ? 'options' : 'option'}`;

/** Why a session has to stay on the calling thread, or `null`. */
const findFallbackReason = (scope: EngineScope): string | null => {
  const options = findNonTransferableOptions(scope.options);
  if (options.length > 0) {
    return `the ${describeOptions(
      options
    )} cannot be passed to a worker thread; define ${
      options.length > 1 ? 'them' : 'it'
    } in a wyw-in-js config file instead`;
  }

  const facts = findNonTransferableOptions({
    alias: scope.alias,
    conditions: scope.conditions,
    extensions: scope.extensions,
    globals: scope.globals,
  });
  if (facts.length > 0) {
    return `the bundler ${describeOptions(
      facts
    )} cannot be passed to a worker thread`;
  }

  if (scope.load) {
    return 'the bundler loads the code of dependencies itself, which a worker thread cannot ask it for';
  }

  if (
    scope.eventEmitter !== null &&
    scope.eventEmitter !== EventEmitter.dummy
  ) {
    return 'an event emitter observes the transforms';
  }

  return null;
};

const fallbackMessage = (reason: string) =>
  `Transforms run on the main thread because ${reason}.`;

type PoolState = {
  /** Ids of the engine scopes open in this pool. */
  open: Set<number>;
  pool: TransformWorkerPool;
};

/**
 * Creates an engine for host sessions. With `workers`, sessions run in
 * worker threads that start with the first session that can use them and
 * stop when the last one closes; without, sessions run in process.
 *
 * @experimental Intended for wyw-in-js integrations; may change in a minor
 * release.
 */
export const createHostEngine: CreateHostEngine = ({
  onFallback,
  workers,
} = {}): HostEngine => {
  const nextKey = createSessionKeys();
  if (!workers) {
    return createJsEngine({ nextKey });
  }

  const count = typeof workers === 'number' ? workers : undefined;
  const reported = new Set<string>();
  let fallback: HostEngine | null = null;
  let current: PoolState | null = null;

  const openInProcess = (
    reason: string,
    scope: EngineScope,
    host: EngineHost
  ): EngineSession => {
    const message = fallbackMessage(reason);
    if (!reported.has(message)) {
      reported.add(message);
      onFallback?.(message);
    }

    fallback ??= createJsEngine({ nextKey });
    return fallback.open(scope, host);
  };

  return {
    open(scope, host) {
      const reason = findFallbackReason(scope);
      if (reason !== null) {
        return openInProcess(reason, scope, host);
      }

      const key = nextKey();
      current ??= {
        open: new Set(),
        pool: new TransformWorkerPool({ workers: count }),
      };
      const state = current;
      const { eventEmitter, ...data } = scope;
      const scopeId = state.pool.createEngineScope(key, data, host);
      state.open.add(scopeId);
      let closed = false;

      return {
        async close() {
          if (closed) return;
          closed = true;
          state.pool.notifyScope({ scopeId, type: 'disposeScope' });
          state.open.delete(scopeId);
          if (state.open.size === 0) {
            if (current === state) current = null;
            await state.pool.dispose();
          }
        },
        invalidate(files, extent) {
          if (closed) return;
          state.pool.notifyScope({
            extent,
            files: [...files],
            scopeId,
            type: 'engineInvalidate',
          });
        },
        key,
        transform(callId, file) {
          if (closed) {
            return Promise.reject(
              new Error(`[wyw-in-js] The engine session ${key} is closed`)
            );
          }

          return state.pool.runEngineJob(scopeId, callId, file);
        },
      };
    },

    async release() {
      current?.open.forEach((scopeId) =>
        current!.pool.notifyScope({ scopeId, type: 'disposeEvalBroker' })
      );
      await fallback?.release();
    },
  };
};
