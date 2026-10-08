import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import {
  createHarness,
  loadResult,
  stopHarness,
} from './__utils__/eval-runner-harness';

// The broker expands eval `conditionNames` per edge kind and sends the result
// in INIT. These tests speak that wire format directly, so they cover what the
// runner does with the conditions when it has to resolve on its own.
type RunnerConditions = { import: string[]; require: string[] };

const CJS_DEFAULTS = ['require', 'node', 'default'];

const CUSTOM: RunnerConditions = {
  import: ['custom', 'node', 'import', 'default'],
  require: ['custom', 'require', 'node', 'default'],
};

const writeFiles = (root: string, files: Record<string, string>) => {
  Object.entries(files).forEach(([file, content]) => {
    const filename = join(root, file);
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, content);
  });
};

const condPkg = {
  'node_modules/cond-pkg/package.json': JSON.stringify({
    name: 'cond-pkg',
    exports: {
      '.': {
        custom: './custom.js',
        require: './require.js',
        'custom-only': './custom-only.js',
        default: './default.js',
      },
      './src/*': {
        custom: './src/*',
        default: './dist/*.js',
      },
    },
  }),
  'node_modules/cond-pkg/custom.js': "module.exports = 'custom';",
  'node_modules/cond-pkg/require.js': "module.exports = 'require';",
  'node_modules/cond-pkg/custom-only.js': "module.exports = 'custom-only';",
  'node_modules/cond-pkg/default.js': "module.exports = 'default';",
  'node_modules/cond-pkg/src/util.js': "module.exports = 'src-util';",
  'node_modules/cond-pkg/src/gone.js.js':
    "module.exports = 'guessed-extension';",
  'node_modules/@scope/pkg/package.json': JSON.stringify({
    name: '@scope/pkg',
    exports: { '.': { custom: './index' } },
  }),
  'node_modules/@scope/pkg.js': "module.exports = 'wrong-package';",
};

type RunnerSession = {
  harness: ReturnType<typeof createHarness>;
  root: string;
};

const startRunner = async (
  conditions: RunnerConditions | undefined
): Promise<RunnerSession & { entry: string }> => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-eval-runner-conditions-'));
  writeFiles(root, condPkg);
  const entry = join(root, 'entry.js');
  writeFileSync(entry, '');
  const harness = createHarness(root);
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
        ...(conditions ? { conditions } : {}),
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
  return { entry, harness, root };
};

const finish = async ({ harness, root }: RunnerSession) => {
  await stopHarness(harness.child);
  rmSync(root, { recursive: true, force: true });
};

const evaluate = async (
  { harness }: RunnerSession,
  entry: string,
  code: string,
  answerResolve?: (specifier: string) => Record<string, unknown>
) => {
  await harness.send({ type: 'EVAL', id: 'eval', payload: { id: entry } });
  const load = await harness.take(
    (message) => message.type === 'LOAD' && message.payload?.id === entry
  );
  await harness.send(loadResult(load, entry, code, 'entry', ['__wywPreval']));

  if (answerResolve) {
    const resolve = await harness.take((message) => message.type === 'RESOLVE');
    await harness.send({
      type: 'RESOLVE_RESULT',
      id: resolve.id,
      payload: answerResolve(String(resolve.payload?.specifier)),
    });
  }

  const result = await harness.take(
    (message) => message.type === 'EVAL_RESULT' && message.id === 'eval'
  );
  expect(result.error).toBeUndefined();
  return (result.payload?.values as Record<string, { value: unknown }>).value
    .value;
};

// Evaluated code reaches the runner's require() fallback directly: nothing
// asks the broker, so the runner itself has to apply the conditions.
const requireInEval = async (
  conditions: RunnerConditions | undefined,
  specifier: string
) => {
  const session = await startRunner(conditions);
  try {
    return await evaluate(
      session,
      session.entry,
      [
        'export const __wywPreval = {',
        '  value: () => {',
        '    try {',
        `      return require(${JSON.stringify(specifier)});`,
        '    } catch (error) {',
        '      return `error:${error.code ?? error.message}`;',
        '    }',
        '  },',
        '};',
      ].join('\n')
    );
  } finally {
    await finish(session);
  }
};

describe('eval runner conditionNames', () => {
  describe('require() fallback', () => {
    it('resolves package exports with the configured conditions', async () => {
      expect(await requireInEval(CUSTOM, 'cond-pkg')).toBe('custom');
    });

    it('keeps the expanded Node defaults for "..."', async () => {
      expect(
        await requireInEval(
          { import: ['node', 'import', 'default'], require: CJS_DEFAULTS },
          'cond-pkg'
        )
      ).toBe('require');
    });

    it('uses only the listed conditions when "..." is absent', async () => {
      expect(
        await requireInEval(
          { import: ['custom-only'], require: ['custom-only'] },
          'cond-pkg'
        )
      ).toBe('custom-only');
    });

    it('keeps Node resolution when no conditions are configured', async () => {
      expect(await requireInEval(undefined, 'cond-pkg')).toBe('require');
      expect(await requireInEval(undefined, 'cond-pkg/src/util')).toBe(
        'error:MODULE_NOT_FOUND'
      );
    });

    it('retries extensions for extensionless conditional subpaths', async () => {
      expect(await requireInEval(CUSTOM, 'cond-pkg/src/util')).toBe('src-util');
    });

    it('does not retry extensions for explicit extensions', async () => {
      expect(await requireInEval(CUSTOM, 'cond-pkg/src/gone.js')).toBe(
        'error:MODULE_NOT_FOUND'
      );
    });

    it('does not retry extensions for scoped package roots', async () => {
      expect(await requireInEval(CUSTOM, '@scope/pkg')).toBe(
        'error:MODULE_NOT_FOUND'
      );
    });
  });

  describe('import edges resolved by the runner', () => {
    const importCode = [
      "import value from 'cond-pkg';",
      'export const __wywPreval = { value: () => value };',
    ].join('\n');

    it('re-resolves an extensionless resolved id with import conditions', async () => {
      const session = await startRunner(CUSTOM);
      try {
        const missing = join(session.root, 'node_modules', 'cond-pkg', 'main');
        expect(
          await evaluate(session, session.entry, importCode, () => ({
            resolvedId: missing,
          }))
        ).toBe('custom');
      } finally {
        await finish(session);
      }
    });

    it('resolves a bare external id with import conditions', async () => {
      const session = await startRunner(CUSTOM);
      try {
        expect(
          await evaluate(session, session.entry, importCode, (specifier) => ({
            external: true,
            resolvedId: specifier,
          }))
        ).toBe('custom');
      } finally {
        await finish(session);
      }
    });

    it('keeps Node resolution for a bare external id without conditions', async () => {
      const session = await startRunner(undefined);
      try {
        expect(
          await evaluate(session, session.entry, importCode, (specifier) => ({
            external: true,
            resolvedId: specifier,
          }))
        ).toBe('require');
      } finally {
        await finish(session);
      }
    });
  });
});
