import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';

import dedent from 'dedent';
import type { EvalStrategy } from '@wyw-in-js/shared';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

// The first evaluation spawns the eval runner.
const EVAL_TEST_TIMEOUT = 30_000;

const asyncResolve = async (what: string, importer: string) => {
  if (what === 'test-css-processor') {
    return processorFile;
  }

  if (what.startsWith('.')) {
    const resolved = resolve(dirname(importer), what);
    return resolved.endsWith('.js') ? resolved : `${resolved}.js`;
  }

  const packageMain = join(dirname(importer), 'node_modules', what, 'index.js');
  return existsSync(packageMain) ? packageMain : null;
};

const runTransform = (
  root: string,
  entryFile: string,
  cache: TransformCacheCollection,
  strategy: EvalStrategy
) =>
  transform(
    {
      cache,
      options: {
        filename: entryFile,
        root,
        pluginOptions: {
          configFile: false,
          eval: { strategy },
          tagResolver: (source, tag) =>
            source === 'test-css-processor' && tag === 'css'
              ? processorFile
              : null,
        },
      },
    },
    readFileSync(entryFile, 'utf8'),
    asyncResolve
  );

const writeEntry = (filename: string, importSource: string) =>
  writeFileSync(
    filename,
    dedent`
      import { css } from 'test-css-processor';
      import { color } from '${importSource}';

      export const className = css\`
        color: ${'${color}'};
      \`;
    `
  );

/**
 * entry.js -> theme.js -> palette.js -> base.js
 *
 * `String(...)` keeps the value out of the static resolver, so under
 * `execute` and `hybrid` the color is computed by evaluating the whole chain.
 */
const writeEvalChain = (root: string) => {
  const files = {
    base: join(root, 'base.js'),
    entry: join(root, 'entry.js'),
    palette: join(root, 'palette.js'),
    theme: join(root, 'theme.js'),
  };

  writeFileSync(files.base, `export const hue = String('green');`);
  writeFileSync(
    files.palette,
    dedent`
      import { hue } from './base';

      export const accent = 'dark' + hue;
    `
  );
  writeFileSync(
    files.theme,
    dedent`
      import { accent } from './palette';

      export const color = String(accent);
    `
  );
  writeEntry(files.entry, './theme');

  return files;
};

const toResolvedDependencies = (
  result: Awaited<ReturnType<typeof transform>>
) => {
  const resolutions = new Map(
    (result.dependencyResolutions ?? []).map(({ resolved, source }) => [
      source,
      resolved,
    ])
  );

  return (result.dependencies ?? []).map(
    (dependency) =>
      resolutions.get(dependency) ??
      (isAbsolute(dependency) ? dependency : null)
  );
};

const expectEvalChainDependencies = (
  result: Awaited<ReturnType<typeof transform>>,
  files: ReturnType<typeof writeEvalChain>,
  directSource: string
) => {
  expect(result.cssText).toContain('color:darkgreen');
  // The direct import keeps its specifier and gets a resolution; modules
  // behind it are reported by absolute path, like static dependencies.
  expect(result.dependencies).toEqual([
    directSource,
    files.palette,
    files.base,
  ]);
  expect(result.dependencyResolutions).toEqual([
    { resolved: files.theme, source: directSource },
  ]);
  expect(toResolvedDependencies(result)).toEqual([
    files.theme,
    files.palette,
    files.base,
  ]);
};

describe('transform: dependencies of evaluated values', () => {
  let root: string;
  let cache: TransformCacheCollection;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'wyw-eval-deps-')));
    cache = new TransformCacheCollection();
  });

  afterEach(() => {
    disposeEvalBroker(cache);
    rmSync(root, { recursive: true, force: true });
  });

  it.each<EvalStrategy>(['execute', 'hybrid'])(
    'reports every module of an evaluated import chain under %s',
    async (strategy) => {
      const files = writeEvalChain(root);

      const result = await runTransform(root, files.entry, cache, strategy);

      expectEvalChainDependencies(result, files, './theme');
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'reports the chain for a root that reuses modules evaluated for another root',
    async () => {
      const files = writeEvalChain(root);
      const secondEntry = join(root, 'second.js');
      writeEntry(secondEntry, './theme.js');

      const first = await runTransform(root, files.entry, cache, 'execute');
      const second = await runTransform(root, secondEntry, cache, 'execute');

      expectEvalChainDependencies(first, files, './theme');
      expectEvalChainDependencies(second, files, './theme.js');
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'does not follow evaluated imports into node_modules',
    async () => {
      const packageMain = join(root, 'node_modules', 'tokens-pkg', 'index.js');
      const theme = join(root, 'theme.js');
      const entry = join(root, 'entry.js');
      mkdirSync(dirname(packageMain), { recursive: true });
      writeFileSync(
        join(dirname(packageMain), 'package.json'),
        JSON.stringify({ name: 'tokens-pkg', type: 'module' })
      );
      writeFileSync(packageMain, `export const hue = String('green');`);
      writeFileSync(
        theme,
        dedent`
          import { hue } from 'tokens-pkg';

          export const color = String(hue);
        `
      );
      writeEntry(entry, './theme');

      const result = await runTransform(root, entry, cache, 'execute');

      expect(result.cssText).toContain('color:green');
      expect(result.dependencies).toEqual(['./theme']);
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'keeps absolute dependencies of statically resolved values as they are',
    async () => {
      const tokens = join(root, 'tokens.js');
      const palette = join(root, 'palette.js');
      const entry = join(root, 'entry.js');
      writeFileSync(palette, `export const accent = 'green';`);
      writeFileSync(
        tokens,
        dedent`
        import { accent } from './palette';

        export const color = accent;
      `
      );
      writeEntry(entry, './tokens');

      const result = await runTransform(root, entry, cache, 'hybrid');

      expect(result.cssText).toContain('color:green');
      expect(result.dependencies).toEqual([tokens, palette]);
      expect(result.dependencyResolutions).toBeUndefined();
    },
    EVAL_TEST_TIMEOUT
  );
});
