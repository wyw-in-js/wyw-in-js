import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';

// A module-level binding that a function called at the top level changes is
// not a static value: the default `hybrid` strategy has to evaluate it, and
// the `static` strategy has to refuse it.

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

// The first evaluation spawns the eval runner.
const EVAL_TEST_TIMEOUT = 30_000;

type Strategy = 'execute' | 'hybrid' | 'static';

const readCssVariables = (cssText: string | undefined) =>
  Object.fromEntries(
    Array.from((cssText ?? '').matchAll(/--([\w-]+):([^;]*);/g), (match) => [
      match[1],
      match[2].trim(),
    ])
  );

const withProject = async (
  files: Record<string, string>,
  run: (
    transformEntry: (strategy?: Strategy) => Promise<Record<string, string>>
  ) => Promise<void>
) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wyw-called-mut-')));
  const caches: TransformCacheCollection[] = [];
  const file = (name: string) => join(root, name);

  Object.entries(files).forEach(([name, content]) => {
    mkdirSync(dirname(file(name)), { recursive: true });
    writeFileSync(file(name), content);
  });

  const resolver = async (what: string, importer: string) => {
    if (what === 'test-css-processor') {
      return processorFile;
    }

    return what.startsWith('.')
      ? `${resolve(dirname(importer), what)}.js`
      : null;
  };

  const transformEntry = async (strategy?: Strategy) => {
    const cache = new TransformCacheCollection();
    caches.push(cache);
    const filename = file('entry.js');
    const result = await transform(
      {
        cache,
        options: {
          filename,
          root,
          pluginOptions: {
            configFile: false,
            tagResolver: (source, tag) =>
              source === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
            ...(strategy ? { eval: { strategy } } : {}),
          },
        },
      },
      readFileSync(filename, 'utf8'),
      resolver
    );

    return readCssVariables(result.cssText);
  };

  try {
    await run(transformEntry);
  } finally {
    caches.forEach((cache) => disposeEvalBroker(cache));
    rmSync(root, { recursive: true, force: true });
  }
};

const dependencyProject = {
  'values.js': dedent`
    let size = 0;
    function init() { size += 5; }
    init();

    let depth = 0;
    function bump() { depth++; }
    bump();

    const box = { width: 1 };
    function resize() { box.width = 7; }
    resize();

    export const padding = size;
    export const zIndex = depth;
    export const width = box.width;
  `,
  'entry.js': dedent`
    import { css } from 'test-css-processor';
    import { padding, zIndex, width } from './values';

    export const c = css\`--p: ${'${padding}'}; --z: ${'${zIndex}'}; --w: ${'${width}'};\`;
  `,
};

const sameFileProject = {
  'entry.js': dedent`
    import { css } from 'test-css-processor';

    let size = 0;
    function init() { size += 5; }
    init();

    export const c = css\`--p: ${'${size}'};\`;
  `,
};

describe('values changed by functions called at the top level', () => {
  it(
    'evaluates an imported value that a called function changed under the default strategy',
    async () => {
      await withProject(dependencyProject, async (transformEntry) => {
        expect(await transformEntry()).toEqual({ p: '5', z: '1', w: '7' });
      });
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'evaluates a same-file value that a called function changed under the default strategy',
    async () => {
      await withProject(sameFileProject, async (transformEntry) => {
        expect(await transformEntry()).toEqual({ p: '5' });
      });
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'agrees with the execute strategy',
    async () => {
      await withProject(dependencyProject, async (transformEntry) => {
        expect(await transformEntry('execute')).toEqual(
          await transformEntry('hybrid')
        );
      });
    },
    EVAL_TEST_TIMEOUT
  );

  it.each([
    ['an imported', dependencyProject],
    ['a same-file', sameFileProject],
  ])(
    'fails the static strategy for %s value that a called function changed',
    async (_name, project) => {
      await withProject(project, async (transformEntry) => {
        await expect(transformEntry('static')).rejects.toThrow(
          'could not be resolved at build time'
        );
      });
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'still resolves a value that no function changes under the static strategy',
    async () => {
      await withProject(
        {
          'values.js': dedent`
            let size = 3;
            let other = 0;
            function init() { other += 1; }
            init();
            function shadow(size) { size += 1; return size; }
            shadow(1);

            export const padding = size;
          `,
          'entry.js': dedent`
            import { css } from 'test-css-processor';
            import { padding } from './values';

            export const c = css\`--p: ${'${padding}'};\`;
          `,
        },
        async (transformEntry) => {
          expect(await transformEntry('static')).toEqual({ p: '3' });
        }
      );
    },
    EVAL_TEST_TIMEOUT
  );

  const setterProject = (entryBody: string) => ({
    'values.js': dedent`
      export const theme = { mode: 'light' };
      export function setMode(mode) { theme.mode = mode; }
    `,
    'entry.js': dedent`
      import { css } from 'test-css-processor';
      import { setMode, theme } from './values';
      ${entryBody}
      export const c = css\`--m: ${'${theme.mode}'};\`;
    `,
  });

  it(
    'still resolves a value that only an uncalled exported setter writes under the static strategy',
    async () => {
      await withProject(setterProject(''), async (transformEntry) => {
        expect(await transformEntry('static')).toEqual({ m: 'light' });
      });
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'evaluates a value after the importer calls the exported setter',
    async () => {
      await withProject(
        setterProject("setMode('dark');"),
        async (transformEntry) => {
          expect(await transformEntry()).toEqual({ m: 'dark' });
        }
      );
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'still resolves an object that only an uncalled function passes to a call under the static strategy',
    async () => {
      await withProject(
        {
          'values.js': dedent`
            export const colors = { red: 'red' };
            export function keys() { return Object.keys(colors); }
          `,
          'entry.js': dedent`
            import { css } from 'test-css-processor';
            import { colors } from './values';

            export const c = css\`--c: ${'${colors.red}'};\`;
          `,
        },
        async (transformEntry) => {
          expect(await transformEntry('static')).toEqual({ c: 'red' });
        }
      );
    },
    EVAL_TEST_TIMEOUT
  );
});
