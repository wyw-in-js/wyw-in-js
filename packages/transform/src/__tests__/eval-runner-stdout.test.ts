import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  createHarness,
  loadResult,
  stopHarness,
} from './__utils__/eval-runner-harness';

// stdout of the eval runner carries its newline-delimited protocol. Evaluated
// code can still reach the real stdout: require('process') returns the real
// process, and require('console') returns the original console of Node.
describe('eval runner stdout', () => {
  it('keeps the protocol intact when evaluated code writes to stdout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-runner-stdout-'));
    const entry = join(root, 'entry.js');
    const source = [
      'export const __wywPreval = {',
      '  value: () => {',
      "    require('process').stdout.write('process-stdout-without-newline');",
      "    require('console').log('console-module-log');",
      "    return 'alive';",
      '  },',
      '};',
    ].join('\n');
    writeFileSync(entry, source);
    const harness = createHarness(root);

    try {
      await harness.send({
        type: 'INIT',
        id: 'init',
        payload: {
          debugEvalFiles: false,
          entrypoint: entry,
          evalOptions: {
            errors: 'strict',
            extensions: ['.js'],
            globals: {},
            require: 'warn-and-run',
            root,
          },
          features: { happyDOM: false },
          reuseModules: false,
          sessionId: 1,
        },
      });
      const init = await harness.take(
        (message) => message.type === 'INIT_ACK' && message.id === 'init'
      );
      expect(init.error).toBeUndefined();

      await harness.send({ type: 'EVAL', id: 'eval', payload: { id: entry } });
      const load = await harness.take(
        (message) => message.type === 'LOAD' && message.payload?.id === entry
      );
      await harness.send(
        loadResult(load, entry, source, 'entry', ['__wywPreval'])
      );
      const result = await harness.take(
        (message) => message.type === 'EVAL_RESULT' && message.id === 'eval'
      );

      expect(result.error).toBeUndefined();
      expect(result.payload?.values).toEqual({
        value: { kind: 'string', value: 'alive' },
      });
      await harness.waitForStderr('console-module-log');
      expect(harness.getStderr()).toContain(
        '[wyw-runner:host stdout] process-stdout-without-newline'
      );
      expect(harness.getStderr()).toContain(
        '[wyw-runner:host stdout] console-module-log'
      );
      expect(harness.child.exitCode).toBeNull();
    } finally {
      await stopHarness(harness.child);
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
