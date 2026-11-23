/**
 * The in-process engine: each session is an engine scope on the calling
 * thread. Its state lives in the engine instance: the order of opened
 * sessions, which gives their keys, and the eval runners shared by name.
 */
import { disposeEvalBroker } from '../eval/broker';

import { createEngineScope } from './engineScope';
import type { EngineScopeState } from './engineScope';
import type {
  EngineHost,
  EngineScope,
  EngineSession,
  HostEngine,
} from './types';

type SharedRunner = {
  /** The process scope of the eval runner. */
  process: object;
  sessions: number;
};

export type JsEngineOptions = {
  /**
   * Gives the key of the next session. The pool engine passes its own, so
   * that the keys of an engine follow one order wherever sessions run.
   */
  nextKey?: () => string;
};

export const createSessionKeys = (): (() => string) => {
  let opened = 0;
  return () => {
    opened += 1;
    return `wyw-host:${opened}`;
  };
};

export const createJsEngine = ({
  nextKey = createSessionKeys(),
}: JsEngineOptions = {}): HostEngine => {
  const runners = new Map<string, SharedRunner>();
  const scopes = new Set<EngineScopeState>();

  const takeRunner = (name: string | null): SharedRunner | null => {
    if (name === null) return null;
    const runner = runners.get(name) ?? { process: {}, sessions: 0 };
    runner.sessions += 1;
    runners.set(name, runner);
    return runner;
  };

  const dropRunner = (name: string | null, runner: SharedRunner | null) => {
    if (name === null || runner === null) return;
    // eslint-disable-next-line no-param-reassign
    runner.sessions -= 1;
    if (runner.sessions === 0 && runners.get(name) === runner) {
      runners.delete(name);
      disposeEvalBroker(runner.process);
    }
  };

  return {
    open(scope: EngineScope, host: EngineHost): EngineSession {
      const key = nextKey();
      const runner = takeRunner(scope.runner);
      const engineScope = createEngineScope({
        host,
        key,
        runner: runner?.process ?? null,
        scope,
      });
      scopes.add(engineScope);
      let closed = false;

      return {
        async close() {
          if (closed) return;
          closed = true;
          scopes.delete(engineScope);
          engineScope.close();
          dropRunner(scope.runner, runner);
        },
        invalidate(files, extent) {
          if (!closed) engineScope.invalidate(files, extent);
        },
        key,
        transform(callId, file) {
          if (closed) {
            return Promise.reject(
              new Error(`[wyw-in-js] The engine session ${key} is closed`)
            );
          }

          return engineScope.transform(callId, file);
        },
      };
    },

    async release() {
      scopes.forEach((engineScope) => engineScope.disposeOwnRunner());
      runners.forEach((runner) => disposeEvalBroker(runner.process));
    },
  };
};
