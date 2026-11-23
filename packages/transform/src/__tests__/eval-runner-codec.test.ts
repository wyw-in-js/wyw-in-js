import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { mergeOnly } from '../transform/Entrypoint.helpers';

import {
  createHarness,
  loadResult,
  stopHarness,
} from './__utils__/eval-runner-harness';

const initMessage = (id: string, entrypoint: string) => ({
  type: 'INIT',
  id,
  payload: {
    debugEvalFiles: false,
    entrypoint,
    evalOptions: {
      errors: 'strict',
      extensions: ['.js', '.mjs'],
      globals: {},
      require: 'off',
      root: join(entrypoint, '..'),
    },
    features: { happyDOM: false },
    reuseModules: false,
    sessionId: 1,
  },
});

const createProject = () => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-eval-runner-codec-'));
  const entry = join(root, 'entry.js');
  writeFileSync(entry, '');
  return { entry, root };
};

// Starts a runner session on `entry`, answers the LOAD of the entry with
// `code` and returns the EVAL_RESULT of that evaluation.
const evaluateEntry = async (
  harness: ReturnType<typeof createHarness>,
  entry: string,
  code: string,
  only: string[]
) => {
  await harness.send(initMessage('init', entry));
  await harness.take(
    (message) => message.type === 'INIT_ACK' && message.id === 'init'
  );
  await harness.send({ type: 'EVAL', id: 'eval', payload: { id: entry } });
  const load = await harness.take(
    (message) => message.type === 'LOAD' && message.payload?.id === entry
  );
  await harness.send(loadResult(load, entry, code, 'entry', only));
  return harness.take(
    (message) => message.type === 'EVAL_RESULT' && message.id === 'eval'
  );
};

describe('eval runner error codec', () => {
  it('keeps the name and the cause chain of an error thrown by evaluated code', async () => {
    const { entry, root } = createProject();
    const harness = createHarness(root);

    try {
      const result = await evaluateEntry(
        harness,
        entry,
        [
          'const fail = () => {',
          "  throw new TypeError('outer', {",
          "    cause: new RangeError('middle', { cause: new Error('inner') }),",
          '  });',
          '};',
          'export const __wywPreval = { value: fail() };',
        ].join('\n'),
        ['__wywPreval']
      );

      expect(result.error).toMatchObject({
        message: 'outer',
        name: 'TypeError',
        cause: {
          message: 'middle',
          name: 'RangeError',
          cause: { message: 'inner', name: 'Error' },
        },
      });
    } finally {
      await stopHarness(harness.child);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('eval runner protocol', () => {
  it('writes only protocol lines to stdout from start to exit', async () => {
    const { entry, root } = createProject();
    const harness = createHarness(root);
    let stdout = '';
    harness.child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const closed = new Promise<void>((resolveClose) => {
      harness.child.once('close', () => resolveClose());
    });

    try {
      const result = await evaluateEntry(
        harness,
        entry,
        "export const __wywPreval = { value: () => 'ok' };",
        ['__wywPreval']
      );
      expect(result.error).toBeUndefined();
    } finally {
      await stopHarness(harness.child);
      await closed;
      rmSync(root, { recursive: true, force: true });
    }

    expect(stdout.endsWith('\n')).toBe(true);
    const lines = stdout.split('\n').filter((line) => line !== '');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    lines.forEach((line) => {
      const message = JSON.parse(line) as { type?: unknown };
      expect(typeof message.type).toBe('string');
    });
  });

  it('orders the exports of a module the way the runner merges only, unlike the broker', async () => {
    const { entry, root } = createProject();
    const harness = createHarness(root);

    try {
      const result = await evaluateEntry(
        harness,
        entry,
        [
          "export const a = 'A';",
          "export const b = 'B';",
          "export const c = 'C';",
        ].join('\n'),
        ['b', 'a']
      );

      expect(result.error).toBeUndefined();
      const modules = result.payload?.modules as Record<
        string,
        Record<string, unknown>
      >;
      expect(Object.keys(modules[entry])).toEqual(['b', 'a', 'c']);
    } finally {
      await stopHarness(harness.child);
      rmSync(root, { recursive: true, force: true });
    }

    // The broker side sorts the merged names and keeps a wildcard beside
    // explicit names.
    expect(mergeOnly([], ['b', 'a'])).toEqual(['a', 'b']);
    expect(mergeOnly(['a'], ['*'])).toEqual(['*', 'a']);
  });
});
