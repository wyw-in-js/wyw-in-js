import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { deserializeError, serializeError } from '@wyw-in-js/shared';

type RunnerFrame = {
  [key: string]: unknown;
  error?: Parameters<typeof deserializeError>[0];
  id?: string;
  payload?: Record<string, unknown>;
  type: string;
};

type EvalRunner = {
  handleMessage: (message: unknown) => Promise<void>;
  parseStdinMessage: (line: string) => unknown;
  teardown: () => void;
};

type RunnerCore = {
  createEvalRunner: (options: {
    env: Record<string, string | undefined>;
    send: (message: RunnerFrame) => void;
    writeStderr: (
      text: string,
      callback?: (error?: Error | null) => void
    ) => void;
  }) => EvalRunner;
  isBarePackageSubpath: (id: string) => boolean;
  resolveFromImporter: (
    specifier: string,
    importerFile: string,
    kind: 'import' | 'dynamic-import' | 'require',
    evalOptions: { extensions?: string[] }
  ) => string;
};

// The core and the protocol module are imported inside the tests, so that a
// failure to load them or a missing export fails a test instead of the whole
// file.
const loadCore = async () =>
  (await import('../eval/runner.js')) as unknown as RunnerCore;

const ENTRY = '/root/entry.js';

// A function of `eval.globals` as the broker sends it in INIT.
const encodedFunction = (source: string) => ({
  __wyw_eval_global: {
    signature: 'wyw-eval-global',
    version: 1,
    kind: 'function',
    source,
  },
});

const initMessage = (
  id: string,
  {
    globals = {},
    reuseModules = false,
    sessionId = 1,
  }: {
    globals?: Record<string, unknown>;
    reuseModules?: boolean;
    sessionId?: number;
  } = {}
) => ({
  type: 'INIT',
  id,
  payload: {
    debugEvalFiles: false,
    entrypoint: ENTRY,
    evalOptions: {
      errors: 'strict',
      extensions: ['.js'],
      globals,
      require: 'off',
      root: '/root',
    },
    features: { happyDOM: false },
    reuseModules,
    sessionId,
  },
});

// A runner with a replaced transport: frames it sends and text it writes to
// stderr are collected.
const createRunner = async () => {
  const { createEvalRunner } = await loadCore();
  const frames: RunnerFrame[] = [];
  const stderr: string[] = [];
  const runner = createEvalRunner({
    env: {},
    send: (message) => {
      frames.push(message);
    },
    writeStderr: (text, callback) => {
      stderr.push(text);
      callback?.();
    },
  });
  return { frames, runner, stderr };
};

const tick = () =>
  new Promise<void>((resolveTick) => {
    setTimeout(resolveTick, 5);
  });

