import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import type { RawSourceMap } from 'source-map';

import type {
  EngineSession,
  HostEngine,
  HostFile,
  HostLoadRequest,
  HostOptions,
  HostOutput,
  HostResolveRequest,
  HostSession,
} from '../../hostSession/types';
import { createHostSession, HostSessionClosedError } from '../../index';

/* ------------------------------------------------------------------------ */
/* The project the suite transforms                                          */
/* ------------------------------------------------------------------------ */

export const PROCESSORS_PACKAGE = 'conformance-processors';

const fixture = (name: string) => join(__dirname, '..', '__fixtures__', name);

/** Tags of the processors package, mapped to the processor fixtures. */
export const CONFORMANCE_TAGS: Readonly<Record<string, string>> = {
  // Extracts no rules: the file has processors and an empty `cssText`.
  blank: fixture('test-processor-options-processor.js'),
  // Reports a diagnostic with severity `error`.
  blocked: fixture('test-error-diagnostic-processor.js'),
  css: fixture('test-css-processor.js'),
  // Builds in preeval and skips in collect: changed code without metadata.
  late: fixture('test-skip-in-collect-processor.js'),
  // Reports a diagnostic with severity `warning`.
  warned: fixture('test-diagnostic-processor.js'),
};

export const processorsPackageJson = (
  tags: Readonly<Record<string, string>>
): string =>
  `${JSON.stringify(
    { name: PROCESSORS_PACKAGE, main: 'index.js', 'wyw-in-js': { tags } },
    null,
    2
  )}\n`;

const styledWithColor = (exportName: string) =>
  [
    `import { css } from '${PROCESSORS_PACKAGE}';`,
    "import { color } from './theme';",
    '',
    `export const ${exportName} = css\`color: \${color};\`;`,
    '',
  ].join('\n');

// The evaluated `pid` is the process id of the eval runner: the suite reads it
// from the CSS to tell whether the runner is still alive.
const styledWithPid = (exportName: string) =>
  [
    `import { css } from '${PROCESSORS_PACKAGE}';`,
    "import { pid } from './pid';",
    '',
    `export const ${exportName} = css\`--pid: \${pid};\`;`,
    '',
  ].join('\n');

/** The files of the project, by their path relative to its root. */
export const CONFORMANCE_SOURCES: Readonly<Record<string, string>> = {
  'pid.js': "export const pid = require('process').pid;\n",
  'theme.js': "export const color = 'red';\n",
  'runner.js': styledWithPid('runner'),
  'identity-a.js': styledWithColor('identityA'),
  'identity-b.js': styledWithColor('identityB'),
  'identity-c.js': styledWithColor('identityC'),
  // Files with `features.globalCache` turned off by the project options.
  'no-cache-runner.js': styledWithPid('runner'),
  'no-cache-identity-a.js': styledWithColor('identityA'),
  'no-cache-identity-b.js': styledWithColor('identityB'),
  'no-cache-identity-c.js': styledWithColor('identityC'),
  'empty-css.js': [
    `import { blank } from '${PROCESSORS_PACKAGE}';`,
    '',
    'export const empty = blank``;',
    '',
  ].join('\n'),
  'plain.js': 'export const answer = 42;\n',
  'late-no-metadata.js': [
    `import { late } from '${PROCESSORS_PACKAGE}';`,
    "import { color } from './theme';",
    '',
    'export const lateStyle = late`color: ${color};`;',
    '',
  ].join('\n'),
  // One module under two specifiers, and a dynamic import of a module that
  // does not exist: the runner reports the import with a warning, and nothing
  // resolves it.
  'unresolved.js': [
    `import { css } from '${PROCESSORS_PACKAGE}';`,
    "import { color } from './theme';",
    "import { color as sameColor } from './theme.js';",
    '',
    "const value = (import('./missing-module.js').catch(() => null), color + sameColor);",
    '',
    'export const unresolved = css`color: ${value};`;',
    '',
  ].join('\n'),
  'diagnostics.js': [
    `import { blocked, warned } from '${PROCESSORS_PACKAGE}';`,
    "import { color } from './theme';",
    '',
    "const value = (import('./missing-module.js').catch(() => null), color);",
    '',
    'export const warnedStyle = warned`color: ${value};`;',
    'export const blockedStyle = blocked`color: blue;`;',
    '',
  ].join('\n'),
};

