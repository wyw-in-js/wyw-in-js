import type {
  HostEngine,
  HostOptions,
  HostOutput,
  HostResolveRequest,
  HostSession,
  HostSessionInput,
} from '../hostSession/types';
import { createHostEngine, createHostSession } from '../index';

import type { DiskProject } from './__utils__/hostSessionConformance';
import {
  CONFORMANCE_OPTIONS,
  CONFORMANCE_TAGS,
  PROCESSORS_PACKAGE,
  createConformanceProject,
  processorsPackageJson,
  readRunnerId,
  waitForProcessExit,
} from './__utils__/hostSessionConformance';

// The first evaluation spawns the eval runner.
const TIMEOUT = 60_000;

const PACKAGE_JSON = `node_modules/${PROCESSORS_PACKAGE}/package.json`;
const CONFIG_FILE = '.wyw-in-jsrc.json';

const styledWith = (exportName: string, imports: string, css: string) =>
  [
    `import { css } from '${PROCESSORS_PACKAGE}';`,
    imports,
    '',
    `export const ${exportName} = css\`${css}\`;`,
    '',
  ].join('\n');

const EXTRA_FILES: Readonly<Record<string, string>> = {
  // Uses a tag that the processors package does not declare yet.
  'fresh.js': [
    `import { fresh } from '${PROCESSORS_PACKAGE}';`,
    '',
    'export const freshStyle = fresh`color: green;`;',
    '',
  ].join('\n'),
  'held.js': styledWith(
    'held',
    "import { color } from './theme';",
    'color: ${color};'
  ),
  'glob.js': styledWith(
    'glob',
    "import { value } from './value';",
    '--value: ${value};'
  ),
  // A global of the evaluation context, set by `eval.globals` of the config.
  'value.js': 'export const value = HOST_VALUE;\n',
  'dep-a.js': "export const a = 'a';\n",
  'dep-b.js': "export const b = 'b';\n",
  'root-a.js': styledWith(
    'rootA',
    "import { a } from './dep-a';",
    '--a: ${a};'
  ),
  'root-b.js': styledWith(
    'rootB',
    "import { b } from './dep-b';",
    '--b: ${b};'
  ),
  'slug.js': styledWith('slugged', '', 'color: red;'),
  'token.js': 'export const token = Math.random().toString(36).slice(2);\n',
  'first.js': styledWith(
    'first',
    "import { token } from './token';",
    '--token: ${token};'
  ),
  'second.js': styledWith(
    'second',
    "import { token } from './token';",
    '--token: ${token};'
  ),
  'runner-again.js': styledWith(
    'runnerAgain',
    "import { pid } from './pid';",
    '--pid: ${pid};'
  ),
};

