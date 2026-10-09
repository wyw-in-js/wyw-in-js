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

describe('CLI evaluation', () => {
  const runCli = (extraArgs: string[] = []) => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-cli-eval-'));

    try {
      const sourceDir = path.join(root, 'src');
      const processorDir = path.join(
        root,
        'node_modules',
        'test-css-processor'
      );
      const themeDir = path.join(root, 'node_modules', 'fake-theme');
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(processorDir, { recursive: true });
      mkdirSync(themeDir, { recursive: true });

      writeFileSync(
        path.join(processorDir, 'package.json'),
        JSON.stringify({
          name: 'test-css-processor',
          version: '1.0.0',
          type: 'module',
        })
      );
      writeFileSync(
        path.join(processorDir, 'index.js'),
        "export const css = (strings) => strings.join('');\n"
      );
      writeFileSync(
        path.join(themeDir, 'package.json'),
        JSON.stringify({
          name: 'fake-theme',
          version: '1.0.0',
          main: 'index.cjs',
        })
      );
      writeFileSync(
        path.join(themeDir, 'index.cjs'),
        "const parts = ['r', 'e', 'd'];\nexports.primaryColor = parts.join('');\n"
      );

      const processorPath = path.resolve(
        __dirname,
        '../../../transform/src/__tests__/__fixtures__/test-css-processor.js'
      );
      const configFile = path.join(root, 'wyw-in-js.config.cjs');
      writeFileSync(
        configFile,
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

      const entryFile = path.join(sourceDir, 'index.js');
      writeFileSync(
        entryFile,
        [
          "import { css } from 'test-css-processor';",
          "import { primaryColor } from 'fake-theme';",
          '',
          'export const className = css`',
          '  color: ${primaryColor};',
          '`;',
          '',
        ].join('\n')
      );

      const result = spawnSync(
        process.execPath,
        [
          path.resolve(__dirname, '../wyw-in-js.ts'),
          '--config',
          configFile,
          '--out-dir',
          path.join(root, 'dist'),
          '--source-root',
          root,
          ...extraArgs,
          entryFile,
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
        }
      );

      expect(result.error).toBeUndefined();
      expect(result.stderr).toContain(
        '[wyw-in-js] Runtime require() fallback during eval'
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Successfully extracted 1 CSS files.');
      expect(
        readFileSync(path.join(root, 'dist', 'src', 'index.css'), 'utf8')
      ).toContain('color:red');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('exits after evaluating imported values', () => {
    runCli();
  });

  it('extracts CSS in worker threads', () => {
    runCli(['--workers', '2']);
  });
});