const waitForFrame = async (
  frames: RunnerFrame[],
  predicate: (frame: RunnerFrame) => boolean,
  timeoutMs = 2_000
): Promise<RunnerFrame> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = frames.find(predicate);
    if (frame) return frame;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for a runner frame. Sent: ${JSON.stringify(frames)}`
      );
    }

    // eslint-disable-next-line no-await-in-loop
    await tick();
  }
};

// Every frame the core sends is a message of the protocol that the broker
// accepts.
const expectProtocolFrames = async (frames: RunnerFrame[]) => {
  const { parseRunnerMessage } = await import('../eval/protocol');
  expect(frames.length).toBeGreaterThan(0);
  frames.forEach((frame) => {
    const line = JSON.stringify(frame);
    expect(parseRunnerMessage(line)).toEqual(JSON.parse(line));
  });
};

const failedLoad = (load: RunnerFrame) => ({
  type: 'LOAD_RESULT',
  id: load.id,
  payload: { id: ENTRY, error: serializeError(new TypeError('boom')) },
});

const expectFailedLoadResult = (result: RunnerFrame) => {
  expect(result.payload).toEqual({ values: null, evictedIds: [ENTRY] });
  const error = deserializeError(result.error);
  expect(error.message).toContain('Failed to load module during evaluation');
  expect(error.cause).toMatchObject({ name: 'TypeError', message: 'boom' });
};

describe('eval runner core', () => {
  it('imports the runner core without side effects', async () => {
    const consoleBefore = globalThis.console;
    const stdoutWriteBefore = process.stdout.write;
    const stdinEvents = ['data', 'close'] as const;
    const stdinListenersBefore = stdinEvents.map((event) =>
      process.stdin.listenerCount(event)
    );

    const originalSetTimeout = globalThis.setTimeout;
    const originalSetInterval = globalThis.setInterval;
    const originalSetImmediate = globalThis.setImmediate;
    const originalExit = process.exit;
    const startedTimers: Array<() => void> = [];
    let exitCalled = false;

    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const handle = originalSetTimeout(...args);
      startedTimers.push(() => clearTimeout(handle));
      return handle;
    }) as typeof setTimeout;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = originalSetInterval(...args);
      startedTimers.push(() => clearInterval(handle));
      return handle;
    }) as typeof setInterval;
    globalThis.setImmediate = ((...args: Parameters<typeof setImmediate>) => {
      const handle = originalSetImmediate(...args);
      startedTimers.push(() => clearImmediate(handle));
      return handle;
    }) as typeof setImmediate;
    process.exit = (() => {
      exitCalled = true;
    }) as typeof process.exit;

    let observed: Record<string, unknown>;
    try {
      await loadCore();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.setInterval = originalSetInterval;
      globalThis.setImmediate = originalSetImmediate;
      process.exit = originalExit;

      const stdinListenersAdded = stdinEvents.reduce(
        (added, event, index) =>
          added +
          process.stdin.listenerCount(event) -
          stdinListenersBefore[index],
        0
      );
      observed = {
        consoleReplaced: globalThis.console !== consoleBefore,
        stdoutWriteReplaced: process.stdout.write !== stdoutWriteBefore,
        stdinListenersAdded,
        timersStarted: startedTimers.length,
        exitCalled,
      };

      // Undo whatever the import did, so that the rest of the run is not
      // affected by it.
      globalThis.console = consoleBefore;
      process.stdout.write = stdoutWriteBefore;
      stdinEvents.forEach((event, index) => {
        process.stdin
          .listeners(event)
          .slice(stdinListenersBefore[index])
          .forEach((listener) => {
            process.stdin.off(event, listener as (...args: unknown[]) => void);
          });
      });
      if (stdinListenersAdded > 0) {
        process.stdin.pause();
      }
      startedTimers.forEach((clear) => clear());
    }

    expect(observed).toEqual({
      consoleReplaced: false,
      stdoutWriteReplaced: false,
      stdinListenersAdded: 0,
      timersStarted: 0,
      exitCalled: false,
    });
  });

  describe('parseStdinMessage', () => {
    it('returns a protocol message of a well-formed line', async () => {
      const { runner, stderr } = await createRunner();
      const message = { type: 'EVAL', id: 'eval', payload: { id: ENTRY } };

      expect(runner.parseStdinMessage(JSON.stringify(message))).toEqual(
        message
      );
      expect(stderr).toEqual([]);
    });

    it('drops a line that is not JSON and reports it on stderr', async () => {
      const { runner, stderr } = await createRunner();

      expect(runner.parseStdinMessage('not json')).toBeNull();
      expect(stderr).toHaveLength(1);
      expect(
        stderr[0].startsWith(
          '[wyw-eval-runner] Dropped malformed stdin message ('
        )
      ).toBe(true);
      expect(stderr[0]).toContain(': not json');
    });

    it('drops JSON that is not a protocol message and reports it on stderr', async () => {
      const { runner, stderr } = await createRunner();

      expect(runner.parseStdinMessage('{"type":"EVAL"}')).toBeNull();
      expect(stderr).toEqual([
        '[wyw-eval-runner] Dropped malformed stdin message (not a protocol message): {"type":"EVAL"}\n',
      ]);
    });
  });

  describe('handleMessage', () => {
    it('acknowledges INIT and keeps the modules on a reusing INIT with the same globals', async () => {
      const { frames, runner } = await createRunner();

      try {
        await runner.handleMessage(initMessage('init-1'));
        await runner.handleMessage(
          initMessage('init-2', { reuseModules: true, sessionId: 2 })
        );

        expect(frames).toEqual([
          { type: 'INIT_ACK', id: 'init-1', modulesReset: true },
          { type: 'INIT_ACK', id: 'init-2', modulesReset: false },
        ]);
        await expectProtocolFrames(frames);
      } finally {
        runner.teardown();
      }
    });

    it('reports an eval.globals function that cannot be restored in INIT_ACK', async () => {
      const { frames, runner } = await createRunner();

      try {
        await runner.handleMessage(
          initMessage('init', { globals: { broken: encodedFunction('42') } })
        );

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({ type: 'INIT_ACK', id: 'init' });
        expect(deserializeError(frames[0].error).message).toContain(
          'Failed to restore eval.globals function at'
        );
        await expectProtocolFrames(frames);
      } finally {
        runner.teardown();
      }
    });

    it('restores an eval.globals function in INIT', async () => {
      const { frames, runner } = await createRunner();

      try {
        await runner.handleMessage(
          initMessage('init', { globals: { one: encodedFunction('() => 1') } })
        );

        expect(frames).toEqual([
          { type: 'INIT_ACK', id: 'init', modulesReset: true },
        ]);
        await expectProtocolFrames(frames);
      } finally {
        runner.teardown();
      }
    });

    it('asks for the entrypoint with LOAD and reports a failed load in EVAL_RESULT', async () => {
      const { frames, runner } = await createRunner();

      try {
        await runner.handleMessage(initMessage('init'));
        const evaluating = runner.handleMessage({
          type: 'EVAL',
          id: 'eval',
          payload: { id: ENTRY },
        });

        const load = await waitForFrame(
          frames,
          (frame) => frame.type === 'LOAD'
        );
        expect(load).toEqual({
          type: 'LOAD',
          id: expect.any(String),
          payload: { id: ENTRY, importerId: ENTRY, request: ENTRY },
          sessionId: 1,
        });

        await runner.handleMessage(failedLoad(load));
        await evaluating;

        const result = await waitForFrame(
          frames,
          (frame) => frame.type === 'EVAL_RESULT'
        );
        expect(result.id).toBe('eval');
        expectFailedLoadResult(result);
        await expectProtocolFrames(frames);
      } finally {
        runner.teardown();
      }
    });

    it('assembles a LOAD_RESULT sent in chunks before it answers the LOAD', async () => {
      const { frames, runner } = await createRunner();

      try {
        await runner.handleMessage(initMessage('init'));
        const evaluating = runner.handleMessage({
          type: 'EVAL',
          id: 'eval',
          payload: { id: ENTRY },
        });
        const load = await waitForFrame(
          frames,
          (frame) => frame.type === 'LOAD'
        );
        const { error } = failedLoad(load).payload;

        await runner.handleMessage({
          type: 'LOAD_RESULT',
          id: load.id,
          payload: {
            id: ENTRY,
            error,
            codeChunk: 'export const value',
            chunkIndex: 0,
            chunkCount: 2,
          },
        });
        await tick();
        expect(frames.some((frame) => frame.type === 'EVAL_RESULT')).toBe(
          false
        );

        await runner.handleMessage({
          type: 'LOAD_RESULT',
          id: load.id,
          payload: {
            id: ENTRY,
            codeChunk: ' = 1;',
            chunkIndex: 1,
            chunkCount: 2,
          },
        });
        await evaluating;

        const result = await waitForFrame(
          frames,
          (frame) => frame.type === 'EVAL_RESULT'
        );
        expect(result.id).toBe('eval');
        expectFailedLoadResult(result);
        await expectProtocolFrames(frames);
      } finally {
        runner.teardown();
      }
    });
  });

  describe('resolution', () => {
    it.each([
      { id: '@scope/pkg/sub', expected: true },
      { id: '@scope/pkg', expected: false },
      { id: 'pkg/sub', expected: true },
      { id: 'pkg', expected: false },
      { id: './x', expected: false },
      { id: resolve('/abs/pkg/sub'), expected: false },
    ])('isBarePackageSubpath($id) is $expected', async ({ id, expected }) => {
      const { isBarePackageSubpath } = await loadCore();

      expect(isBarePackageSubpath(id)).toBe(expected);
    });

    it('resolves relative and package subpath specifiers without conditions', async () => {
      const { resolveFromImporter } = await loadCore();
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), 'wyw-eval-runner-core-'))
      );

      try {
        const src = join(root, 'src');
        const pkg = join(root, 'node_modules', 'pkg');
        mkdirSync(src, { recursive: true });
        mkdirSync(pkg, { recursive: true });
        const importer = join(src, 'entry.js');
        writeFileSync(importer, '');
        writeFileSync(join(src, 'dep.js'), '');
        writeFileSync(join(pkg, 'package.json'), '{"name":"pkg"}');
        writeFileSync(join(pkg, 'sub.js'), '');
        const evalOptions = { extensions: ['.js'] };

        // Resolution with export conditions is covered by the spawned runner
        // tests (eval-runner-conditions): under Bun, the resolver of
        // `node:module` called with conditions crashes the test process.
        expect(
          resolveFromImporter('./dep', importer, 'import', evalOptions)
        ).toBe(join(src, 'dep.js'));
        expect(
          resolveFromImporter('pkg/sub', importer, 'import', evalOptions)
        ).toBe(join(pkg, 'sub.js'));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
