import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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
  '  background: url(./icon.svg);',
  '`;',
  '',
].join('\n');

const readCssUrl = (cssFile: string) => {
  const [, url] = readFileSync(cssFile, 'utf8').match(/url\(([^)]+)\)/) ?? [];
  return realpathSync(path.resolve(path.dirname(cssFile), url));
};

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
  writeFileSync(path.join(project, 'src', 'components', 'icon.svg'), '<svg/>');

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

  // The working directory of the CLI is a real path, so a relative pattern
  // matches real paths, while `--source-root` keeps the symlink.
  it('writes CSS into --out-dir when --source-root goes through a symlink', () => {
    const lib = path.join(root, 'lib');
    mkdirSync(path.join(lib, 'components'), { recursive: true });
    writeFileSync(
      path.join(lib, 'components', 'button.js'),
      'exports.button = "button";\n'
    );

    const result = runCli(root, project, [
      '--out-dir',
      path.join(root, 'out-link'),
      '--source-root',
      path.join(root, 'project-link', 'src'),
      '--insert-css-requires',
      lib,
      '--output-metadata',
      'src/**/*.js',
    ]);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Successfully extracted 1 CSS files.');

    const cssFile = path.join(root, 'out-link', 'components', 'button.css');
    expect(readFileSync(cssFile, 'utf8')).toContain('color:red;');
    // The url() is rewritten for the new place of the CSS file.
    expect(readCssUrl(cssFile)).toBe(
      realpathSync(path.join(project, 'src', 'components', 'icon.svg'))
    );
    expect(
      JSON.parse(
        readFileSync(
          path.join(root, 'out', 'components', 'button.wyw-in-js.json'),
          'utf8'
        )
      )
    ).toMatchObject({
      cssFile: 'components/button.css',
      source: 'components/button.js',
    });

    // The require points at the output file through `--out-dir` as given.
    expect(
      readFileSync(path.join(lib, 'components', 'button.js'), 'utf8')
    ).toBe(
      'exports.button = "button";\n\n\nrequire(\'../../out-link/components/button.css\');\n'
    );
    expect(
      readFileSync(path.join(project, 'src', 'components', 'button.js'), 'utf8')
    ).toBe(buttonSource);
  });

  it('writes CSS into --out-dir when the pattern goes through a symlink', () => {
    const result = runCli(root, realpathSync(project), [
      '--out-dir',
      path.join(root, 'out'),
      '--source-root',
      'src',
      path.join(root, 'project-link', 'src', '**', '*.js'),
    ]);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Successfully extracted 1 CSS files.');
    expect(
      readFileSync(path.join(root, 'out', 'components', 'button.css'), 'utf8')
    ).toContain('color:red;');
    expect(
      existsSync(path.join(project, 'src', 'components', 'button.css'))
    ).toBe(false);
  });
});