type CallContext = {
  /** Runs before the bundler resolves an import of the call. */
  beforeResolve?: (request: HostResolveRequest) => Promise<void>;
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const readVariable = (output: HostOutput, name: string) =>
  new RegExp(`--${name}:\\s*([^;]+);`).exec(output.css?.text ?? '')?.[1];

const sorted = (values: readonly string[]) => [...values].sort();

let project: DiskProject;
let sessions: HostSession<CallContext>[];
let engines: HostEngine[];

beforeEach(() => {
  project = createConformanceProject(EXTRA_FILES);
  sessions = [];
  engines = [];
});

afterEach(async () => {
  await Promise.all(sessions.map((session) => session.close()));
  await Promise.all(engines.map((engine) => engine.release()));
  project.remove();
});

const open = (input: Partial<HostSessionInput<CallContext>> = {}) => {
  const { bundler, ...rest } = input;
  const session = createHostSession<CallContext>({
    bundler: {
      resolve: async (request, context) => {
        await context.beforeResolve?.(request);
        return project.resolve(request);
      },
      root: project.root,
      ...bundler,
    },
    onWarning: () => {},
    options: CONFORMANCE_OPTIONS,
    ...rest,
  });
  sessions.push(session);
  return session;
};

const withConfigFile = (config: object): HostOptions => {
  project.write(CONFIG_FILE, `${JSON.stringify(config)}\n`);
  return { ...CONFORMANCE_OPTIONS, configFile: project.path(CONFIG_FILE) };
};

const declareFreshTag = () =>
  project.write(
    PACKAGE_JSON,
    processorsPackageJson({ ...CONFORMANCE_TAGS, fresh: CONFORMANCE_TAGS.css })
  );

describe('host session', () => {
  it(
    'picks up a new tag of a package.json after invalidate, in the same runner',
    async () => {
      const session = open();
      const runner = readRunnerId(
        await session.transform(project.file('runner.js'), {})
      );
      const before = await session.transform(project.file('fresh.js'), {});

      declareFreshTag();
      session.invalidate([project.path(PACKAGE_JSON)]);

      const after = await session.transform(project.file('fresh.js'), {});
      const runnerAfter = readRunnerId(
        await session.transform(project.file('runner-again.js'), {})
      );

      expect(before).toMatchObject({ changed: false, css: null });
      expect(after.changed).toBe(true);
      expect(after.css?.text ?? '').toContain('color:green');
      expect(runnerAfter).toBe(runner);
    },
    TIMEOUT
  );

  it(
    'applies a new tag to calls started after invalidate while a call is in flight',
    async () => {
      // The globals of the bundler put a function into the options, so the
      // cache key of the new options has to match through its function ids.
      const session = open({
        bundler: {
          globals: { HOST_FLAG: 'on' },
          resolve: async (request, context) => {
            await context.beforeResolve?.(request);
            return project.resolve(request);
          },
          root: project.root,
        },
      });
      const entered = deferred();
      const gate = deferred();
      let heldSettled = false;
      const held = session
        .transform(project.file('held.js'), {
          beforeResolve: async (request) => {
            if (request.specifier === './theme') {
              entered.resolve();
              await gate.promise;
            }
          },
        })
        .finally(() => {
          heldSettled = true;
        });
      await entered.promise;

      declareFreshTag();
      session.invalidate([project.path(PACKAGE_JSON)]);
      const fresh = await session.transform(project.file('fresh.js'), {});
      const freshSettledFirst = !heldSettled;
      gate.resolve();
      const heldOutput = await held;

      expect(freshSettledFirst).toBe(true);
      expect(fresh.css?.text ?? '').toContain('color:green');
      expect(heldOutput.css?.text ?? '').toContain('color:red');
    },
    TIMEOUT
  );

  it(
    'keeps the cache key of a call in flight when an edit changes it',
    async () => {
      const session = open({
        options: withConfigFile({ eval: { globals: { HOST_VALUE: 'one' } } }),
      });
      const entered = deferred();
      const gate = deferred();
      const nested: Promise<HostOutput>[] = [];
      const held = session.transform(project.file('held.js'), {
        beforeResolve: async (request) => {
          if (request.specifier !== './theme' || nested.length > 0) {
            return;
          }

          entered.resolve();
          await gate.promise;
          // A transform nested in the call that is still in flight.
          nested.push(session.transform(project.file('glob.js'), {}));
          await nested[0];
        },
      });
      await entered.promise;

      withConfigFile({ eval: { globals: { HOST_VALUE: 'two' } } });
      session.invalidate([project.path(CONFIG_FILE)]);
      gate.resolve();
      const heldOutput = await held;
      expect(nested).toHaveLength(1);
      const during = await nested[0];
      const after = await session.transform(project.file('glob.js'), {});

      expect(heldOutput.css?.text ?? '').toContain('color:red');
      expect(readVariable(during, 'value')).toBe('one');
      expect(readVariable(after, 'value')).toBe('two');
    },
    TIMEOUT
  );

  it(
    'returns the roots that depend on the files, and every root for global inputs',
    async () => {
      const session = open({ options: withConfigFile({}) });
      await session.transform(project.file('root-a.js'), {});
      await session.transform(project.file('root-b.js'), {});
      const roots = [project.path('root-a.js'), project.path('root-b.js')];

      expect(session.invalidate([project.path('dep-a.js')])).toEqual([
        project.path('root-a.js'),
      ]);
      expect(session.invalidate([project.path('root-b.js')])).toEqual([
        project.path('root-b.js'),
      ]);
      expect(session.invalidate([project.path('plain.js')])).toEqual([]);
      expect(sorted(session.invalidate([project.path(PACKAGE_JSON)]))).toEqual(
        sorted(roots)
      );
      expect(sorted(session.invalidate([project.path(CONFIG_FILE)]))).toEqual(
        sorted(roots)
      );
    },
    TIMEOUT
  );

  it(
    'reads the config file again after invalidate',
    async () => {
      const session = open({
        options: withConfigFile({ classNameSlug: 'first-[title]' }),
      });
      const before = await session.transform(project.file('slug.js'), {});

      withConfigFile({ classNameSlug: 'second-[title]' });
      session.invalidate([project.path(CONFIG_FILE)]);
      const after = await session.transform(project.file('slug.js'), {});

      expect(before.css?.text ?? '').toContain('.first-slugged');
      expect(after.css?.text ?? '').toContain('.second-slugged');
      expect(after.css?.text ?? '').not.toContain('first-');
    },
    TIMEOUT
  );

  it(
    'does not evaluate a module again for the next root with another context',
    async () => {
      const session = open();
      const first = await session.transform(project.file('first.js'), {
        beforeResolve: async () => {},
      });
      const second = await session.transform(project.file('second.js'), {});

      expect(readVariable(first, 'token')).toMatch(/^\w+$/);
      expect(readVariable(second, 'token')).toBe(readVariable(first, 'token'));
    },
    TIMEOUT
  );

  it(
    'shares one runner between sessions with the same runner name',
    async () => {
      const engine = createHostEngine();
      engines.push(engine);
      const sharedA = open({ engine, runner: 'shared' });
      const sharedB = open({ engine, runner: 'shared' });
      const ownA = open({ engine });
      const ownB = open({ engine });
      const runnerOf = async (session: HostSession<CallContext>) =>
        readRunnerId(await session.transform(project.file('runner.js'), {}));

      const shared = await runnerOf(sharedA);
      expect(await runnerOf(sharedB)).toBe(shared);
      const own = [await runnerOf(ownA), await runnerOf(ownB)];
      expect(new Set([shared, ...own]).size).toBe(3);

      // The shared runner lives while one session with its name is open.
      await sharedA.close();
      const again = await sharedB.transform(
        project.file('runner-again.js'),
        {}
      );
      expect(readRunnerId(again)).toBe(shared);
      await sharedB.close();
      await waitForProcessExit(shared);
    },
    TIMEOUT
  );
});
