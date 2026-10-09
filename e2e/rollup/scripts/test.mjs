import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import colors from 'picocolors';
import prettier from 'prettier';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';

import wyw from '@wyw-in-js/rollup';
import css from 'rollup-plugin-css-only';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_DIR = path.resolve(__dirname, '..');

const normalizeLineEndings = (value) =>
  value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const runBuild = async () => {
  const outDir = path.resolve(PKG_DIR, 'dist');
  await fs.rm(outDir, { recursive: true, force: true });

  const bundle = await rollup({
    input: path.resolve(PKG_DIR, 'src', 'index.js'),
    plugins: [nodeResolve(), wyw(), css({ output: 'styles.css' })],
  });

  await bundle.write({
    dir: outDir,
    format: 'esm',
  });

  await bundle.close();
};

const main = async () => {
  console.log(colors.blue('Package directory:'), PKG_DIR);

  await runBuild();

  const cssOutputRaw = await fs.readFile(
    path.resolve(PKG_DIR, 'dist', 'styles.css'),
    'utf8'
  );
  const cssOutput = await prettier.format(
    normalizeLineEndings(cssOutputRaw),
    {
      parser: 'css',
    }
  );
  const cssFixture = normalizeLineEndings(
    await fs.readFile(path.resolve(PKG_DIR, 'fixture.css'), 'utf8')
  );

  if (cssOutput !== cssFixture) {
    console.log(colors.red('Output CSS:'));
    console.log(cssOutput);
    console.log(colors.red('Expected CSS:'));
    console.log(cssFixture);
    throw new Error('CSS output does not match fixture');
  }

  // `src/no-css.js` produces no CSS, but Rollup must still receive its
  // transformed code: the original keeps the `css` tag, whose runtime
  // implementation in template-tag-syntax throws when it is called.
  const jsOutput = await fs.readFile(
    path.resolve(PKG_DIR, 'dist', 'index.js'),
    'utf8'
  );

  if (jsOutput.includes('color: black')) {
    console.log(colors.red('Output JS:'));
    console.log(jsOutput);
    throw new Error('JS output keeps an untransformed css tag');
  }
};

main().then(
  () => {
    console.log(colors.green('✅ Rollup E2E test passed'));
    process.exit(0);
  },
  (error) => {
    console.error(colors.red('Error:'), error);
    process.exit(1);
  }
);
