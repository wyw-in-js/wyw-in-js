import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const cliPath = path.resolve(__dirname, '../wyw-in-js.ts');
const processorPath = path.resolve(
  __dirname,
  '../../../transform/src/__tests__/__fixtures__/test-css-processor.js'
);

const createProject = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'wyw-cli-config-metadata-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });

  writeFileSync(
    path.join(root, 'wyw-in-js.config.cjs'),
    [
      'module.exports = {',
      '  outputMetadata: true,',
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

describe('CLI outputMetadata from the config file', () => {
  let root: string;

  beforeEach(() => {
    root = createProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['on the main thread', [] as string[]],
    ['in a worker thread', ['--workers', '1']],
  ])('writes metadata without --output-metadata %s', (_name, flags) => {
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
    expect(existsSync(path.join(root, 'dist', 'src', 'index.css'))).toBe(true);
    expect(
      existsSync(path.join(root, 'dist', 'src', 'index.wyw-in-js.json'))
    ).toBe(true);
  });
});
