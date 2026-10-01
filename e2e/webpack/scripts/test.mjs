import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import colors from 'picocolors';
import prettier from 'prettier';

const require = createRequire(import.meta.url);
const useRspack = process.argv.includes('--rspack');
const bundler = useRspack ? require('@rspack/core').rspack : require('webpack');
const bundlerName = useRspack ? 'Rspack' : 'Webpack';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_DIR = path.resolve(__dirname, '..');
const CSS_DEPENDENCY_LOADER = path.resolve(
  __dirname,
  'css-extra-dependency-loader.cjs'
);
const execFileAsync = promisify(execFile);

const normalizeLineEndings = (value) =>
  value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const runBuild = async (
  entry,
  { cacheDirectory, dependency, parallelLoader = false } = {}
) => {
  const outDir = path.resolve(PKG_DIR, 'dist');
  await fs.rm(outDir, { recursive: true, force: true });

  const experiments = {};
  if (useRspack && cacheDirectory) {
    experiments.cache = {
      type: 'persistent',
      storage: {
        type: 'filesystem',
        directory: cacheDirectory,
      },
    };
  }
  if (useRspack && parallelLoader) {
    experiments.parallelLoader = true;
  }

  const config = {
    mode: 'development',
    context: PKG_DIR,
    entry,
    output: {
      path: outDir,
      filename: 'bundle.js',
      clean: true,
    },
    module: {
      rules: [
        {
          test: /\.js$/,
          use: [
            {
              loader: '@wyw-in-js/webpack-loader',
              ...(parallelLoader ? { options: {}, parallel: true } : {}),
            },
          ],
        },
        {
          test: /\.wyw-in-js\.css$/,
          ...(dependency
            ? {
                use: [
                  {
                    loader: CSS_DEPENDENCY_LOADER,
                    options: { dependency },
                  },
                ],
              }
            : {}),
          type: 'asset/resource',
          generator: {
            filename: '[name][ext]',
          },
        },
      ],
    },
    resolve: {
      extensions: ['.js'],
    },
    cache: cacheDirectory
      ? useRspack
        ? true
        : {
            type: 'filesystem',
            cacheDirectory,
            buildDependencies: {
              config: [__filename, CSS_DEPENDENCY_LOADER],
            },
          }
      : false,
    ...(Object.keys(experiments).length > 0 ? { experiments } : {}),
    stats: 'errors-only',
  };

  return new Promise((resolve, reject) => {
    const compiler = bundler(config);
    compiler.run((err, stats) => {
      const buildError =
        err ??
        (stats?.hasErrors()
          ? new Error(stats.toString({ all: false, errors: true }))
          : undefined);
      const statsJson = stats?.toJson({
        all: false,
        cachedModules: true,
        modules: true,
      });

      compiler.close((closeError) => {
        const error = buildError ?? closeError;
        if (error) {
          reject(new Error(`${bundlerName} build failed`, { cause: error }));
          return;
        }
        resolve(statsJson);
      });
    });
  });
};

const readCssOutput = async () => {
  const outDir = path.resolve(PKG_DIR, 'dist');
  const entries = await fs.readdir(outDir);
  const cssFiles = entries.filter((file) => file.endsWith('.wyw-in-js.css'));

  if (cssFiles.length === 0) {
    throw new Error('No .wyw-in-js.css assets were emitted');
  }

  return (
    await Promise.all(
      cssFiles
        .sort((a, b) => a.localeCompare(b))
        .map((file) => fs.readFile(path.resolve(outDir, file), 'utf8'))
    )
  ).join('\n');
};

const assertFixture = async () => {
  const cssOutputRaw = await readCssOutput();

  const cssOutput = await prettier.format(normalizeLineEndings(cssOutputRaw), {
    parser: 'css',
  });

  const cssFixture = normalizeLineEndings(
    await fs.readFile(path.resolve(PKG_DIR, 'fixture.css'), 'utf8')
  );

  if (cssOutput !== cssFixture) {
    console.log(colors.red(`${bundlerName} output CSS:`));
    console.log(cssOutput);
    console.log(colors.red('Expected CSS:'));
    console.log(cssFixture);
    throw new Error('CSS output does not match fixture');
  }
};

const assertPosixBackslashPath = async () => {
  if (process.platform === 'win32') {
    return;
  }

  const sourcePath = path.resolve(
    PKG_DIR,
    'src',
    `back\\slash-${process.pid}.js`
  );
  await fs.writeFile(
    sourcePath,
    "import { css } from '@wyw-in-js/template-tag-syntax';\nexport const cls = css`color: rebeccapurple;`;\n"
  );

  try {
    await runBuild(sourcePath);
    const cssOutput = await readCssOutput();
    if (!cssOutput.replace(/\s/g, '').includes('color:rebeccapurple')) {
      throw new Error('CSS was not emitted for a POSIX path with a backslash');
    }
  } finally {
    await fs.rm(sourcePath, { force: true });
  }
};

const flattenModules = (modules = []) =>
  modules.flatMap((module) => [
    module,
    ...flattenModules(module.modules ?? []),
  ]);