/** Options of every session of the suite: data only, so no engine falls back. */
export const CONFORMANCE_OPTIONS: HostOptions = {
  configFile: false,
  features: { globalCache: ['**/*', '!**/no-cache-*.js'] },
};

export type ConformanceProject = {
  file(name: string): HostFile;
  options: HostOptions;
  path(name: string): string;
  /** Resolves as the bundler of the project does. `null` is a miss. */
  resolve(request: HostResolveRequest): Promise<string | null>;
  root: string;
};

export type DiskProject = ConformanceProject & {
  remove(): void;
  write(name: string, content: string): void;
};

/**
 * Writes the suite's files, the processors package and `extraFiles` into a
 * temporary directory. Imports resolve with Node's resolution next to the
 * importer.
 */
export const createConformanceProject = (
  extraFiles: Readonly<Record<string, string>> = {},
  options: HostOptions = CONFORMANCE_OPTIONS
): DiskProject => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wyw-host-session-')));
  const path = (name: string) => join(root, name);
  const write = (name: string, content: string) => {
    mkdirSync(dirname(path(name)), { recursive: true });
    writeFileSync(path(name), content);
  };

  write(
    `node_modules/${PROCESSORS_PACKAGE}/package.json`,
    processorsPackageJson(CONFORMANCE_TAGS)
  );
  write(
    `node_modules/${PROCESSORS_PACKAGE}/index.js`,
    'module.exports = {};\n'
  );
  Object.entries({ ...CONFORMANCE_SOURCES, ...extraFiles }).forEach(
    ([name, content]) => write(name, content)
  );

  return {
    file: (name) => ({
      code: readFileSync(path(name), 'utf8'),
      filename: path(name),
    }),
    options,
    path,
    remove: () => rmSync(root, { force: true, recursive: true }),
    resolve: async ({ importer, specifier }) => {
      try {
        return createRequire(importer).resolve(specifier);
      } catch {
        return null;
      }
    },
    root,
    write,
  };
};

/* ------------------------------------------------------------------------ */
/* Observing an engine through the seam                                      */
/* ------------------------------------------------------------------------ */

export type EngineRecord = {
  /** Keys of the engine sessions closed, in order. */
  closed: string[];
  engine: HostEngine;
  /** How many times `release()` was called. */
  releases: number;
  /** The evaluation cache key of every call, in the order calls settled. */
  salts: string[];
};

/** Wraps an engine to record what passes the engine seam. */
export const recordEngine = (inner: HostEngine): EngineRecord => {
  const record: EngineRecord = {
    closed: [],
    engine: {
      open(scope, host): EngineSession {
        const session = inner.open(scope, host);
        return {
          close: async () => {
            record.closed.push(session.key);
            await session.close();
          },
          invalidate: (files, extent) => session.invalidate(files, extent),
          get key() {
            return session.key;
          },
          transform: async (callId, file) => {
            const result = await session.transform(callId, file);
            record.salts.push(result.salt);
            return result;
          },
        };
      },
      release: async () => {
        record.releases += 1;
        await inner.release();
      },
    },
    releases: 0,
    salts: [],
  };

  return record;
};

