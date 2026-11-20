import type { DiskProject } from '../__tests__/__utils__/hostSessionConformance';
import {
  CONFORMANCE_OPTIONS,
  PROCESSORS_PACKAGE,
  createConformanceProject,
} from '../__tests__/__utils__/hostSessionConformance';
import { createHostEngine, createHostSession } from '../index';

import type { HostBundler, HostEngine, HostOutput, HostSession } from './types';

// Worker threads start and the first evaluation spawns the eval runner.
const TIMEOUT = 60_000;

const CONDITIONS = ['browser', 'import', 'default'];

const EXTRA_FILES: Readonly<Record<string, string>> = {
  'node_modules/conditional-color/package.json': JSON.stringify({
    exports: {
      browser: './browser.js',
      default: './default.js',
    },
    name: 'conditional-color',
  }),
  'node_modules/conditional-color/browser.js': "exports.color = 'browser';\n",
  'node_modules/conditional-color/default.js': "exports.color = 'default';\n",
  'conditional.js': [
    `import { css } from '${PROCESSORS_PACKAGE}';`,
    "import { color } from 'conditional-color';",
    '',
    'export const conditional = css`color: ${color};`;',
    '',
  ].join('\n'),
  'palette.web.js': "export const color = 'web';\n",
  'palette.js': "export const color = 'plain';\n",
  'extension.js': [
    `import { css } from '${PROCESSORS_PACKAGE}';`,
    "import { color } from './palette';",
    '',
    'export const extension = css`color: ${color};`;',
    '',
  ].join('\n'),
  'global.js': [
    `import { css } from '${PROCESSORS_PACKAGE}';`,
    '',
    'export const global = css`color: ${HOST_VALUE};`;',
    '',
  ].join('\n'),
};

const colorOf = (output: HostOutput) =>
  /color:\s*([\w-]+)/.exec(output.css?.text ?? '')?.[1];

const configWith = (options: string) => `export default ${options};\n`;

type EngineCase = {
  create(fallbacks: string[]): HostEngine;
  name: string;
};

const ENGINES: EngineCase[] = [
  { create: () => createHostEngine(), name: 'the JS engine' },
  {
    create: (fallbacks) =>
      createHostEngine({
        onFallback: (message) => fallbacks.push(message),
        workers: 2,
      }),
    name: 'the worker pool',
  },
];

describe.each(ENGINES)(
  'the facts of the bundler with a config file on $name',
  (engineCase) => {
    let project: DiskProject;
    let sessions: HostSession[];
    let engine: HostEngine;
    let fallbacks: string[];

    beforeEach(() => {
      project = createConformanceProject(EXTRA_FILES);
      sessions = [];
      fallbacks = [];
      engine = engineCase.create(fallbacks);
    });

    afterEach(async () => {
      await Promise.all(sessions.map((session) => session.close()));
      await engine.release();
      project.remove();
      expect(fallbacks).toEqual([]);
    });

    const open = (
      config: string,
      bundler: Omit<HostBundler, 'resolve' | 'root'>
    ) => {
      project.write('wyw-in-js.config.mjs', configWith(config));
      const session = createHostSession({
        bundler: {
          ...bundler,
          resolve: (request) => project.resolve(request),
          root: project.root,
        },
        engine,
        onWarning: () => {},
        options: {
          ...CONFORMANCE_OPTIONS,
          configFile: project.path('wyw-in-js.config.mjs'),
          eval: { resolver: 'native' },
        },
      });
      sessions.push(session);
      return session;
    };

    it(
      'keeps the conditions of the bundler when the config file sets other Oxc options',
      async () => {
        const session = open(
          "{ oxcOptions: { parser: { sourceType: 'module' } } }",
          { conditions: CONDITIONS }
        );

        const output = await session.transform(
          project.file('conditional.js'),
          undefined
        );

        expect(colorOf(output)).toBe('browser');
      },
      TIMEOUT
    );

    it(
      'keeps the conditions that the config file sets over those of the bundler',
      async () => {
        const session = open(
          "{ oxcOptions: { resolver: { conditionNames: ['default'] } } }",
          { conditions: CONDITIONS }
        );

        const output = await session.transform(
          project.file('conditional.js'),
          undefined
        );

        expect(colorOf(output)).toBe('default');
      },
      TIMEOUT
    );

    it(
      'keeps the extensions of the bundler when the config file sets other Oxc options',
      async () => {
        const session = open(
          "{ oxcOptions: { parser: { sourceType: 'module' } } }",
          { extensions: ['.web.js', '.js'] }
        );

        const output = await session.transform(
          project.file('extension.js'),
          undefined
        );

        expect(colorOf(output)).toBe('web');
      },
      TIMEOUT
    );

    it(
      'keeps the extensions that the config file sets over those of the bundler',
      async () => {
        const session = open(
          "{ oxcOptions: { resolver: { extensions: ['.js'] } } }",
          { extensions: ['.web.js', '.js'] }
        );

        const output = await session.transform(
          project.file('extension.js'),
          undefined
        );

        expect(colorOf(output)).toBe('plain');
      },
      TIMEOUT
    );

    it(
      'passes the globals of the bundler to the overrideContext of the config file',
      async () => {
        const session = open(
          '{ overrideContext: (context) => ({ ...context, HOST_VALUE: `config-${context.HOST_FLAG}` }) }',
          { globals: { HOST_FLAG: 'yes' } }
        );

        const output = await session.transform(
          project.file('global.js'),
          undefined
        );

        expect(colorOf(output)).toBe('config-yes');
      },
      TIMEOUT
    );

    it(
      'evaluates with the globals of the bundler when no overrideContext is set',
      async () => {
        const session = open('{}', { globals: { HOST_VALUE: 'bundler' } });

        const output = await session.transform(
          project.file('global.js'),
          undefined
        );

        expect(colorOf(output)).toBe('bundler');
      },
      TIMEOUT
    );
  }
);
