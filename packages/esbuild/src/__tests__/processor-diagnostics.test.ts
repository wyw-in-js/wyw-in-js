import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import * as esbuild from 'esbuild';

import wywInJS from '../index';

const processorPath = path.resolve(
  __dirname,
  '../../../transform/src/__tests__/__fixtures__/test-diagnostic-processor.js'
);

const createProject = (): string => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'wyw-esbuild-diagnostics-'))
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

describe('esbuild processor diagnostics', () => {
  let cwd: string;
  let root: string;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    cwd = process.cwd();
    root = createProject();
    process.chdir(root);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    { name: 'on the main thread', parallel: undefined },
    { name: 'in worker threads', parallel: 1 },
  ])(
    'forwards processor diagnostics as warnings $name',
    async ({ parallel }) => {
      const result = await esbuild.build({
        entryPoints: [path.join(root, 'src', 'index.js')],
        bundle: true,
        format: 'esm',
        write: false,
        outdir: path.join(root, 'dist'),
        plugins: [
          wywInJS({
            configFile: path.join(root, 'wyw-in-js.config.cjs'),
            parallel,
          }),
        ],
      });

      const css = result.outputFiles
        ?.filter((file) => file.path.endsWith('.css'))
        .map((file) => file.text)
        .join('');
      expect(css).toContain('color: red;');

      // esbuild warnings of the build and console warnings both reach the
      // user; the diagnostic has to be in one of them.
      const warnings = [
        ...result.warnings.map((warning) => warning.text),
        ...warnSpy.mock.calls.map((args) => args.join(' ')),
      ];
      expect(warnings).toContainEqual(
        expect.stringContaining(
          '[wyw-in-js] warning [dx-style/raw-color] Use a design token instead of a raw color.\n' +
            `  at ${path.join(root, 'src', 'index.js')}:2:23 (button)`
        )
      );
    },
    60_000
  );
});
