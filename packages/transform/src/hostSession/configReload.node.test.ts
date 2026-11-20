import { spawnSync } from 'child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Node keeps the first evaluation of an ES module for the life of the
// process, and Bun does not: these sessions run in a Node process, on a build
// of the sources of this package.
const packageRoot = resolve(__dirname, '..', '..');
const buildScript = resolve(
  packageRoot,
  '..',
  '..',
  'scripts/build-esm-oxc.mjs'
);
const nodeBinary =
  process.env.WYW_NODE_BINARY ||
  (process.execPath.includes('bun') ? 'node' : process.execPath);
const cssProcessor = join(
  packageRoot,
  'src/__tests__/__fixtures__/test-css-processor.js'
);

const TIMEOUT = 120_000;

// Edits the config, then a package.json, then opens another session, and
// prints the class name of each output.
const SCENARIO = `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [buildIndex, root, processor, workers] = process.argv.slice(2);
const { createHostEngine, createHostSession } = await import(
  pathToFileURL(buildIndex).href
);
const write = (name, content) => {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), content);
};
const utils = createRequire(buildIndex).resolve('@wyw-in-js/processor-utils');
write(
  'node_modules/procs/css.js',
  readFileSync(processor, 'utf8').replace(
    "require('@wyw-in-js/processor-utils')",
    'require(' + JSON.stringify(utils) + ')'
  )
);
write(
  'node_modules/procs/package.json',
  JSON.stringify({
    main: 'index.js',
    name: 'procs',
    'wyw-in-js': { tags: { css: './css.js' } },
  })
);
write('node_modules/procs/index.js', 'module.exports = {};\\n');
const code = "import { css } from 'procs';\\nexport const slugged = css\`color: red;\`;\\n";
write('slug.js', code);
const config = (slug) =>
  "export default { classNameSlug: '" + slug + "-[title]' };\\n";
const configFile = join(root, 'wyw-in-js.config.mjs');
write('wyw-in-js.config.mjs', config('first'));

const engine = createHostEngine(
  workers === '0' ? {} : { workers: Number(workers) }
);
const open = () =>
  createHostSession({
    bundler: {
      resolve: async ({ importer, specifier }) => {
        try {
          return createRequire(importer).resolve(specifier);
        } catch {
          return null;
        }
      },
      root,
    },
    engine,
    onWarning: () => {},
    options: { configFile },
  });
const file = { code, filename: join(root, 'slug.js') };
const nameOf = (output) => /\\.([\\w-]+)\\s*\\{/.exec(output.css?.text ?? '')?.[1];

const session = open();
const names = [nameOf(await session.transform(file))];
write('wyw-in-js.config.mjs', config('second'));
session.invalidate([configFile]);
names.push(nameOf(await session.transform(file)));
write('package.json', '{ "name": "edited" }\\n');
session.invalidate([join(root, 'package.json')]);
names.push(nameOf(await session.transform(file)));
const later = open();
names.push(nameOf(await later.transform(file)));
await Promise.all([session.close(), later.close()]);
await engine.release();
console.log(JSON.stringify(names));
`;

describe('an edited ES module config under Node', () => {
  let buildRoot: string;
  let scratch: string;

  beforeAll(() => {
    // Under the package, so that the build resolves its dependencies.
    const cacheDir = join(packageRoot, 'node_modules', '.cache');
    mkdirSync(cacheDir, { recursive: true });
    buildRoot = mkdtempSync(join(cacheDir, 'wyw-host-session-node-'));
    const build = spawnSync(
      nodeBinary,
      [buildScript, '--out-dir', join(buildRoot, 'esm')],
      { cwd: packageRoot, encoding: 'utf8' }
    );
    if (build.status !== 0) {
      throw new Error(`build failed\n${build.stdout}\n${build.stderr}`);
    }
    writeFileSync(join(buildRoot, 'package.json'), '{ "type": "module" }\n');

    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wyw-host-session-')));
    writeFileSync(join(scratch, 'scenario.mjs'), SCENARIO);
  });

  afterAll(() => {
    rmSync(buildRoot, { force: true, recursive: true });
    rmSync(scratch, { force: true, recursive: true });
  });

  it.each([
    { name: 'the JS engine', workers: '0' },
    { name: 'the worker pool', workers: '2' },
  ])(
    'stays edited on $name for later generations and sessions',
    ({ workers }) => {
      const project = join(scratch, `project-${workers}`);
      mkdirSync(project);
      const run = spawnSync(
        nodeBinary,
        [
          join(scratch, 'scenario.mjs'),
          join(buildRoot, 'esm', 'index.js'),
          project,
          cssProcessor,
          workers,
        ],
        { encoding: 'utf8', timeout: TIMEOUT }
      );
      if (run.status !== 0) {
        throw new Error(`scenario failed\n${run.stdout}\n${run.stderr}`);
      }

      const lines = run.stdout.trim().split('\n');
      expect(JSON.parse(lines[lines.length - 1])).toEqual([
        'first-slugged',
        'second-slugged',
        'second-slugged',
        'second-slugged',
      ]);
    },
    TIMEOUT
  );
});