/** The id of the eval runner that a file of `styledWithPid` reports. */
export const readRunnerId = (output: HostOutput): string => {
  const match = /--pid:\s*([^;]+);/.exec(output.css?.text ?? '');
  if (!match) {
    throw new Error(`No runner id in ${JSON.stringify(output.css?.text)}`);
  }

  return match[1].trim();
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

/** Resolves when the process is gone; rejects after `timeout` ms. */
export const waitForProcessExit = async (
  id: string,
  timeout = 10_000
): Promise<void> => {
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Not a process id: ${id}`);
  }

  const startedAt = Date.now();
  while (isProcessAlive(pid)) {
    if (Date.now() - startedAt > timeout) {
      throw new Error(`The eval runner ${pid} is still alive`);
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
};

/** A source map of a file that maps its first column to itself. */
export const identitySourceMap = (file: HostFile): RawSourceMap => ({
  file: file.filename,
  mappings: 'AAAA',
  names: [],
  sources: [file.filename],
  sourcesContent: [file.code],
  version: 3,
});

/* ------------------------------------------------------------------------ */
/* The suite                                                                 */
/* ------------------------------------------------------------------------ */

export type ConformanceTarget = {
  /** A new engine for one check; the suite releases it at the end. */
  createEngine(): HostEngine;
  /**
   * Checks of the fixtures themselves on bare `transform()`, for engines that
   * run the real pipeline: that a fixture reaches the case it stands for.
   */
  preconditions?: {
    /** `cssText === ''`; returns nothing. */
    emptyCss(file: HostFile): Promise<void>;
    /** No `cssText`, changed code, and the late branch without metadata. */
    lateNoMetadata(file: HostFile): Promise<void>;
  };
  project: ConformanceProject;
  /** Resolves when the runner with this id is gone, rejects otherwise. */
  waitForRunnerExit(id: string): Promise<void>;
};

/** What reaches the callbacks of the bundler: fresh closures on every call. */
type CallContext = {
  load: (request: HostLoadRequest) => Promise<string | undefined>;
  resolve: (request: HostResolveRequest) => Promise<string | null>;
};

const TIMEOUT = 60_000;

const MODES = [
  { name: 'with the cache of the session', prefix: '' },
  { name: 'with features.globalCache=false', prefix: 'no-cache-' },
] as const;

/**
 * One set of checks for any engine behind the session seam: the identity of
 * calls, nested calls, disposal and the projection of results.
 */
export const describeHostSessionConformance = (
  title: string,
  getTarget: () => ConformanceTarget
): void => {
  describe(`host session conformance: ${title}`, () => {
    let target: ConformanceTarget;
    let records: EngineRecord[] = [];
    let sessions: HostSession<CallContext>[] = [];

    beforeEach(() => {
      target = getTarget();
      records = [];
      sessions = [];
    });

    afterEach(async () => {
      await Promise.all(sessions.map((session) => session.close()));
      await Promise.all(records.map(({ engine }) => engine.release()));
    });

    const callContext = (
      overrides: Partial<CallContext> = {}
    ): CallContext => ({
      load: async () => undefined,
      resolve: (request) => target.project.resolve(request),
      ...overrides,
    });

    const open = ({ load = false } = {}) => {
      const record = recordEngine(target.createEngine());
      records.push(record);
      const session = createHostSession<CallContext>({
        bundler: {
          ...(load
            ? {
                load: (request: HostLoadRequest, context: CallContext) =>
                  context.load(request),
              }
            : {}),
          resolve: (request, context) => context.resolve(request),
          root: target.project.root,
        },
        engine: record.engine,
        // Warnings of a call arrive in its output.
        onWarning: () => {},
        options: target.project.options,
      });
      sessions.push(session);

      return { record, session };
    };

    const file = (name: string) => target.project.file(name);

    MODES.forEach(({ name: mode, prefix }) =>
      describe(mode, () => {
        it(
          'keeps one evaluation cache key across files, contexts and callbacks',
          async () => {
            const { record, session } = open();
            const names = [
              'runner.js',
              'identity-a.js',
              'identity-b.js',
              'identity-c.js',
              'identity-a.js',
            ];

            const outputs = await names.reduce<Promise<HostOutput[]>>(
              async (previous, name) => [
                ...(await previous),
                await session.transform(
                  file(`${prefix}${name}`),
                  callContext()
                ),
              ],
              Promise.resolve([])
            );

            outputs.forEach((output) => {
              expect(output.changed).toBe(true);
              expect(output.css?.text).toMatch(/\S/);
            });
            expect(record.salts).toHaveLength(names.length);
            expect(new Set(record.salts).size).toBe(1);
          },
          TIMEOUT
        );

        it(
          'closes the engine session and its runner once, then rejects calls',
          async () => {
            const { record, session } = open();
            const output = await session.transform(
              file(`${prefix}runner.js`),
              callContext()
            );
            const runner = readRunnerId(output);

            await session.close();
            await session.close();

            expect(record.closed).toHaveLength(1);
            await target.waitForRunnerExit(runner);

            const rejection = session
              .transform(file(`${prefix}identity-a.js`), callContext())
              .then(
                () => null,
                (error: unknown) => error
              );
            const error = await rejection;
            expect(error).toBeInstanceOf(HostSessionClosedError);
            expect(error).toMatchObject({ code: 'WYW_HOST_SESSION_CLOSED' });
          },
          TIMEOUT
        );

        it(
          'stops the runners on release() and keeps the session usable',
          async () => {
            const { record, session } = open();
            const output = await session.transform(
              file(`${prefix}runner.js`),
              callContext()
            );
            const runner = readRunnerId(output);

            await record.engine.release();

            expect(record.releases).toBe(1);
            await target.waitForRunnerExit(runner);

            const next = await session.transform(
              file(`${prefix}identity-b.js`),
              callContext()
            );
            expect(next.css?.text).toMatch(/\S/);
          },
          TIMEOUT
        );
      })
    );

    it(
      'completes a transform nested in resolve with the same cache key',
      async () => {
        const { record, session } = open();
        const nested: Promise<HostOutput>[] = [];
        const outer = await session.transform(
          file('runner.js'),
          callContext({
            resolve: async (request) => {
              if (nested.length === 0) {
                nested.push(
                  session.transform(file('identity-b.js'), callContext())
                );
                await nested[0];
              }

              return target.project.resolve(request);
            },
          })
        );

        expect(nested).toHaveLength(1);
        const inner = await nested[0];
        expect(outer.css?.text).toMatch(/\S/);
        expect(inner.css?.text).toMatch(/\S/);
        expect(new Set(record.salts).size).toBe(1);
      },
      TIMEOUT
    );

    it(
      'completes a transform nested in load with the same cache key',
      async () => {
        const { record, session } = open({ load: true });
        const nested: Promise<HostOutput>[] = [];
        const outer = await session.transform(
          file('runner.js'),
          callContext({
            load: async () => {
              if (nested.length === 0) {
                nested.push(
                  session.transform(file('identity-c.js'), callContext())
                );
                await nested[0];
              }

              return undefined;
            },
          })
        );

        expect(nested).toHaveLength(1);
        const inner = await nested[0];
        expect(outer.css?.text).toMatch(/\S/);
        expect(inner.css?.text).toMatch(/\S/);
        expect(new Set(record.salts).size).toBe(1);
      },
      TIMEOUT
    );

    it(
      'returns the transformed code and no CSS for an empty stylesheet',
      async () => {
        const input = file('empty-css.js');
        await target.preconditions?.emptyCss(input);
        const { session } = open();

        const output = await session.transform(input, callContext());

        expect(output.changed).toBe(true);
        expect(output.css).toBeNull();
        expect(output.code).toMatch(/^export const empty = "\w+";$/m);
        expect(output.code).not.toContain('blank`');
      },
      TIMEOUT
    );

    it(
      'hands the input back for a file without processors',
      async () => {
        const plain = file('plain.js');
        const input: HostFile = {
          ...plain,
          inputSourceMap: identitySourceMap(plain),
        };
        const { session } = open();

        const output = await session.transform(input, callContext());

        expect(output).toMatchObject({
          changed: false,
          code: plain.code,
          css: null,
          map: identitySourceMap(plain),
        });
      },
      TIMEOUT
    );

    it(
      'hands the input back for a result without CSS metadata',
      async () => {
        const late = file('late-no-metadata.js');
        const input: HostFile = {
          ...late,
          inputSourceMap: identitySourceMap(late),
        };
        await target.preconditions?.lateNoMetadata(input);
        const { session } = open();

        const output = await session.transform(input, callContext());

        expect(output).toMatchObject({
          changed: false,
          code: late.code,
          css: null,
          map: identitySourceMap(late),
        });
      },
      TIMEOUT
    );

    it(
      'lists each resolved dependency once and keeps unresolved ones apart',
      async () => {
        const { session } = open();

        const output = await session.transform(
          file('unresolved.js'),
          callContext()
        );

        expect(output.dependencies).toEqual([target.project.path('theme.js')]);
        expect(output.unresolved).toEqual(['./missing-module.js']);
      },
      TIMEOUT
    );

    it(
      'reports diagnostics of every severity and pipeline warnings',
      async () => {
        const { session } = open();

        const output = await session.transform(
          file('diagnostics.js'),
          callContext()
        );

        expect(output.css?.text).toMatch(/\S/);
        expect(output.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              message: 'Use a design token instead of a raw color.',
              severity: 'warning',
              source: 'processor',
            }),
            expect.objectContaining({
              category: 'test/blocking-rule',
              message: 'This rule blocks the build.',
              severity: 'error',
              source: 'processor',
            }),
            expect.objectContaining({
              message: expect.stringContaining('./missing-module.js'),
              severity: 'warning',
              source: 'pipeline',
            }),
          ])
        );
      },
      TIMEOUT
    );
  });
};
