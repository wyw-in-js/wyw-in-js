import { spawnSync } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const cliPath = path.resolve(__dirname, '../wyw-in-js.ts');
const processorPath = path.resolve(
  __dirname,
  '../../../transform/src/__tests__/__fixtures__/test-css-processor.js'
);

const createProject = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'wyw-cli-css-options-'));
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
  writeFileSync(
    path.join(root, 'src', 'index.js'),
    [
      "import { css } from 'test-css-processor';",
      '',
      'export const className = css`',
      '  display: flex inline;',
      '  /* rtl:ignore */',
      '  mask: url(./mask.svg);',
      '  /* note */',
      '  user-select: none;',
      '`;',
      '',
    ].join('\n')
  );

  return root;
};

const runCli = (root: string, flags: string[]) =>
  spawnSync(
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

describe('CLI CSS options', () => {
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
      expected:
        '{display:-webkit-inline-box;display:-webkit-inline-flex;display:-ms-inline-flexbox;display:inline-flex;-webkit-mask:url(../../src/mask.svg);mask:url(../../src/mask.svg);-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;user-select:none;}\n',
    },
    {
      flags: ['--no-prefixer'],
      expected:
        '{display:flex inline;mask:url(../../src/mask.svg);user-select:none;}\n',
    },
    {
      flags: ['--keep-comments'],
      expected:
        '{display:-webkit-inline-box;display:-webkit-inline-flex;display:-ms-inline-flexbox;display:inline-flex;/* rtl:ignore */-webkit-mask:url(../../src/mask.svg);mask:url(../../src/mask.svg);/* note */-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;user-select:none;}\n',
    },
    {
      flags: ['--no-prefixer', '--keep-comments-pattern', 'rtl:'],
      expected:
        '{display:flex inline;/* rtl:ignore */mask:url(../../src/mask.svg);user-select:none;}\n',
    },
    {
      flags: ['--preprocessor', 'none'],
      expected:
        ' {\n  display: flex inline;\n  /* rtl:ignore */\n  mask: url(./mask.svg);\n  /* note */\n  user-select: none;\n}\n\n',
    },
  ])('writes CSS for flags $flags', ({ flags, expected }) => {
    const result = runCli(root, flags);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    const css = readFileSync(
      path.join(root, 'dist', 'src', 'index.css'),
      'utf8'
    );
    // The class name depends on the processor; the declarations are the subject.
    expect(css.replace(/^\.[\w-]+/, '')).toBe(expected);
  });

  it('rejects --keep-comments together with --keep-comments-pattern', () => {
    const result = runCli(root, [
      '--keep-comments',
      '--keep-comments-pattern',
      'rtl:',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('mutually exclusive');
  });
});
