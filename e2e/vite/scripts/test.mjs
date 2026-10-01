import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import colors from 'picocolors';
import prettier from 'prettier';
import { build } from 'vite';

import wyw from '@wyw-in-js/vite';

import { assertLoadedCode } from './loaded-code.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PKG_DIR = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);

const normalizeLineEndings = (value) =>
  value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

async function exists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

const buildArtefact = async (outDir, pluginOptions) => {
  await build({
    build: {
      manifest: true,
      outDir,
      cssMinify: false,
    },
    configFile: false,
    resolve: {
      alias: {
        '@': path.resolve(PKG_DIR, 'src'),
      },
    },
    plugins: [pluginOptions ? wyw(pluginOptions) : wyw()],
  });
};

async function buildArtefactWithPlugin(root, outDir, plugin) {
  await build({
    build: {
      outDir,
      cssMinify: false,
      rollupOptions: {
        input: path.join(root, 'src', 'index.ts'),
      },
    },
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin],
    root,
  });
}

async function buildPreserveModulesArtefact(outDir, format) {
  await build({
    build: {
      outDir,
      cssCodeSplit: true,
      cssMinify: false,
      lib: {
        entry: path.resolve(PKG_DIR, 'src/preserve-modules/index.ts'),
        formats: [format],
      },
      rollupOptions: {
        output: {
          assetFileNames: '[name][extname]',
          preserveModules: true,
          preserveModulesRoot: path.resolve(PKG_DIR, 'src/preserve-modules'),
        },
      },
    },
    configFile: false,
    plugins: [wyw({ preserveCssPaths: true })],
  });
}

const getCSSFromManifest = async (outDir) => {
  const manifestPath = path.resolve(outDir, '.vite', 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

  if (!manifest['index.html']) {
    throw new Error('No index.html in manifest');
  }

  if (!manifest['index.html'].css) {
    throw new Error('No CSS in manifest');
  }

  if (manifest['index.html'].css.length !== 1) {
    throw new Error('More than one CSS in manifest');
  }

  const cssFilePath = path.resolve(outDir, manifest['index.html'].css[0]);
  const cssSnapshot = await fs.readFile(cssFilePath, 'utf-8');

  return prettier.format(cssSnapshot, {
    parser: 'css',
  });
};

async function getMetadataManifest(outDir) {
  const manifestPath = path.resolve(outDir, 'src', 'index.wyw-in-js.json');
  return JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
}

async function runReusedPluginMetadataRebuildCase() {
  const fixtureDir = await fs.mkdtemp(path.join(PKG_DIR, 'rebuild-fixture-'));
  const srcDir = path.join(fixtureDir, 'src');
  const outDir = path.join(fixtureDir, 'dist');
  const entryFilename = path.join(srcDir, 'index.ts');
  const metadataFilename = path.join(outDir, 'src', 'component.wyw-in-js.json');
  const plugin = wyw({ outputMetadata: true });

  try {
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(
      entryFilename,
      `import './component';

export const entry = 1;
`,
      'utf8'
    );
    await fs.writeFile(
      path.join(srcDir, 'component.ts'),
      `import { css } from '@wyw-in-js/template-tag-syntax';

export const className = css\`
  color: red;
\`;
`,
      'utf8'
    );

    await buildArtefactWithPlugin(fixtureDir, outDir, plugin);

    if (!(await exists(metadataFilename))) {
      throw new Error('Expected metadata sidecar after initial build');
    }

    await fs.writeFile(entryFilename, `export const entry = 2;\n`, 'utf8');
    await buildArtefactWithPlugin(fixtureDir, outDir, plugin);

    if (await exists(metadataFilename)) {
      throw new Error(
        'Expected rebuilds with a reused plugin instance to remove metadata sidecars for modules that left the graph'
      );
    }
  } finally {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
}

async function runExternalCssSideEffectCase() {
  const fixtureDir = await fs.mkdtemp(
    path.join(PKG_DIR, 'external-css-fixture-')
  );
  const srcDir = path.join(fixtureDir, 'src');
  const outDir = path.join(fixtureDir, 'dist');
  const fakePackageDir = path.join(
    fixtureDir,
    'node_modules',
    'external-css-package'
  );

  try {
    await fs.mkdir(srcDir, { recursive: true });
    await fs.mkdir(fakePackageDir, { recursive: true });
    await fs.writeFile(
      path.join(srcDir, 'index.ts'),
      [
        "import { css } from '@wyw-in-js/template-tag-syntax';",
        "import { externalColor } from 'external-css-package';",
        '',
        'export const className = css`',
        '  color: ${externalColor};',
        '`;',
        '',
      ].join('\n'),
      'utf8'
    );
    await fs.writeFile(
      path.join(fakePackageDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'external-css-package',
          version: '1.0.0',
          type: 'module',
          exports: './index.js',
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    await fs.writeFile(
      path.join(fakePackageDir, 'index.js'),
      [
        "import './styles.css';",
        '',
        "export const externalColor = globalThis.__externalColor || 'red';",
        '',
      ].join('\n'),
      'utf8'
    );
    await fs.writeFile(
      path.join(fakePackageDir, 'styles.css'),
      '.external-css-package { color: red; }\n',
      'utf8'
    );

    await buildArtefactWithPlugin(fixtureDir, outDir, wyw());
  } finally {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
}

async function runStaticPureCallCase() {
  const outDir = path.resolve(PKG_DIR, 'dist-static-pure-call');

  try {
    await fs.rm(outDir, { recursive: true, force: true });
    await build({
      build: {
        cssMinify: false,
        outDir,
        rollupOptions: {
          input: path.resolve(PKG_DIR, 'src/static-pure-call/index.ts'),
        },
      },
      configFile: false,
      logLevel: 'silent',
      plugins: [wyw({ eval: { strategy: 'static' } })],
      root: PKG_DIR,
    });

    await findFileMatching(
      outDir,
      (filePath, contents) =>
        filePath.endsWith('.css') && /padding:\s*12px/.test(contents)
    );
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
}

async function assertFileMatches(filePath, pattern) {
  const contents = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));

  if (!pattern.test(contents)) {
    throw new Error(
      `${path.relative(PKG_DIR, filePath)} does not match ${pattern}`
    );
  }
}

async function assertFileDoesNotContain(filePath, text) {
  const contents = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));

  if (contents.includes(text)) {
    throw new Error(
      `${path.relative(PKG_DIR, filePath)} unexpectedly contains ${text}`
    );
  }
}

async function listFilesRecursively(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.resolve(dirPath, entry.name);

      if (entry.isDirectory()) {
        return listFilesRecursively(entryPath);
      }

      return [entryPath];
    })
  );

  return files.flat();
}

