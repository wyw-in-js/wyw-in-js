import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

describe('CLI glob matches', () => {
  it('skips directories and still processes every matched file', () => {
    // The glob is relative to `cwd`, so its absolute matches use the real path;
    // keep `--source-root` on the same path (macOS tmpdir is a symlink).
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'wyw-cli-glob-dirs-'))
    );

    try {
      const sourceDir = path.join(root, 'src');
      const nestedDir = path.join(sourceDir, 'nested');
      const processorDir = path.join(
        root,
        'node_modules',
        'test-css-processor'
      );
      mkdirSync(nestedDir, { recursive: true });
      mkdirSync(processorDir, { recursive: true });

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

      // `src/*` matches this directory together with the source files.
      writeFileSync(
        path.join(nestedDir, 'ignored.js'),
        'export const ignored = true;\n'
      );
      writeFileSync(
        path.join(sourceDir, 'theme.js'),
        "const parts = ['r', 'e', 'd'];\nexport const primaryColor = parts.join('');\n"
      );
      writeFileSync(
        path.join(sourceDir, 'a.js'),
        [
          "import { css } from 'test-css-processor';",
          "import { primaryColor } from './theme';",
          '',
          'export const a = css`',
          '  color: ${primaryColor};',
          '`;',
          '',
        ].join('\n')
      );
      writeFileSync(
        path.join(sourceDir, 'b.js'),
        [
          "import { css } from 'test-css-processor';",
          '',
          'export const b = css`',
          '  color: blue;',
          '`;',
          '',
        ].join('\n')
      );

      const outDir = path.join(root, 'dist');
      const result = spawnSync(
        process.execPath,
        [
          path.resolve(__dirname, '../wyw-in-js.ts'),
          '--config',
          configFile,
          '--out-dir',
          outDir,
          '--source-root',
          root,
          '--debug',
          path.join(root, 'debug'),
          'src/*',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          // A leaked eval broker keeps the process alive until this timeout.
          timeout: 20_000,
        }
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Successfully extracted 2 CSS files.');
      // The debug reporter's onDone prints timings after the run.
      expect(result.stdout).toContain('Timings:');

      const aCss = path.join(outDir, 'src', 'a.css');
      const bCss = path.join(outDir, 'src', 'b.css');
      expect(existsSync(aCss)).toBe(true);
      expect(existsSync(bCss)).toBe(true);
      expect(readFileSync(aCss, 'utf8')).toContain('color:red');
      expect(readFileSync(bCss, 'utf8')).toContain('color:blue');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
