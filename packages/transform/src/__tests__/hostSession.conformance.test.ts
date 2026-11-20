import { dirname, join } from 'path';

import { TransformCacheCollection } from '../cache';
import {
  registerPipelineTelemetryReporter,
  type PipelineTelemetrySummary,
} from '../debug/pipelineTelemetry';
import type { HostEngine, HostFile } from '../hostSession/types';
import { createHostEngine, disposeEvalBroker } from '../index';
import { transform } from '../transform';
import type { PartialOptions } from '../transform/helpers/loadWywOptions';
import type { Result } from '../types';
import { EventEmitter } from '../utils/EventEmitter';

import type { FakeEntry, FakeHostEngine } from './__utils__/fakeHostEngine';
import { createFakeHostEngine } from './__utils__/fakeHostEngine';
import type {
  ConformanceProject,
  ConformanceTarget,
  DiskProject,
} from './__utils__/hostSessionConformance';
import {
  CONFORMANCE_OPTIONS,
  CONFORMANCE_SOURCES,
  createConformanceProject,
  describeHostSessionConformance,
  waitForProcessExit,
} from './__utils__/hostSessionConformance';

/* ------------------------------------------------------------------------ */
/* The fake engine: the session alone, with results from a table             */
/* ------------------------------------------------------------------------ */

const FAKE_ROOT = '/fake-project';

const fakeProject: ConformanceProject = {
  file: (name) => ({
    code: CONFORMANCE_SOURCES[name],
    filename: join(FAKE_ROOT, name),
  }),
  options: CONFORMANCE_OPTIONS,
  path: (name) => join(FAKE_ROOT, name),
  resolve: async ({ importer, specifier }) => {
    if (!specifier.startsWith('.')) {
      return null;
    }

    const resolved = join(dirname(importer), specifier);
    const withExtension = resolved.endsWith('.js')
      ? resolved
      : `${resolved}.js`;
    const name = withExtension.slice(FAKE_ROOT.length + 1);
    return name in CONFORMANCE_SOURCES ? withExtension : null;
  },
  root: FAKE_ROOT,
};

const DYNAMIC_IMPORT_WARNING =
  '[wyw-in-js] Dynamic import executed during eval: ./missing-module.js';

const styled = (
  exportName: string,
  dependency: string,
  css: (runner: string) => string
): FakeEntry => ({
  imports: [dependency],
  result: (runner) => ({
    code: `export const ${exportName} = "${exportName}";\n`,
    cssText: css(runner),
    dependencies: [dependency],
  }),
});

// The answers mirror what the pipeline gives for the same files.
const fakeTable = (): Record<string, FakeEntry> => {
  const { path } = fakeProject;
  const entries: Record<string, FakeEntry> = {
    'runner.js': styled(
      'runner',
      './pid',
      (runner) => `.r{--pid:${runner};}\n`
    ),
    'identity-a.js': styled('identityA', './theme', () => '.a{color:red;}\n'),
    'identity-b.js': styled('identityB', './theme', () => '.b{color:red;}\n'),
    'identity-c.js': styled('identityC', './theme', () => '.c{color:red;}\n'),
    'empty-css.js': {
      result: () => ({ code: 'export const empty = "e1";\n', cssText: '' }),
    },
    'plain.js': {
      result: () => ({ code: CONFORMANCE_SOURCES['plain.js'] }),
    },
    'late-no-metadata.js': {
      imports: ['./theme'],
      result: () => ({
        code: [
          "import { late } from 'conformance-processors';",
          "import { color } from './theme';",
          'const _exp = () => (color);',
          'export const lateStyle = late`color: ${_exp()};`;',
        ].join('\n'),
        sourceMap: null,
      }),
    },
    'unresolved.js': {
      imports: ['./theme', './theme.js', './missing-module.js'],
      result: () => ({
        code: 'export const unresolved = "u1";\n',
        cssText: '.u1{color:redred;}\n',
        dependencies: ['./missing-module.js', './theme', './theme.js'],
        dependencyResolutions: [
          { resolved: path('theme.js'), source: './theme' },
          { resolved: path('theme.js'), source: './theme.js' },
        ],
      }),
      warnings: [DYNAMIC_IMPORT_WARNING],
    },
    'diagnostics.js': {
      imports: ['./theme', './missing-module.js'],
      result: () => ({
        code: 'export const warnedStyle = "w1";\nexport const blockedStyle = "b1";\n',
        cssText: '.w1{color:red;}\n.b1{color:blue;}\n',
        dependencies: ['./missing-module.js', './theme'],
        dependencyResolutions: [
          { resolved: path('theme.js'), source: './theme' },
        ],
        diagnostics: [
          {
            category: 'test/raw-color',
            className: 'w1',
            displayName: 'warnedStyle',
            end: null,
            filename: path('diagnostics.js'),
            message: 'Use a design token instead of a raw color.',
            severity: 'warning',
            start: null,
          },
          {
            category: 'test/blocking-rule',
            className: 'b1',
            displayName: 'blockedStyle',
            end: null,
            filename: path('diagnostics.js'),
            message: 'This rule blocks the build.',
            severity: 'error',
            start: null,
          },
        ],
      }),
      warnings: [DYNAMIC_IMPORT_WARNING],
    },
  };

  ['runner.js', 'identity-a.js', 'identity-b.js', 'identity-c.js'].forEach(
    (name) => {
      entries[`no-cache-${name}`] = { ...entries[name], ownRunner: true };
    }
  );

  return Object.fromEntries(
    Object.entries(entries).map(([name, entry]) => [path(name), entry])
  );
};

