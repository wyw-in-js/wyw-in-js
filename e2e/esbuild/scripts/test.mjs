import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import colors from 'picocolors';
import prettier from 'prettier';
import { build } from 'esbuild';

import wyw from '@wyw-in-js/esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_DIR = path.resolve(__dirname, '..');

const normalizeLineEndings = (value) =>
  value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const runBuild = async (entrypoint, strategy) => {
  const outDir = path.resolve(PKG_DIR, 'dist');
  await fs.rm(outDir, { recursive: true, force: true });

  await build({
    entryPoints: [path.resolve(PKG_DIR, entrypoint)],
    bundle: true,
    format: 'esm',
    outdir: outDir,
    write: true,
    plugins: [
      wyw({
        configFile: false,
        ...(strategy ? { eval: { strategy } } : {}),
      }),
    ],
  });
};

const runFixture = async (entrypoint, fixture, strategy) => {
  await runBuild(entrypoint, strategy);

  const outDir = path.resolve(PKG_DIR, 'dist');
  const entries = await fs.readdir(outDir);
  const cssFiles = entries.filter(
    (file) =>
      file.endsWith('.wyw.css') ||
      (file.endsWith('.css') && !file.endsWith('.css.map'))
  );

  if (cssFiles.length === 0) {
    throw new Error('No .wyw.css assets were emitted');
  }

  const cssOutputRaw = (
    await Promise.all(
      cssFiles
        .sort((a, b) => a.localeCompare(b))
        .map((file) => fs.readFile(path.resolve(outDir, file), 'utf8'))
    )
  ).join('\n');

  const cssOutput = await prettier.format(normalizeLineEndings(cssOutputRaw), {
    parser: 'css',
  });
  const cssFixture = normalizeLineEndings(
    await fs.readFile(path.resolve(PKG_DIR, fixture), 'utf8')
  );

  if (cssOutput !== cssFixture) {
    console.log(colors.red('Output CSS:'));
    console.log(cssOutput);
    console.log(colors.red('Expected CSS:'));
    console.log(cssFixture);
    throw new Error('CSS output does not match fixture');
  }
};

const main = async () => {
  console.log(colors.blue('Package directory:'), PKG_DIR);
  await runFixture('src/index.js', 'fixture.css');
  await runFixture(
    'fixtures/dangerous-controls/index.js',
    'fixtures/dangerous-controls/expected.css',
    'execute'
  );
};

main().then(
  () => {
    console.log(colors.green('✅ esbuild E2E test passed'));
    process.exit(0);
  },
  (error) => {
    console.error(colors.red('Error:'), error);
    process.exit(1);
  }
);
