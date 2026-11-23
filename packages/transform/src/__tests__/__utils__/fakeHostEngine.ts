import type {
  EngineHost,
  EngineResult,
  EngineScope,
  EngineSession,
  HostEngine,
  HostFile,
} from '../../hostSession/types';
import type { Result } from '../../types';

/**
 * What the fake engine does for one file: the imports it asks the host about,
 * the warnings it reports and the `Result` it answers with.
 */
export type FakeEntry = {
  /**
   * Specifiers the engine resolves through the host before it answers, in
   * order. A resolved one is loaded through the host too when the session has
   * a load capability.
   */
  imports?: readonly string[];
  /**
   * The call gets a runner of its own that exits when the call settles, as
   * with `features.globalCache=false`.
   */
  ownRunner?: boolean;
  /** The answer; `runner` is the id of the fake eval runner of the call. */
  result: (runner: string) => Result;
  /** Messages the engine reports through `host.warn` during the call. */
  warnings?: readonly string[];
};

export type FakeHostEngine = HostEngine & {
  isRunnerAlive(id: string): boolean;
};

type RunnerSlot = {
  current: string | null;
  sessions: number;
};

/**
 * A `HostEngine` that runs no pipeline: it answers every file from a table.
 * It talks to the host only through the engine seam, computes its evaluation
 * cache key from what the session sent when it opened, and keeps fake eval
 * runners that sessions share by runner name and that `close` and `release`
 * stop.
 */
export const createFakeHostEngine = (
  table: Readonly<Record<string, FakeEntry>>,
  { name = 'fake' }: { name?: string } = {}
): FakeHostEngine => {
  const alive = new Set<string>();
  const slots = new Map<string, RunnerSlot>();
  let opened = 0;
  let started = 0;

  const startRunner = () => {
    started += 1;
    const id = `${name}-runner-${started}`;
    alive.add(id);
    return id;
  };

  const stopRunner = (slot: RunnerSlot) => {
    if (slot.current !== null) {
      alive.delete(slot.current);
      // eslint-disable-next-line no-param-reassign
      slot.current = null;
    }
  };

  return {
    isRunnerAlive: (id) => alive.has(id),

    open(scope: EngineScope, host: EngineHost): EngineSession {
      opened += 1;
      const key = `${name}:${opened}`;
      const salt = `${name}-salt:${JSON.stringify({
        alias: scope.alias,
        conditions: scope.conditions,
        extensions: scope.extensions,
        globals: scope.globals,
        options: scope.options,
        root: scope.root,
      })}`;
      const slotName = scope.runner ?? `own:${key}`;
      const slot = slots.get(slotName) ?? { current: null, sessions: 0 };
      slot.sessions += 1;
      slots.set(slotName, slot);
      let closed = false;

      const transform = async (
        callId: number,
        file: HostFile
      ): Promise<EngineResult> => {
        const entry = table[file.filename];
        if (!entry) {
          throw new Error(`The fake engine has no entry for ${file.filename}`);
        }

        for (const specifier of entry.imports ?? []) {
          // eslint-disable-next-line no-await-in-loop
          const id = await host.resolve(callId, {
            importer: file.filename,
            specifier,
            stack: [file.filename],
          });
          if (id !== null && scope.load) {
            // eslint-disable-next-line no-await-in-loop
            await host.load(callId, {
              id,
              importer: file.filename,
              specifier,
            });
          }
        }

        entry.warnings?.forEach((message) => host.warn(callId, message));

        if (entry.ownRunner) {
          const runner = startRunner();
          try {
            return { optionSources: [], result: entry.result(runner), salt };
          } finally {
            alive.delete(runner);
          }
        }

        if (slot.current === null) {
          slot.current = startRunner();
        }

        return {
          optionSources: [],
          result: entry.result(slot.current),
          salt,
        };
      };

      return {
        key,
        async close() {
          if (closed) {
            return;
          }

          closed = true;
          slot.sessions -= 1;
          if (slot.sessions === 0) {
            stopRunner(slot);
            slots.delete(slotName);
          }
        },
        invalidate() {},
        transform,
      };
    },

    async release() {
      slots.forEach(stopRunner);
    },
  };
};
