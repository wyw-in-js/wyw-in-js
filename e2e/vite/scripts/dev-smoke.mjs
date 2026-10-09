import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import colors from 'picocolors';
import { createServer } from 'vite';

import wyw from '@wyw-in-js/vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_DIR = path.resolve(__dirname, '..');

const assertTransformed = (result, label) => {
  if (!result?.code || typeof result.code !== 'string') {
    throw new Error(`${label} was not transformed`);
  }
};

const runBasicDevSmoke = async (pluginOptions = {}) => {
  const server = await createServer({
    configFile: false,
    root: PKG_DIR,
    logLevel: 'error',
    server: {
      middlewareMode: 'ssr',
      hmr: false,
    },
    resolve: {
      alias: {
        '@': path.resolve(PKG_DIR, 'src'),
      },
    },
    plugins: [wyw(pluginOptions)],
  });

  try {
    const resolvedIndex = await server.pluginContainer.resolveId('/index.html');
    if (!resolvedIndex) {
      throw new Error('Failed to resolve /index.html in dev mode');
    }

    const transformed = await server.transformRequest('/src/index.ts');
    assertTransformed(transformed, '/src/index.ts');
    if (!transformed.code.includes('classA')) {
      throw new Error(
        '/src/index.ts transformed code does not contain expected symbol "classA"'
      );
    }
  } finally {
    await server.close();
  }
};

const getLoadedCode = (loaded, label) => {
  const code = typeof loaded === 'string' ? loaded : loaded?.code;
  if (typeof code !== 'string') {
    throw new Error(`${label} was not loaded`);
  }

  return code;
};

const runEvalDependencyInvalidationSmoke = async (pluginOptions = {}) => {
  const fixtureDir = await fs.mkdtemp(
    path.join(PKG_DIR, '.dev-invalidation-fixture-')
  );
  const sourceDir = path.join(fixtureDir, 'src');
  const entryFile = path.join(sourceDir, 'index.ts');
  const themeFile = path.join(sourceDir, 'theme.ts');
  const cssFile = path.join(sourceDir, 'index.wyw-in-js.css');
  const entryUrl = '/src/index.ts';
  let server;
  let resolveHotUpdate;
  const hotUpdateFinished = new Promise((resolve) => {
    resolveHotUpdate = resolve;
  });
  const hmrProbe = {
    name: 'wyw-eval-invalidation-smoke-probe',
    enforce: 'post',
    handleHotUpdate(ctx) {
      if (path.resolve(ctx.file) !== themeFile) return undefined;

      const affected = [...ctx.modules];
      setImmediate(() => resolveHotUpdate(affected));
      return undefined;
    },
  };

  try {
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      entryFile,
      [
        "import { css } from '@wyw-in-js/template-tag-syntax';",
        "import { color } from './theme';",
        '',
        'export const className = css`',
        '  color: ${color};',
        '`;',
        '',
      ].join('\n')
    );
    await fs.writeFile(
      themeFile,
      "export const color = (() => '#123456')();\n"
    );
    const originalEntry = await fs.readFile(entryFile, 'utf8');

    server = await createServer({
      configFile: false,
      root: fixtureDir,
      logLevel: 'error',
      server: {
        middlewareMode: 'ssr',
        hmr: true,
        watch: { ignored: ['**/*'] },
      },
      plugins: [
        wyw({ eval: { strategy: 'execute' }, ...pluginOptions }),
        hmrProbe,
      ],
    });

    const initialTransform = await server.transformRequest(entryUrl);
    assertTransformed(initialTransform, entryUrl);
    const initialCss = getLoadedCode(
      await server.pluginContainer.load(cssFile),
      cssFile
    );
    if (!initialCss.includes('#123456') || initialCss.includes('#abcdef')) {
      throw new Error('Initial dev CSS did not contain the expected value');
    }

    await fs.writeFile(
      themeFile,
      "export const color = (() => '#abcdef')();\n"
    );
    server.watcher.emit('change', themeFile);
    let timeout;
    const affected = await Promise.race([
      hotUpdateFinished,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Timed out waiting for Vite hot update')),
          10_000
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    if (
      !affected.some(
        (module) =>
          module.file === entryFile || module.id?.split('?', 1)[0] === entryFile
      )
    ) {
      throw new Error('Changed eval dependency did not invalidate its root');
    }

    const updatedTransform = await server.transformRequest(entryUrl);
    assertTransformed(updatedTransform, entryUrl);
    const updatedCss = getLoadedCode(
      await server.pluginContainer.load(cssFile),
      cssFile
    );
    if (!updatedCss.includes('#abcdef') || updatedCss.includes('#123456')) {
      throw new Error('Updated dev CSS retained a stale dependency value');
    }
    if ((await fs.readFile(entryFile, 'utf8')) !== originalEntry) {
      throw new Error(
        'The root fixture changed during dependency invalidation'
      );
    }
  } finally {
    await server?.close();
    await fs.rm(fixtureDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
};

const main = async () => {
  await runBasicDevSmoke();
  await runEvalDependencyInvalidationSmoke();
  await runBasicDevSmoke({ parallel: 2 });
  await runEvalDependencyInvalidationSmoke({ parallel: 2 });
};

main().then(
  () => {
    console.log(colors.green('✅ Vite dev smoke passed'));
    process.exit(0);
  },
  (error) => {
    console.error(colors.red('Error:'), error);
    process.exit(1);
  }
);
