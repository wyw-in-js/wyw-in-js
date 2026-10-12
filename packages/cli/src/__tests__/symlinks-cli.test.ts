import { spawnSync } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const cliPath = path.resolve(__dirname, '../wyw-in-js.ts');
const processorPath = path.resolve(
  __dirname,
  '../../../transform/src/__tests__/__fixtures__/test-css-processor.js'
);

const buttonSource = [
  "import { css } from 'test-css-processor';",
  '',
  'export const button = css`',
  '  color: red;',
  '`;',
  '',
].join('\n');

// `junction` makes directory links without extra privileges on Windows;
// other platforms ignore the type.
const linkDirectory = (target: string, link: string) =>
  symlinkSync(target, link, 'junction');

/**
 * root/
 *   project/src/components/button.js
 *   project-link -> project
 *   out/
 *   out-link -> out
 */
const createProject = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wyw-cli-symlinks-'));
  const project = path.join(root, 'project');
  const processorDir = path.join(root, 'node_modules', 'test-css-processor');
  mkdirSync(path.join(project, 'src', 'components'), { recursive: true });
  mkdirSync(path.join(root, 'out'), { recursive: true });
  mkdirSync(processorDir, { recursive: true });

  writeFileSync(
    path.join(processorDir, 'package.json'),
    JSON.stringify({ name: 'test-css-processor', type: 'module' })
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
    path.join(project, 'src', 'components', 'button.js'),
    buttonSource
  );

  linkDirectory(project, path.join(root, 'project-link'));
  linkDirectory(path.join(root, 'out'), path.join(root, 'out-link'));

  return { project, root };
};

const runCli = (root: string, cwd: string, args: string[]) =>
  spawnSync(
    process.execPath,
    [cliPath, '--config', path.join(root, 'wyw-in-js.config.cjs'), ...args],
    {
      cwd,
      encoding: 'utf8',
      // A leaked eval broker keeps the process alive until this timeout.
      timeout: 20_000,
    }
  );

describe('CLI and symlinks', () => {
  let project: string;
  let root: string;

  beforeEach(() => {
    ({ project, root } = createProject());
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('skips a symlink to a directory among the matched files', () => {
    const elsewhere = path.join(root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(path.join(elsewhere, 'ignored.js'), buttonSource);
    linkDirectory(elsewhere, path.join(project, 'src', 'components', 'linked'));

    const result = runCli(root, project, [
      '--out-dir',
      path.join(root, 'out'),
      '--source-root',
      'src',
      'src/components/*',
    ]);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Successfully extracted 1 CSS files.');
    expect(
      readFileSync(path.join(root, 'out', 'components', 'button.css'), 'utf8')
    ).toContain('color:red;');
  });

  it('still fails on a broken symlink among the matched files', () => {
    symlinkSync(
      path.join(root, 'missing.js'),
      path.join(project, 'src', 'components', 'broken.js')
    );

    const result = runCli(root, project, [
      '--out-dir',
      path.join(root, 'out'),
      '--source-root',
      'src',
      'src/components/*',
    ]);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ENOENT');
  });
});