async function findFileMatching(dirPath, predicate) {
  const files = await listFilesRecursively(dirPath);

  for (const filePath of files) {
    const contents = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));
    if (predicate(filePath, contents)) {
      return filePath;
    }
  }

  throw new Error(
    `No matching file found under ${path.relative(PKG_DIR, dirPath)}`
  );
}

async function assertCjsModuleLoads(filePath) {
  const script = `
    require.extensions['.css'] = () => {};
    const mod = require(process.argv[1]);
    if (!mod || typeof mod.rootClass !== 'string') {
      throw new Error('Missing rootClass export');
    }
    if (!mod || typeof mod.buttonClass !== 'string') {
      throw new Error('Missing buttonClass export');
    }
    if (!mod || mod.plainValue !== 'plain') {
      throw new Error('Unexpected plainValue export');
    }
  `;

  await execFileAsync(process.execPath, ['-e', script, filePath], {
    cwd: PKG_DIR,
  });
}

const main = async () => {
  console.log(colors.blue('Package directory:'), PKG_DIR);

  const outDir = path.resolve(PKG_DIR, 'dist');
  const testCases = [
    {
      name: 'default',
      fixturePath: path.resolve(PKG_DIR, 'fixture.css'),
    },
    {
      name: 'keepComments',
      fixturePath: path.resolve(PKG_DIR, 'fixture.keep-comments.css'),
      pluginOptions: { keepComments: true },
    },
    {
      name: 'outputMetadata',
      fixturePath: path.resolve(PKG_DIR, 'fixture.css'),
      pluginOptions: { outputMetadata: true },
    },
    {
      name: 'hybridResolver',
      fixturePath: path.resolve(PKG_DIR, 'fixture.css'),
      pluginOptions: { eval: { resolver: 'hybrid' } },
    },
  ];

  for (const testCase of testCases) {
    console.log(colors.blue('Running case:'), testCase.name);
    await fs.rm(outDir, { recursive: true, force: true });

    await buildArtefact(outDir, testCase.pluginOptions);

    const cssOutput = normalizeLineEndings(await getCSSFromManifest(outDir));
    const cssFixture = normalizeLineEndings(
      await fs.readFile(testCase.fixturePath, 'utf-8')
    );

    if (cssOutput !== cssFixture) {
      console.log(colors.red(`[${testCase.name}] Output CSS:`));
      console.log(cssOutput);
      console.log(colors.red(`[${testCase.name}] Expected CSS:`));
      console.log(cssFixture);

      throw new Error(`[${testCase.name}] CSS output does not match fixture`);
    }

    if (testCase.name === 'outputMetadata') {
      const metadataOutput = await getMetadataManifest(outDir);

      if (metadataOutput.version !== 1) {
        throw new Error('Expected metadata manifest version 1');
      }

      if (metadataOutput.source !== 'src/index.ts') {
        throw new Error(
          `Expected metadata source to be src/index.ts, got ${metadataOutput.source}`
        );
      }

      if (metadataOutput.cssFile !== 'src/index.wyw-in-js.css') {
        throw new Error(
          `Expected metadata cssFile to be src/index.wyw-in-js.css, got ${metadataOutput.cssFile}`
        );
      }

      if (!Array.isArray(metadataOutput.processors)) {
        throw new Error('Expected metadata processors array');
      }

      if (metadataOutput.processors.length !== 1) {
        throw new Error('Expected exactly one metadata processor');
      }

      if (typeof metadataOutput.processors[0].className !== 'string') {
        throw new Error('Expected metadata processor className');
      }

      if (!metadataOutput.rules) {
        throw new Error('Expected metadata rules');
      }
    }
  }

  console.log(colors.blue('Running case:'), 'rebuildOutputMetadata');
  await runReusedPluginMetadataRebuildCase();

  console.log(colors.blue('Running case:'), 'externalCssSideEffect');
  await runExternalCssSideEffectCase();

  console.log(colors.blue('Running case:'), 'staticPureCall');
  await runStaticPureCallCase();

  console.log(colors.blue('Running case:'), 'loadedCode');
  await assertLoadedCode(PKG_DIR);

  const preserveModulesCases = [
    {
      format: 'es',
      name: 'preserveModules-es',
      outDir: path.resolve(PKG_DIR, 'dist-preserve-modules'),
      cssEdgePattern: /import ["']\.\/index\.wyw-in-js\.css["'];/,
      nestedCssEdgePattern:
        /import ["']\.\/(?:nested\/)+button\.wyw-in-js\.css["'];/,
    },
    {
      format: 'cjs',
      name: 'preserveModules-cjs',
      outDir: path.resolve(PKG_DIR, 'dist-preserve-modules-cjs'),
      cssEdgePattern: /require\(["']\.\/index\.wyw-in-js\.css["']\);/,
      nestedCssEdgePattern:
        /require\(["']\.\/(?:nested\/)+button\.wyw-in-js\.css["']\);/,
    },
  ];

  for (const preserveModulesCase of preserveModulesCases) {
    console.log(colors.blue('Running case:'), preserveModulesCase.name);
    await fs.rm(preserveModulesCase.outDir, { recursive: true, force: true });

    await buildPreserveModulesArtefact(
      preserveModulesCase.outDir,
      preserveModulesCase.format
    );

    const rootModulePath = await findFileMatching(
      preserveModulesCase.outDir,
      (filePath, contents) =>
        /\.(?:mjs|js)$/.test(filePath) &&
        contents.includes('rootClass') &&
        contents.includes('./index.wyw-in-js.css')
    );
    const nestedModulePath = await findFileMatching(
      preserveModulesCase.outDir,
      (filePath, contents) =>
        /\.(?:mjs|js)$/.test(filePath) &&
        contents.includes('button.wyw-in-js.css')
    );
    const plainModulePath = await findFileMatching(
      preserveModulesCase.outDir,
      (filePath, contents) =>
        /\.(?:mjs|js)$/.test(filePath) &&
        contents.includes('"plain"') &&
        !contents.includes('.css')
    );

    await assertFileMatches(rootModulePath, preserveModulesCase.cssEdgePattern);
    await assertFileMatches(
      nestedModulePath,
      preserveModulesCase.nestedCssEdgePattern
    );
    await assertFileDoesNotContain(plainModulePath, '.css');
    await fs.access(
      path.resolve(preserveModulesCase.outDir, 'index.wyw-in-js.css')
    );
    await findFileMatching(preserveModulesCase.outDir, (filePath) =>
      filePath.endsWith('button.wyw-in-js.css')
    );

    if (preserveModulesCase.format === 'cjs') {
      await assertCjsModuleLoads(rootModulePath);
    }
  }
};

main().then(
  () => {
    console.log(colors.green('✅ Vite E2E test passed'));
    process.exit(0);
  },
  (error) => {
    console.error(colors.red('Error:'), error);
    process.exit(1);
  }
);