const fakeEngines: FakeHostEngine[] = [];

describeHostSessionConformance('fake engine', () => ({
  createEngine: () => {
    const engine = createFakeHostEngine(fakeTable(), {
      name: `fake-${fakeEngines.length + 1}`,
    });
    fakeEngines.push(engine);
    return engine;
  },
  project: fakeProject,
  waitForRunnerExit: async (id) => {
    if (fakeEngines.some((engine) => engine.isRunnerAlive(id))) {
      throw new Error(`The fake runner ${id} is still alive`);
    }
  },
}));

/* ------------------------------------------------------------------------ */
/* Real engines on a project on disk                                         */
/* ------------------------------------------------------------------------ */

let project: DiskProject;

beforeAll(() => {
  project = createConformanceProject();
});

afterAll(() => {
  project.remove();
});

const transformBare = async (
  input: HostFile,
  eventEmitter?: EventEmitter
): Promise<Result> => {
  const cache = new TransformCacheCollection();
  try {
    return await transform(
      {
        cache,
        ...(eventEmitter ? { eventEmitter } : {}),
        options: {
          filename: input.filename,
          inputSourceMap: input.inputSourceMap ?? undefined,
          pluginOptions: project.options as PartialOptions,
          root: project.root,
        },
      },
      input.code,
      (specifier, importer, stack) =>
        project.resolve({ importer, specifier, stack })
    );
  } finally {
    disposeEvalBroker(cache);
  }
};

const preconditions: ConformanceTarget['preconditions'] = {
  emptyCss: async (input) => {
    const result = await transformBare(input);

    expect(result.cssText).toBe('');
  },
  lateNoMetadata: async (input) => {
    const emitter = new EventEmitter(
      () => {},
      () => 0,
      () => {}
    );
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );

    try {
      const result = await transformBare(input, emitter);

      expect(result.cssText).toBeUndefined();
      expect(result.code).not.toBe(input.code);
      expect(
        summaries.flatMap((summary) => summary.lateNoMetadata.events)
      ).toContainEqual(
        expect.objectContaining({
          filename: input.filename,
          phase: 'collect',
        })
      );
    } finally {
      unregister();
    }
  },
};

const realTarget =
  (createEngine: () => HostEngine) => (): ConformanceTarget => ({
    createEngine,
    preconditions,
    project,
    waitForRunnerExit: (id) => waitForProcessExit(id),
  });

describeHostSessionConformance(
  'in-process engine',
  realTarget(() => createHostEngine())
);

describeHostSessionConformance(
  'worker pool engine',
  realTarget(() => createHostEngine({ workers: 2 }))
);
