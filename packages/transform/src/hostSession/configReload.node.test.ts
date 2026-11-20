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

// Writes the project and the first config; defines \`open(engine)\`,
// \`transformFile(session)\` and \`write(name, content)\`.
const SETUP = `
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

const createEngine = () =>
  createHostEngine(workers === '0' ? {} : { workers: Number(workers) });
const open = (engine) =>
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
const transformFile = async (session) => nameOf(await session.transform(file));
`;

// Edits the config, then a package.json, then opens another session, and
// prints the class name of each output.
const ONE_ENGINE = `${SETUP}
const engine = createEngine();
const session = open(engine);
const names = [await transformFile(session)];
write('wyw-in-js.config.mjs', config('second'));
session.invalidate([configFile]);
names.push(await transformFile(session));
write('package.json', '{ "name": "edited" }\\n');
session.invalidate([join(root, 'package.json')]);
names.push(await transformFile(session));
const later = open(engine);
names.push(await transformFile(later));
await Promise.all([session.close(), later.close()]);
await engine.release();
console.log(JSON.stringify(names));
`;

// Two engines in one process read the same config, each session after its
// own invalidate, and print the class name of each output.
const TWO_ENGINES = `${SETUP}
const engines = [createEngine(), createEngine()];
const [first, second] = engines.map(open);
const names = [await transformFile(first)];
write('wyw-in-js.config.mjs', config('second'));
first.invalidate([configFile]);
names.push(await transformFile(first));
names.push(await transformFile(second));
write('wyw-in-js.config.mjs', config('third'));
second.invalidate([configFile]);
names.push(await transformFile(second));
first.invalidate([configFile]);
names.push(await transformFile(first));
await Promise.all([first.close(), second.close()]);
await Promise.all(engines.map((engine) => engine.release()));
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
    writeFileSync(join(scratch, 'one-engine.mjs'), ONE_ENGINE);
    writeFileSync(join(scratch, 'two-engines.mjs'), TWO_ENGINES);
  });

  afterAll(() => {
    rmSync(buildRoot, { force: true, recursive: true });
    rmSync(scratch, { force: true, recursive: true });
  });

  // Runs a scenario in its own project and returns the names it printed.
  const runScenario = (script: string, workers: string): unknown => {
    const project = join(scratch, `${script}-${workers}`);
    mkdirSync(project);
    const run = spawnSync(
      nodeBinary,
      [
        join(scratch, `${script}.mjs`),
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
    return JSON.parse(lines[lines.length - 1]);
  };

  const ENGINES = [
    { name: 'the JS engine', workers: '0' },
    { name: 'the worker pool', workers: '2' },
  ];

  it.each(ENGINES)(
    'stays edited on $name for later generations and sessions',
    ({ workers }) => {
      expect(runScenario('one-engine', workers)).toEqual([
        'first-slugged',
        'second-slugged',
        'second-slugged',
        'second-slugged',
      ]);
    },
    TIMEOUT
  );

  it.each(ENGINES)(
    'gives each of two engines on $name the edited config',
    ({ workers }) => {
      expect(runScenario('two-engines', workers)).toEqual([
        'first-slugged',
        'second-slugged',
        'second-slugged',
        'third-slugged',
        'third-slugged',
      ]);
    },
    TIMEOUT
  );
});