const assertSelectiveCacheReuse = (stats) => {
  const modules = flattenModules(stats?.modules);
  const parentModules = modules.filter(
    (module) =>
      module.name === './src/index.js' || module.name === './src/alias.js'
  );
  const cssModules = modules.filter((module) =>
    module.name?.includes('.wyw-in-js.css')
  );

  if (!parentModules.some((module) => !module.built)) {
    throw new Error(
      `Expected a cached parent JS module, got ${JSON.stringify(parentModules)}`
    );
  }
  if (!cssModules.some((module) => module.built && !module.cached)) {
    throw new Error(
      `Expected a rebuilt virtual CSS module, got ${JSON.stringify(cssModules)}`
    );
  }
};

const getArg = (name) =>
  process.argv
    .find((arg) => arg.startsWith(`${name}=`))
    ?.slice(name.length + 1);

const runPersistentCacheChild = async () => {
  const cacheDirectory = getArg('--cache-directory');
  const dependency = getArg('--dependency');
  if (!cacheDirectory || !dependency) {
    throw new Error('Persistent cache child arguments are missing');
  }

  const entry = path.resolve(PKG_DIR, 'src', 'index.js');
  const stats = await runBuild(entry, { cacheDirectory, dependency });
  await assertFixture();

  if (process.argv.includes('--expect-selective-cache')) {
    assertSelectiveCacheReuse(stats);
  }
};

const assertPersistentCache = async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wyw-webpack-cache-')
  );
  const cacheDirectory = path.resolve(tempDir, 'cache');
  const dependency = path.resolve(tempDir, 'css-pipeline.config');
  const commonArgs = [
    __filename,
    ...(useRspack ? ['--rspack'] : []),
    '--persistent-cache-child',
    `--cache-directory=${cacheDirectory}`,
    `--dependency=${dependency}`,
  ];

  try {
    await fs.writeFile(dependency, 'first\n');
    await execFileAsync(process.execPath, commonArgs, { cwd: PKG_DIR });

    await fs.writeFile(dependency, 'second version\n');
    await execFileAsync(
      process.execPath,
      [...commonArgs, '--expect-selective-cache'],
      { cwd: PKG_DIR }
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

const assertRspackParallelLoader = async () => {
  if (!useRspack) return;

  const entry = path.resolve(PKG_DIR, 'src', 'index.js');
  await runBuild(entry, { parallelLoader: true });
  await assertFixture();
};

const assertWatchUpdates = async () => {
  const tempDir = await fs.mkdtemp(path.join(PKG_DIR, 'watch-'));
  const entry = path.join(tempDir, 'entry.js');
  const outputPath = path.join(tempDir, 'dist');
  const source = (color) =>
    `import { css } from '@wyw-in-js/template-tag-syntax';\nexport const title = css\`color: ${color};\`;\n`;
  await fs.writeFile(entry, source('red'));
  const compiler = bundler({
    mode: 'development',
    context: PKG_DIR,
    entry,
    devtool: false,
    output: { path: outputPath, filename: 'bundle.js' },
    cache: true,
    module: {
      rules: [
        { test: /\.js$/, use: ['@wyw-in-js/webpack-loader'] },
        {
          test: /\.wyw-in-js\.css$/,
          type: 'asset/resource',
          generator: { filename: 'styles.css' },
        },
      ],
    },
  });
  const builds = [];
  let notify;
  const watching = compiler.watch({ aggregateTimeout: 50 }, (error, stats) => {
    builds.push(
      error ??
        (stats.hasErrors()
          ? new Error(stats.toString({ all: false, errors: true }))
          : null)
    );
    notify?.();
  });
  const waitForBuild = (index) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        notify = undefined;
        reject(new Error(`${bundlerName} watch rebuild timed out`));
      }, 30000);
      notify = () => {
        if (builds.length <= index) {
          return;
        }
        clearTimeout(timer);
        notify = undefined;
        const error = builds[index];
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      notify();
    });
  const assertColor = async (color) => {
    const css = await fs.readFile(path.join(outputPath, 'styles.css'), 'utf8');
    if (!css.replace(/\s/g, '').includes(`color:${color}`)) {
      throw new Error(`${bundlerName} watch expected ${color}, emitted ${css}`);
    }
  };
  try {
    await waitForBuild(0);
    await assertColor('red');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (const color of ['teal', 'orange', 'purple']) {
      const previousBuilds = builds.length;
      const pending = waitForBuild(previousBuilds);
      await fs.writeFile(entry, source(color));
      await pending;
      await assertColor(color);
    }
  } finally {
    await new Promise((resolve, reject) =>
      watching.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      })
    );
    await new Promise((resolve, reject) =>
      compiler.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      })
    );
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

const main = async () => {
  console.log(colors.blue('Package directory:'), PKG_DIR);

  const entry = path.resolve(PKG_DIR, 'src', 'index.js');
  await runBuild(entry);
  await assertFixture();

  await assertPosixBackslashPath();
  await assertPersistentCache();
  await assertRspackParallelLoader();
  await assertWatchUpdates();
};

const run = process.argv.includes('--persistent-cache-child')
  ? runPersistentCacheChild
  : process.argv.includes('--watch-only')
  ? assertWatchUpdates
  : main;

run().then(
  () => {
    console.log(colors.green(`✅ ${bundlerName} E2E test passed`));
    process.exit(0);
  },
  (error) => {
    console.error(colors.red('Error:'), error);
    process.exit(1);
  }
);
