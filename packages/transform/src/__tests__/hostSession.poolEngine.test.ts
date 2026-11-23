import type {
  HostEngine,
  HostSession,
  HostSessionInput,
} from '../hostSession/types';
import { createHostEngine, createHostSession } from '../index';
import { EventEmitter } from '../utils/EventEmitter';

import type { DiskProject } from './__utils__/hostSessionConformance';
import {
  CONFORMANCE_OPTIONS,
  CONFORMANCE_TAGS,
  PROCESSORS_PACKAGE,
  createConformanceProject,
  processorsPackageJson,
  recordEngine,
} from './__utils__/hostSessionConformance';

// Worker threads start and the first evaluation spawns the eval runner.
const TIMEOUT = 60_000;

const PACKAGE_JSON = `node_modules/${PROCESSORS_PACKAGE}/package.json`;

const EXTRA_FILES: Readonly<Record<string, string>> = {
  // Uses a tag that the processors package does not declare yet.
  'fresh.js': [
    `import { fresh } from '${PROCESSORS_PACKAGE}';`,
    '',
    'export const freshStyle = fresh`color: green;`;',
    '',
  ].join('\n'),
};

let project: DiskProject;
let sessions: HostSession[];
let engines: HostEngine[];
let fallbacks: string[];

beforeEach(() => {
  project = createConformanceProject(EXTRA_FILES);
  sessions = [];
  engines = [];
  fallbacks = [];
});

afterEach(async () => {
  await Promise.all(sessions.map((session) => session.close()));
  await Promise.all(engines.map((engine) => engine.release()));
  project.remove();
});

const createPool = () => {
  const engine = createHostEngine({
    onFallback: (message) => fallbacks.push(message),
    workers: 2,
  });
  engines.push(engine);
  return engine;
};

const open = (
  engine: HostEngine,
  input: Partial<HostSessionInput<void>> = {}
) => {
  const { bundler, ...rest } = input;
  const session = createHostSession({
    bundler: {
      resolve: (request) => project.resolve(request),
      root: project.root,
      ...bundler,
    },
    engine,
    onWarning: () => {},
    options: CONFORMANCE_OPTIONS,
    ...rest,
  });
  sessions.push(session);
  return session;
};

describe('host session on the worker pool engine', () => {
  it(
    'reports each reason to stay on the calling thread once',
    async () => {
      const engine = createPool();
      const withFunction = {
        ...CONFORMANCE_OPTIONS,
        classNameSlug: (hash: string) => `fn-${hash}`,
      };
      const withLoad = {
        load: async () => undefined,
        resolve: (request: Parameters<typeof project.resolve>[0]) =>
          project.resolve(request),
        root: project.root,
      };
      const reporter = () =>
        new EventEmitter(
          () => {},
          () => 0,
          () => {}
        );
      const opened = [
        open(engine, { options: withFunction }),
        open(engine, { options: withFunction }),
        open(engine, { bundler: withLoad }),
        open(engine, { bundler: withLoad }),
        open(engine, { eventEmitter: reporter() }),
        open(engine, { eventEmitter: reporter() }),
        open(engine),
      ];

      const outputs = await Promise.all(
        opened.map((session) =>
          session.transform(project.file('identity-a.js'))
        )
      );

      outputs.forEach((output) => expect(output.css?.text).toMatch(/\S/));
      expect(fallbacks).toHaveLength(3);
      expect(new Set(fallbacks).size).toBe(3);
    },
    TIMEOUT
  );

  it(
    'runs a session with data options in the workers with one cache key',
    async () => {
      const record = recordEngine(createPool());
      const session = open(record.engine);

      const outputs = await Promise.all(
        ['runner.js', 'identity-a.js', 'identity-b.js', 'identity-c.js'].map(
          (name) => session.transform(project.file(name))
        )
      );

      outputs.forEach((output) => expect(output.css?.text).toMatch(/\S/));
      expect(fallbacks).toEqual([]);
      expect(record.salts).toHaveLength(outputs.length);
      expect(new Set(record.salts).size).toBe(1);
    },
    TIMEOUT
  );

  it(
    'picks up a new tag of a package.json after invalidate',
    async () => {
      const session = open(createPool());
      const before = await session.transform(project.file('fresh.js'));

      project.write(
        PACKAGE_JSON,
        processorsPackageJson({
          ...CONFORMANCE_TAGS,
          fresh: CONFORMANCE_TAGS.css,
        })
      );
      session.invalidate([project.path(PACKAGE_JSON)]);
      const after = await session.transform(project.file('fresh.js'));

      expect(fallbacks).toEqual([]);
      expect(before).toMatchObject({ changed: false, css: null });
      expect(after.css?.text ?? '').toContain('color:green');
    },
    TIMEOUT
  );
});
