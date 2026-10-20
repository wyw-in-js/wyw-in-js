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

const viteDevClosePath = path.resolve(
  __dirname,
  '__fixtures__',
  'vite-dev-close.ts'
);
const processorPath = path.resolve(
  __dirname,
  '../../../transform/src/__tests__/__fixtures__/test-css-processor.js'
);

type CloseReport = { after: number; before: number; transformed: boolean };

/** src/index.js reads `color` from ./theme, whose value needs the eval runner. */
const createProject = (): string => {
  // `process.cwd()` is a real path after chdir (e.g. /private/var on macOS).
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'wyw-vite-dev-close-'))
  );
  const processorDir = path.join(root, 'node_modules', 'test-css-processor');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(processorDir, { recursive: true });
  writeFileSync(
    path.join(processorDir, 'package.json'),
    JSON.stringify({ name: 'test-css-processor', main: 'index.js' })
  );
  writeFileSync(
    path.join(processorDir, 'index.js'),
    "export const css = (strings) => strings.join('');\n"
  );
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
      "import { color } from './theme';",
      '',
      'export const className = css`color: ${color};`;',
      '',
    ].join('\n')
  );
  writeFileSync(
    path.join(root, 'src', 'theme.js'),
    "export const color = (() => 'blue-' + 'light')();\n"
  );

  return root;
};

const runDevServer = (
  root: string,
  options: Record<string, unknown>
): CloseReport => {
  const result = spawnSync(
    process.execPath,
    [viteDevClosePath, JSON.stringify(options)],
    { cwd: root, encoding: 'utf8', timeout: 60_000 }
  );

  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);

  return JSON.parse(result.stdout);
};

// `ps` lists the eval runners; Windows has none of it.
const describeWithPs = process.platform === 'win32' ? describe.skip : describe;

describeWithPs('vite dev server in middleware mode', () => {
  let root: string;

  beforeEach(() => {
    root = createProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    { name: 'on the main thread', options: {} },
    { name: 'in worker threads', options: { parallel: 1 } },
  ])(
    'leaves no eval runner behind when it closes, $name',
    ({ options }) => {
      const report = runDevServer(root, options);

      expect(report.transformed).toBe(true);
      expect(report.before).toBeGreaterThan(0);
      expect(report.after).toBe(0);
    },
    60_000
  );
});
