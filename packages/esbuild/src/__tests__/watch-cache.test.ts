import fs from 'fs';
import os from 'os';
import path from 'path';

import * as esbuild from 'esbuild';

import wywInJS from '../index';

const getCssText = (result: esbuild.BuildResult) => {
  const css = result.outputFiles?.find((file) => file.path.endsWith('.css'));
  if (!css) {
    throw new Error(
      `Expected a CSS output file, got: ${result.outputFiles
        ?.map((f) => f.path)
        .join(', ')}`
    );
  }
  return css.text;
};

let cwd: string;
let root: string;

beforeEach(() => {
  cwd = process.cwd();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-esbuild-36-'));
  process.chdir(root);
});

// Not in the test's `finally`: after a timeout bun starts the next test while
// the test body still runs, and a late chdir would move that next test.
afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(root, { recursive: true, force: true });
});

it('does not keep stale imported objects between rebuilds when globalCache is enabled', async () => {
  const entryFile = path.join(root, 'main.ts');
  const tokensFile = path.join(root, 'tokens.ts');
  const outdir = path.join(root, 'dist');

  const processorFile = path.resolve(
    __dirname,
    '../../../transform/src/__tests__/__fixtures__/test-css-processor.js'
  );

  fs.writeFileSync(
    tokensFile,
    [`export const colors = (() => ({`, `  blue: 'blue',`, `}))();`, ``].join(
      '\n'
    )
  );

  fs.writeFileSync(
    entryFile,
    [
      `import { css } from 'test-css-processor';`,
      `import { colors } from './tokens';`,
      ``,
      `export const className = css\``,
      `  color: \${colors.blue};`,
      `\`;`,
      ``,
      `export const _usage = [className];`,
      ``,
    ].join('\n')
  );

  const plugin = wywInJS({
    configFile: false,
    // Every build starts a new eval runner, and loading DOM emulation is most
    // of its startup. This test does not need it.
    features: { globalCache: true, happyDOM: false },
    tagResolver: (source, tag) => {
      if (source === 'test-css-processor' && tag === 'css') {
        return processorFile;
      }

      return null;
    },
  });

  let build: esbuild.BuildIncremental | null = null;

  try {
    build = (await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      format: 'esm',
      write: false,
      outdir,
      incremental: true,
      plugins: [plugin],
    })) as esbuild.BuildIncremental;

    const initialCss = getCssText(build);
    expect(initialCss).toContain('blue');

    fs.writeFileSync(
      tokensFile,
      [
        `export const colors = (() => ({`,
        `  blue: 'blue',`,
        `  red: 'red',`,
        `}))();`,
        ``,
      ].join('\n')
    );

    await build.rebuild();

    fs.writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `import { colors } from './tokens';`,
        ``,
        `export const className = css\``,
        `  color: \${colors.red};`,
        `\`;`,
        ``,
        `export const _usage = [className];`,
        ``,
      ].join('\n')
    );

    const rebuilt = (await build.rebuild()) as esbuild.BuildIncremental;
    const updatedCss = getCssText(rebuilt);

    expect(updatedCss).toContain('red');
    expect(updatedCss).not.toContain('blue');
  } finally {
    build?.rebuild.dispose();
  }
});
