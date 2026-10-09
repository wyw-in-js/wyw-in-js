import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { join } from 'path';

export type RunnerMessage = {
  error?: { message?: string };
  id?: string;
  modulesReset?: boolean;
  payload?: Record<string, unknown>;
  sessionId?: number;
  type: string;
};

export const delay = (timeoutMs: number) =>
  new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, timeoutMs);
  });

// Spawns the eval runner the same way the broker does and speaks its
// newline-delimited JSON protocol directly, so tests can drive one runner
// process without a broker in between.
export const createHarness = (cwd: string) => {
  const runnerPath = join(__dirname, '..', '..', 'eval', 'runner.js');
  const nodeBinary = process.execPath.includes('bun')
    ? 'node'
    : process.execPath;
  const child = spawn(
    process.env.WYW_NODE_BINARY || nodeBinary,
    ['--experimental-vm-modules', runnerPath],
    {
      cwd,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        WYW_EVAL_RUNNER: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const messages: RunnerMessage[] = [];
  const listeners = new Set<() => void>();
  let stdoutBuffer = '';
  let stderr = '';

  child.stdout.on('data', (chunk: string) => {
    const lines = `${stdoutBuffer}${chunk}`.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) {
        messages.push(JSON.parse(line) as RunnerMessage);
      }
    }
    for (const listener of listeners) listener();
    listeners.clear();
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const write = (text: string) =>
    new Promise<void>((resolveWrite, rejectWrite) => {
      child.stdin.write(text, (error) => {
        if (error) rejectWrite(error);
        else resolveWrite();
      });
    });

  const send = (...payloads: unknown[]) =>
    write(`${payloads.map((payload) => JSON.stringify(payload)).join('\n')}\n`);

  const take = async (
    predicate: (message: RunnerMessage) => boolean,
    timeoutMs = 2_000
  ): Promise<RunnerMessage> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index !== -1) {
        return messages.splice(index, 1)[0];
      }

      // eslint-disable-next-line no-await-in-loop
      await Promise.race([
        new Promise<void>((resolveMessage) => {
          listeners.add(resolveMessage);
        }),
        delay(Math.min(50, Math.max(1, deadline - Date.now()))),
      ]);
    }

    throw new Error(
      `Timed out waiting for eval runner message. stderr: ${stderr}`
    );
  };

  const waitForStderr = async (pattern: string, timeoutMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (stderr.includes(pattern)) return;
      // eslint-disable-next-line no-await-in-loop
      await delay(10);
    }

    throw new Error(`Timed out waiting for stderr pattern: ${pattern}`);
  };

  const getStderr = () => stderr;

  return { child, getStderr, messages, send, take, waitForStderr, write };
};

export const loadResult = (
  request: RunnerMessage,
  id: string,
  code: string,
  hash: string,
  only: string[]
) => ({
  type: 'LOAD_RESULT',
  id: request.id,
  payload: { code, hash, id, map: null, only },
});

export const stopHarness = async (child: ChildProcessWithoutNullStreams) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => resolveExit());
  });
  child.stdin.end();
  const timeout = Symbol('timeout');
  const result = await Promise.race([
    exited.then(() => undefined),
    delay(500).then(() => timeout),
  ]);
  if (result === timeout) {
    child.kill();
    await exited;
  }
};
