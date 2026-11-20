import { readdirSync } from 'fs';
import { dirname } from 'path';

import type { DiskProject } from '../__tests__/__utils__/hostSessionConformance';
import {
  CONFORMANCE_OPTIONS,
  PROCESSORS_PACKAGE,
  createConformanceProject,
} from '../__tests__/__utils__/hostSessionConformance';
import { createHostEngine, createHostSession } from '../index';

import type { HostEngine, HostOutput, HostSession } from './types';

// Worker threads start and the first evaluation spawns the eval runner.
const TIMEOUT = 60_000;

const EXTRA_FILES: Readonly<Record<string, string>> = {
  'slug.js': [
    `import { css } from '${PROCESSORS_PACKAGE}';`,
    '',
    'export const slugged = css`color: red;`;',
    '',
  ].join('\n'),
};

const classNameOf = (output: HostOutput) =>
  /\.([\w-]+)\s*\{/.exec(output.css?.text ?? '')?.[1];

const esmConfig = (slug: string) =>
  `export default { classNameSlug: '${slug}-[title]' };\n`;

const throwingConfig = (message: string) =>
  `throw new Error('${message}');\nexport default {};\n`;

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

describe.each(ENGINES)('a changed config file on $name', (engineCase) => {
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
    // The config is read in place: nothing is written next to it.
    const leftovers = readdirSync(project.root, { recursive: true })
      .map(String)
      .filter((name) => name.includes('.reload-'));
    project.remove();
    expect(leftovers).toEqual([]);
    expect(fallbacks).toEqual([]);
  });

  const open = (configName: string) => {
    const session = createHostSession({
      bundler: {
        resolve: (request) => project.resolve(request),
        root: project.root,
      },
      engine,
      onWarning: () => {},
      options: { ...CONFORMANCE_OPTIONS, configFile: project.path(configName) },
    });
    sessions.push(session);
    return session;
  };

  const transformSlug = (session: HostSession) =>
    session.transform(project.file('slug.js'), undefined);

  it(
    'applies an edit of an ES module config after invalidate',
    async () => {
      project.write('wyw-in-js.config.mjs', esmConfig('first'));
      const session = open('wyw-in-js.config.mjs');
      const before = await transformSlug(session);

      project.write('wyw-in-js.config.mjs', esmConfig('second'));
      session.invalidate([project.path('wyw-in-js.config.mjs')]);
      const after = await transformSlug(session);

      project.write('wyw-in-js.config.mjs', esmConfig('third'));
      session.invalidate([project.path('wyw-in-js.config.mjs')]);
      const last = await transformSlug(session);

      expect([before, after, last].map(classNameOf)).toEqual([
        'first-slugged',
        'second-slugged',
        'third-slugged',
      ]);
    },
    TIMEOUT
  );

  it(
    'applies an edit of the config named with a query or a hash',
    async () => {
      project.write('wyw-in-js.config.mjs', esmConfig('first'));
      const session = open('wyw-in-js.config.mjs');
      await transformSlug(session);

      project.write('wyw-in-js.config.mjs', esmConfig('query'));
      session.invalidate([`${project.path('wyw-in-js.config.mjs')}?watch=1`]);
      const withQuery = await transformSlug(session);

      project.write('wyw-in-js.config.mjs', esmConfig('hash'));
      session.invalidate([`${project.path('wyw-in-js.config.mjs')}#config`]);
      const withHash = await transformSlug(session);

      expect([withQuery, withHash].map(classNameOf)).toEqual([
        'query-slugged',
        'hash-slugged',
      ]);
    },
    TIMEOUT
  );

  it(
    'reads an ES module config again after its evaluation failed',
    async () => {
      const configFile = project.path('wyw-in-js.config.mjs');
      project.write('wyw-in-js.config.mjs', throwingConfig('first failure'));
      const session = open('wyw-in-js.config.mjs');
      await expect(transformSlug(session)).rejects.toThrow('first failure');

      project.write('wyw-in-js.config.mjs', throwingConfig('second failure'));
      session.invalidate([configFile]);
      const second = await transformSlug(session).catch((error) => error);

      project.write('wyw-in-js.config.mjs', esmConfig('fixed'));
      session.invalidate([configFile]);
      const fixed = await transformSlug(session);
      const next = await transformSlug(session);

      expect(second).toBeInstanceOf(Error);
      expect(second.message).toBe(
        `[wyw-in-js] Failed to load ${configFile}: second failure`
      );
      expect(second.stack).not.toContain('wyw-generation');
      expect([fixed, next].map(classNameOf)).toEqual([
        'fixed-slugged',
        'fixed-slugged',
      ]);
    },
    TIMEOUT
  );

  it(
    'gives a config that reads its own file the values of the edit',
    async () => {
      const configFile = project.path('self.mjs');
      const selfReading = (slug: string) =>
        [
          "import { readFileSync } from 'node:fs';",
          '',
          `// slug: ${slug}`,
          'const source = readFileSync(new URL(import.meta.url), "utf8");',
          'const slug = /slug: (\\w+)/.exec(source)[1];',
          'const place =',
          `  import.meta.filename === ${JSON.stringify(configFile)} &&`,
          `  import.meta.dirname === ${JSON.stringify(dirname(configFile))}`,
          "    ? 'original'",
          "    : 'elsewhere';",
          'export default { classNameSlug: `${slug}-${place}-[title]` };',
          '',
        ].join('\n');
      project.write('self.mjs', selfReading('first'));
      const session = open('self.mjs');
      const before = await transformSlug(session);

      project.write('self.mjs', selfReading('second'));
      session.invalidate([configFile]);
      const after = await transformSlug(session);

      expect([before, after].map(classNameOf)).toEqual([
        'first-original-slugged',
        'second-original-slugged',
      ]);
    },
    TIMEOUT
  );

  it(
    'reads an explicit config again after the pipeline failed with its options',
    async () => {
      project.write(
        'custom.mjs',
        'export default { classNameSlug: () => 42 };\n'
      );
      const session = open('custom.mjs');
      await expect(transformSlug(session)).rejects.toThrow(
        'classNameSlug option must return a string'
      );

      project.write('custom.mjs', esmConfig('fixed'));
      session.invalidate([project.path('custom.mjs')]);
      const fixed = await transformSlug(session);

      expect(classNameOf(fixed)).toBe('fixed-slugged');
    },
    TIMEOUT
  );

  it(
    'reads a .js config of a module package again after its evaluation failed',
    async () => {
      project.write('esm/package.json', '{ "type": "module" }\n');
      project.write('esm/custom.js', throwingConfig('module failure'));
      const session = open('esm/custom.js');
      await expect(transformSlug(session)).rejects.toThrow('module failure');

      project.write('esm/custom.js', esmConfig('module'));
      session.invalidate([project.path('esm/custom.js')]);
      const fixed = await transformSlug(session);

      expect(classNameOf(fixed)).toBe('module-slugged');
    },
    TIMEOUT
  );

  it(
    'reads a .js config of a CommonJS package again after its evaluation failed',
    async () => {
      project.write('cjs/package.json', '{ "type": "commonjs" }\n');
      project.write(
        'cjs/custom.js',
        "throw new Error('commonjs failure');\nmodule.exports = {};\n"
      );
      const session = open('cjs/custom.js');
      await expect(transformSlug(session)).rejects.toThrow('commonjs failure');

      project.write(
        'cjs/custom.js',
        "// import.meta\nmodule.exports = { classNameSlug: 'commonjs-[title]' };\n"
      );
      session.invalidate([project.path('cjs/custom.js')]);
      const fixed = await transformSlug(session);

      expect(classNameOf(fixed)).toBe('commonjs-slugged');
    },
    TIMEOUT
  );

  it(
    'applies a .js config that changed from an ES module to CommonJS',
    async () => {
      project.write('plain/custom.js', esmConfig('first'));
      const session = open('plain/custom.js');
      await transformSlug(session);

      project.write(
        'plain/custom.js',
        [
          'module.exports = {',
          "  classNameSlug: 'second-[title]',",
          "  eval: { strategy: 'invalid' },",
          '};',
          '',
        ].join('\n')
      );
      session.invalidate([project.path('plain/custom.js')]);

      await expect(transformSlug(session)).rejects.toThrow(
        'Unsupported eval.strategy "invalid"'
      );
    },
    TIMEOUT
  );
});
