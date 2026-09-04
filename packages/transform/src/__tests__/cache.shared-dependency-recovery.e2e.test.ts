import fs from 'fs';
import os from 'os';
import path from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';

const processorFile = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { promise, resolve };
};

const resolveWithExtensions = (candidate: string) => {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const withExt = `${candidate}${ext}`;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }

  return null;
};

// The shape from #422: a theme module that static preeval reads from nearly
// every component is itself a root the bundler is still processing. A cached
// component re-requested while the theme is in flight finds the theme's graph
// unknown and recovers. A recovery that cleared the whole cache evicted the
// in-flight theme too, so the theme never got a dependency snapshot, every later
// re-request found it unknown again, and the build never converged.
it('converges once the in-flight shared dependency completes', async () => {
  // The eval runner reports real paths; keep the transform side on them too.
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-shared-dep-'))
  );
  const paletteFile = path.join(root, 'palette.ts');
  const themeFile = path.join(root, 'theme.ts');

  fs.writeFileSync(paletteFile, `export const palette = { accent: 'red' };\n`);
  // A real wyw root, like the CSS-reset module in #422: it has its own tag, so
  // the bundler processes it, and its processing resolves imports.
  const themeCode = dedent`
    import { css } from 'test-css-processor';
    import { palette } from './palette';

    export const reset = 'margin: 0';
    export const themed = css\`
      color: \${palette.accent};
    \`;
  `;
  fs.writeFileSync(themeFile, themeCode);

  const componentCode = (i: number) => dedent`
    import { css } from 'test-css-processor';
    import { reset } from './theme';

    export const c${i} = css\`
      \${reset};
      color: red;
    \`;
  `;
  const components = Array.from({ length: 6 }, (_, i) => {
    const file = path.join(root, `c${i}.ts`);
    fs.writeFileSync(file, componentCode(i));
    return file;
  });

  const cache = new TransformCacheCollection();
  const themeBlocked = createDeferred();
  const unblockTheme = createDeferred();
  let didBlock = false;

  const asyncResolve = async (what: string, importer: string) => {
    if (what === 'test-css-processor') {
      return processorFile;
    }

    const resolved = resolveWithExtensions(
      path.resolve(path.dirname(importer), what)
    );
    if (!resolved) {
      throw new Error(`Unexpected resolve ${JSON.stringify(what)}`);
    }

    return resolved;
  };

  const gatedResolve = async (what: string, importer: string) => {
    // Hold the theme root in flight: it stays a published entrypoint without a
    // transform result or a dependency snapshot until released.
    if (!didBlock && importer === themeFile) {
      didBlock = true;
      themeBlocked.resolve();
      await unblockTheme.promise;
    }

    return asyncResolve(what, importer);
  };

  const run = (filename: string) =>
    transform(
      {
        cache,
        options: {
          filename,
          root,
          pluginOptions: {
            configFile: false,
            tagResolver: (source: string, tag: string) =>
              source === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
            babelOptions: {
              babelrc: false,
              configFile: false,
              presets: [
                ['@babel/preset-env', { loose: true }],
                '@babel/preset-typescript',
              ],
            },
          },
        },
      },
      fs.readFileSync(filename, 'utf8'),
      gatedResolve
    );

  try {
    const themeTransform = run(themeFile);
    await themeBlocked.promise;

    const firstPass = await Promise.all(components.map((file) => run(file)));
    firstPass.forEach((result) => {
      expect(result.cssText).toContain('margin:0');
    });

    // A cached component is requested again while the theme is still in
    // flight. Its dependency check finds the theme's graph unknown and starts
    // a recovery.
    const versionBeforeRecovery = cache.getLifecycleVersion();
    const reRequested = await run(components[0]);
    expect(reRequested.cssText).toContain('margin:0');
    expect(cache.getLifecycleVersion()).toBeGreaterThan(versionBeforeRecovery);

    // The theme's in-flight rebuild must have survived that recovery: once it
    // completes it publishes its dependency snapshot and the graph is known.
    // The bundler transforms the theme's own dependency as well; a module the
    // eval runner loaded but no loader ever published stays fail-closed.
    unblockTheme.resolve();
    const [themeResult] = await Promise.all([themeTransform, run(paletteFile)]);
    expect(themeResult.code).toContain('margin: 0');
    expect(cache.get('entrypoints', themeFile)).toBeDefined();

    const versionAfterTheme = cache.getLifecycleVersion();
    const secondPass = await Promise.all(components.map((file) => run(file)));
    secondPass.forEach((result) => {
      expect(result.cssText).toContain('margin:0');
    });
    expect(cache.getLifecycleVersion()).toBe(versionAfterTheme);

    // A change to the shared dependency is still a change for every reader.
    fs.writeFileSync(themeFile, themeCode.replace('margin: 0', 'margin: 1px'));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(themeFile, later, later);

    const afterEdit = await run(components[1]);
    expect(afterEdit.cssText).toContain('margin:1px');
    expect(afterEdit.cssText).not.toContain('margin:0');
  } finally {
    unblockTheme.resolve();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
