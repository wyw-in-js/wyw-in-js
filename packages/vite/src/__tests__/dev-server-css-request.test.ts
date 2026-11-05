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

const viteDevCssRequestPath = path.resolve(
  __dirname,
  '__fixtures__',
  'vite-dev-css-request.ts'
);
const processorPath = path.resolve(
  __dirname,
  '../../../transform/src/__tests__/__fixtures__/test-css-processor.js'
);

type CssRequestReport = { direct: string | null; module: string | null };

/** src/index.js declares one class with `color: red`. */
const createProject = (): string => {
  // `process.cwd()` is a real path after chdir (e.g. /private/var on macOS).
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'wyw-vite-dev-css-request-'))
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
      '',
      'export const className = css`color: red;`;',
      '',
    ].join('\n')
  );

  return root;
};

const requestCss = (root: string): CssRequestReport => {
  const result = spawnSync(process.execPath, [viteDevCssRequestPath], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);

  return JSON.parse(result.stdout);
};

describe('vite dev server request of a generated CSS file', () => {
  let report: CssRequestReport;
  let root: string;

  beforeAll(() => {
    root = createProject();
    report = requestCss(root);
  }, 60_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the stylesheet for a ?direct request', () => {
    expect(report.direct).toMatch(/^\.[\w-]+\s*\{\s*color:\s*red;?\s*\}\s*$/);
  });

  it('returns the JavaScript module that injects it for a request without a query', () => {
    expect(report.module).toMatch(/^import /);
    expect(report.module).toMatch(/color:\s*red/);
  });
});
