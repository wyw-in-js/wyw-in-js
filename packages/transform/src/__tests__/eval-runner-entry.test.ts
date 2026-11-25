import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { deserializeValue, type SerializedValue } from '@wyw-in-js/shared';

import {
  createHarness,
  loadResult,
  stopHarness,
} from './__utils__/eval-runner-harness';

const reportLoadedPackages = join(
  __dirname,
  '__fixtures__',
  'eval-runner',
  'report-loaded-packages.cjs'
);

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
  entrypoint: string,
  globals: Record<string, unknown> = {}
) => ({
  type: 'INIT',
  id: 'init',
  payload: {
    debugEvalFiles: false,
    entrypoint,
    evalOptions: {
      errors: 'strict',
      extensions: ['.js'],
      globals,
      require: 'off',
      root: join(entrypoint, '..'),
    },
    features: { happyDOM: false },
    reuseModules: false,
    sessionId: 1,
  },
});

const createProject = () => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-eval-runner-entry-'));
  const entry = join(root, 'entry.js');
  writeFileSync(entry, '');
  return { entry, root };
};

describe('eval runner process', () => {
  it('the runner process loads neither debug nor find-up', async () => {
    const { entry, root } = createProject();
    const harness = createHarness(root, {
      nodeArgs: ['--require', reportLoadedPackages],
    });
    const closed = new Promise<void>((resolveClose) => {
      harness.child.once('close', () => resolveClose());
    });

    try {
      await harness.send(initMessage(entry));
      const init = await harness.take(
        (message) => message.type === 'INIT_ACK' && message.id === 'init'
      );
      expect(init.error).toBeUndefined();
    } finally {
      await stopHarness(harness.child);
      await closed;
      rmSync(root, { recursive: true, force: true });
    }

    const report = /^LOADED (.*)$/m.exec(harness.getStderr());
    expect(report).not.toBeNull();
    expect(JSON.parse(report![1])).toEqual([]);
  });

  it('eval.globals functions see the Node modules and no runner internals', async () => {
    const { entry, root } = createProject();
    const harness = createHarness(root);
    const probe = [
      '() => ({',
      '  fs: typeof fs,',
      '  path: typeof path,',
      '  vm: typeof vm,',
      '  NativeModule: typeof NativeModule,',
      '  createRequire: typeof createRequire,',
      '  pathToFileURL: typeof pathToFileURL,',
      '  Console: typeof Console,',
      '  Writable: typeof Writable,',
      "  basename: path.basename('/a/b.js'),",
      '  state: typeof state,',
      '  moduleCache: typeof moduleCache,',
      '  serializeValue: typeof serializeValue,',
      '  Minimatch: typeof Minimatch,',
      '  decodeGlobals: typeof decodeGlobals,',
      '})',
    ].join('\n');

    try {
      await harness.send(initMessage(entry, { probe: encodedFunction(probe) }));
      const init = await harness.take(
        (message) => message.type === 'INIT_ACK' && message.id === 'init'
      );
      expect(init.error).toBeUndefined();

      await harness.send({ type: 'EVAL', id: 'eval', payload: { id: entry } });
      const load = await harness.take(
        (message) => message.type === 'LOAD' && message.payload?.id === entry
      );
      await harness.send(
        loadResult(
          load,
          entry,
          'export const __wywPreval = { names: () => probe() };',
          'entry',
          ['__wywPreval']
        )
      );
      const result = await harness.take(
        (message) => message.type === 'EVAL_RESULT' && message.id === 'eval'
      );

      expect(result.error).toBeUndefined();
      const values = result.payload?.values as Record<string, SerializedValue>;
      expect(deserializeValue(values.names)).toEqual({
        fs: 'object',
        path: 'object',
        vm: 'object',
        NativeModule: 'function',
        createRequire: 'function',
        pathToFileURL: 'function',
        Console: 'function',
        Writable: 'function',
        basename: 'b.js',
        state: 'undefined',
        moduleCache: 'undefined',
        serializeValue: 'undefined',
        Minimatch: 'undefined',
        decodeGlobals: 'undefined',
      });
    } finally {
      await stopHarness(harness.child);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
