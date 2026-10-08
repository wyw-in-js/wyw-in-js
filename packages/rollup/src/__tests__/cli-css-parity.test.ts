import { spawnSync } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { rollup } from 'rollup';

import wywInJS from '../index';

// The CLI is the only integration that writes CSS to files (`outputFilename`).
// For the same input and options it must produce the CSS a bundler gets.
const cliPath = path.resolve(__dirname, '../../../cli/src/wyw-in-js.ts');
const processorPath = path.resolve(
  __dirname,
  '../../../transform/src/__tests__/__fixtures__/test-css-processor.js'
);

const createProject = (): string => {
  // `process.cwd()` is a real path after chdir (e.g. /private/var on macOS).
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'wyw-cli-rollup-parity-'))
  );
  const processorDir = path.join(root, 'node_modules', 'test-css-processor');
  mkdirSync(path.join(root, 'src'), { recursive: true });
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
  // No relative url(): the CLI rewrites those against the output file.
  writeFileSync(
    path.join(root, 'src', 'index.js'),
    [
      "import { css } from 'test-css-processor';",
      '',
      'export const className = css`',
      '  display: flex inline;',
      '  /* rtl:ignore */',
      '  user-select: none;',
      '  /* note */',
      '  & > span { transform: translateX(1px); }',
      '`;',
      '',
    ].join('\n')
  );

  return root;
};

const runCli = (root: string, flags: string[]): string => {
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      '--config',
      path.join(root, 'wyw-in-js.config.cjs'),
      '--out-dir',
      path.join(root, 'dist'),
      '--source-root',
      root,
      ...flags,
      path.join(root, 'src', 'index.js'),
    ],
    { encoding: 'utf8', timeout: 30_000 }
  );

  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);

  return readFileSync(path.join(root, 'dist', 'src', 'index.css'), 'utf8');
};

const runRollup = async (
  root: string,
  options: Parameters<typeof wywInJS>[0]
): Promise<string> => {
  const css: string[] = [];
  const cwd = process.cwd();
  // Class names are derived from the path relative to the root, which is the
  // working directory for bundler adapters and --source-root for the CLI.
  process.chdir(root);

  try {
    const bundle = await rollup({
      input: path.join(root, 'src', 'index.js'),
      external: ['test-css-processor'],
      plugins: [
        wywInJS({
          configFile: path.join(root, 'wyw-in-js.config.cjs'),
          ...options,
        }),
        {
          name: 'capture-css',
          transform(code, id) {
            if (!id.endsWith('.css')) return null;
            css.push(code);
            return { code: 'export {};', map: null };
          },
        },
      ],
    });

    await bundle.generate({ format: 'esm' });
    await bundle.close();
  } finally {
    process.chdir(cwd);
  }

  expect(css).toHaveLength(1);
  return css[0];
};

describe('CLI and rollup CSS parity', () => {
  let root: string;

  beforeAll(() => {
    root = createProject();
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    {
      flags: [],
      options: {},
      check: (css: string) => {
        expect(css).toContain('display:-webkit-inline-box;');
        expect(css).toContain('-webkit-user-select:none;');
        expect(css).toContain('-webkit-transform:translateX(1px);');
      },
    },
    {
      flags: ['--no-prefixer', '--keep-comments-pattern', 'rtl:'],
      options: { prefixer: false, keepComments: /rtl:/ },
      check: (css: string) => {
        expect(css).toContain('{display:flex inline;/* rtl:ignore */');
        expect(css).not.toContain('-webkit-');
        expect(css).not.toContain('/* note */');
      },
    },
    {
      flags: ['--keep-comments'],
      options: { keepComments: true },
      check: (css: string) => {
        expect(css).toContain('/* rtl:ignore */-webkit-user-select:none;');
        expect(css).toContain('/* note */');
      },
    },
    {
      flags: ['--preprocessor', 'none'],
      options: { preprocessor: 'none' as const },
      check: (css: string) => {
        expect(css).toContain(' {\n  display: flex inline;\n');
      },
    },
  ])(
    'matches for flags $flags',
    async ({ flags, options, check }) => {
      const cliCss = runCli(root, flags);
      const rollupCss = await runRollup(root, options);

      check(cliCss);
      expect(cliCss).toBe(rollupCss);
    },
    60_000
  );
});
