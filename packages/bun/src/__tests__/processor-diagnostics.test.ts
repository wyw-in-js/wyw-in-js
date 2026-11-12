import { spawnSync } from 'child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const bunBuildPath = path.resolve(__dirname, '__fixtures__', 'bun-build.ts');
const processorPath = path.resolve(
  __dirname,
  '../../../transform/src/__tests__/__fixtures__/test-diagnostic-processor.js'
);

const createProject = (): string => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'wyw-bun-diagnostics-'))
  );
  mkdirSync(path.join(root, 'src'), { recursive: true });
  // Options of worker threads (`parallel`) must come from a config file.
  writeFileSync(
    path.join(root, 'wyw-in-js.config.cjs'),
    [
      'module.exports = {',
      '  tagResolver(source, tag) {',
      `    if (source === 'test-css-processor' && tag === 'css') return ${JSON.stringify(
        processorPath
      )};`,
      '    return null;',
      '  },',
      '};',
      '',
    ].join('\n')
  );
  writeFileSync(
    path.join(root, 'src', 'index.js'),
    [
      "import { css } from 'test-css-processor';",
      'export const button = css`color: red;`;',
      '',
    ].join('\n')
  );

  return root;
};

describe('bun processor diagnostics', () => {
  let root: string;

  beforeEach(() => {
    root = createProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    { name: 'on the main thread', parallel: [] },
    { name: 'in worker threads', parallel: ['1'] },
  ])(
    'forwards processor diagnostics as warnings $name',
    ({ parallel }) => {
      const result = spawnSync(process.execPath, [bunBuildPath, ...parallel], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).join('')).toContain('color: red;');
      // The plugin reports its warnings on the console.
      expect(result.stderr).toContain(
        '[wyw-in-js] warning [dx-style/raw-color] Use a design token instead of a raw color.\n' +
          `  at ${path.join(root, 'src', 'index.js')}:2:23 (button)`
      );
    },
    60_000
  );
});
