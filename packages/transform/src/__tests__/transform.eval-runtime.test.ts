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
import type { PartialOptions } from '../transform/helpers/loadWywOptions';

// What evaluated code observes when transform() runs it in the eval runner:
// resolver order, special specifiers, module identity, and the globals of
// the VM context. These are the runner-path counterparts of the cases the
// deprecated in-process `Module` evaluator is tested with.

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

// The first evaluation spawns the eval runner.
const EVAL_TEST_TIMEOUT = 30_000;

type AsyncResolve = (what: string, importer: string) => Promise<string | null>;

type BundlerResolve = (what: string, importer: string) => string | null;

type TransformEntryOptions = {
  /** Answers bare specifiers, as a bundler resolver would. */
  bundler?: BundlerResolve;
  cache?: TransformCacheCollection;
  entry?: string;
  pluginOptions?: PartialOptions;
};

type Project = {
  file: (name: string) => string;
  root: string;
  transformEntry: (
    options?: TransformEntryOptions
  ) => Promise<Record<string, string>>;
};

const readCssVariables = (cssText: string | undefined) =>
  Object.fromEntries(
    Array.from((cssText ?? '').matchAll(/--([\w-]+):([^;]*);/g), (match) => [
      match[1],
      match[2].trim(),
    ])
  );

const noBundler: BundlerResolve = () => null;

// Relative specifiers resolve next to the importer (query included); bare
// specifiers go to the bundler stand-in.
const createResolver =
  (bundler: BundlerResolve): AsyncResolve =>
  async (what, importer) => {
    if (what === 'test-css-processor') {
      return processorFile;
    }

    if (what.startsWith('.')) {
      return resolve(dirname(importer), what);
    }

    return bundler(what, importer);
  };

const withProject = async (
  files: Record<string, string>,
  run: (project: Project) => Promise<void>
) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wyw-eval-runtime-')));
  const caches: TransformCacheCollection[] = [];
  const file = (name: string) => join(root, name);

  Object.entries(files).forEach(([name, content]) => {
    mkdirSync(dirname(file(name)), { recursive: true });
    writeFileSync(file(name), content);
  });

  // transform() keys the eval session by the resolver's identity, so one
  // bundler stand-in keeps one resolver for the whole project.
  const resolvers = new Map<BundlerResolve, AsyncResolve>();
  const getResolver = (bundler: BundlerResolve) => {
    if (!resolvers.has(bundler)) {
      resolvers.set(bundler, createResolver(bundler));
    }

    return resolvers.get(bundler)!;
  };

  const transformEntry: Project['transformEntry'] = async ({
    bundler = noBundler,
    cache = new TransformCacheCollection(),
    entry = 'entry.js',
    pluginOptions = {},
  } = {}) => {
    if (!caches.includes(cache)) {
      caches.push(cache);
    }

    const filename = file(entry);
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
            ...pluginOptions,
            eval: { strategy: 'execute', ...pluginOptions.eval },
          },
        },
      },
      readFileSync(filename, 'utf8'),
      getResolver(bundler)
    );

    return readCssVariables(result.cssText);
  };

  try {
    await run({ file, root, transformEntry });
  } finally {
    caches.forEach((cache) => disposeEvalBroker(cache));
    rmSync(root, { recursive: true, force: true });
  }
};

const importDep = dedent`
  import { css } from 'test-css-processor';
  import value from 'dep';

  export const className = css\`
    --value: ${'${value}'};
  \`;
`;

const nativeDep = {
  'node_modules/dep/package.json': JSON.stringify({
    name: 'dep',
    type: 'module',
    main: 'index.js',
  }),
  'node_modules/dep/index.js': "export default 'native';",
};

describe('eval resolver order', () => {
  it(
    'prefers the custom resolver over the bundler',
    async () => {
      await withProject(
        {
          'bundler.js': "export default 'bundler';",
          'custom.js': "export default 'custom';",
          'entry.js': importDep,
        },
        async ({ file, transformEntry }) => {
          const customResolver = jest.fn(async (specifier: string) =>
            specifier === 'dep' ? { id: file('custom.js') } : null
          );

          const css = await transformEntry({
            bundler: () => file('bundler.js'),
            pluginOptions: { eval: { customResolver } },
          });

          expect(css.value).toBe('custom');
          expect(customResolver).toHaveBeenCalledWith(
            'dep',
            file('entry.js'),
            'import'
          );
        }
      );
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'asks the bundler before the native resolver in bundler mode',
    async () => {
      await withProject(
        {
          ...nativeDep,
          'bundler.js': "export default 'bundler';",
          'entry.js': importDep,
        },
        async ({ file, transformEntry }) => {
          const customResolver = jest.fn(async () => null);

          const css = await transformEntry({
            bundler: () => file('bundler.js'),
            pluginOptions: { eval: { customResolver } },
          });

          expect(css.value).toBe('bundler');
          expect(customResolver).toHaveBeenCalledWith(
            'dep',
            file('entry.js'),
            'import'
          );
        }
      );
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'falls back to the native resolver when the bundler cannot resolve',
    async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await withProject(
          { ...nativeDep, 'entry.js': importDep },
          async ({ transformEntry }) => {
            const css = await transformEntry({
              pluginOptions: { eval: { customResolver: async () => null } },
            });

            expect(css.value).toBe('native');
          }
        );

        expect(warn.mock.calls.flat().join('\n')).toContain(
          'native resolver fallback'
        );
      } finally {
        warn.mockRestore();
      }
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'prefers the native resolver over the bundler in hybrid mode',
    async () => {
      await withProject(
        {
          ...nativeDep,
          'bundler.js': "export default 'bundler';",
          'entry.js': importDep,
        },
        async ({ file, transformEntry }) => {
          const css = await transformEntry({
            bundler: () => file('bundler.js'),
            pluginOptions: { eval: { resolver: 'hybrid' } },
          });

          expect(css.value).toBe('native');
        }
      );
    },
    EVAL_TEST_TIMEOUT
  );
});

describe('eval specifiers', () => {
  it(
    'loads query ids through import loaders',
    async () => {
      await withProject(
        {
          'asset.txt': 'raw-content',
          'entry.js': dedent`
            import { css } from 'test-css-processor';
            import asset from './asset.txt?raw';

            export const className = css\`
              --asset: ${'${asset}'};
            \`;
          `,
        },
        async ({ transformEntry }) => {
          const css = await transformEntry();

          expect(css.asset).toBe('raw-content');
        }
      );
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'links the Vite React Refresh virtual id',
    async () => {
      await withProject(
        {
          'entry.js': dedent`
            import { css } from 'test-css-processor';
            import { createSignatureFunctionForTransform } from '/@react-refresh';

            const refresh = typeof createSignatureFunctionForTransform;

            export const className = css\`
              --refresh: ${'${refresh}'};
            \`;
          `,
        },
        async ({ transformEntry }) => {
          const css = await transformEntry();

          expect(css.refresh).toBe('function');
        }
      );
    },
    EVAL_TEST_TIMEOUT
  );
});

describe('eval module identity', () => {
  const tokenModule =
    'export const token = Math.random().toString(36).slice(2);';

  it(
    'evaluates a module once when several importers share it',
    async () => {
      await withProject(
        {
          'a.js': "import { token } from './token';\nexport const a = token;",
          'b.js': "import { token } from './token';\nexport const b = token;",
          'entry.js': dedent`
            import { css } from 'test-css-processor';
            import { a } from './a';
            import { b } from './b';

            export const className = css\`
              --a: ${'${a}'};
              --b: ${'${b}'};
            \`;
          `,
          'token.js': tokenModule,
        },
        async ({ transformEntry }) => {
          const css = await transformEntry();

          expect(css.a).toMatch(/^\w+$/);
          expect(css.b).toBe(css.a);
        }
      );
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'does not evaluate a module again for the next entrypoint',
    async () => {
      const entry = dedent`
        import { css } from 'test-css-processor';
        import { token } from './token';

        export const className = css\`
          --token: ${'${token}'};
        \`;
      `;

      await withProject(
        {
          'first.js': entry,
          'second.js': entry,
          'token.js': tokenModule,
        },
        async ({ transformEntry }) => {
          const cache = new TransformCacheCollection();
          const first = await transformEntry({ cache, entry: 'first.js' });
          const second = await transformEntry({ cache, entry: 'second.js' });

          expect(first.token).toMatch(/^\w+$/);
          expect(second.token).toBe(first.token);
        }
      );
    },
    EVAL_TEST_TIMEOUT
  );
});

// The preeval stage replaces browser globals in module-level code before it
// reaches the runner, so these cases turn it off to observe the VM context
// itself.
const withoutCodeRemover = (
  features: PartialOptions['features'] = {}
): PartialOptions => ({
  features: { dangerousCodeRemover: false, ...features },
});

describe('eval context globals', () => {
  it(
    'provides timers and builtins without referencing global',
    async () => {
      await withProject(
        {
          'entry.js': dedent`
            import { css } from 'test-css-processor';

            const timeout = setTimeout(() => {}, 0);
            clearTimeout(timeout);
            const interval = setInterval(() => {}, 0);
            clearInterval(interval);
            const immediate = setImmediate(() => {});
            clearImmediate(immediate);

            const timers = [
              setTimeout,
              clearTimeout,
              setInterval,
              clearInterval,
              setImmediate,
              clearImmediate,
            ]
              .map((fn) => typeof fn)
              .join(',');
            const unique = new Set([1, 1, 2]).size;

            export const className = css\`
              --timers: ${'${timers}'};
              --unique: ${'${unique}'};
            \`;
          `,
        },
        async ({ transformEntry }) => {
          const css = await transformEntry({
            pluginOptions: withoutCodeRemover(),
          });

          expect(css.timers).toBe(Array(6).fill('function').join(','));
          expect(css.unique).toBe('2');
        }
      );
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'gives every module its own __filename and __dirname',
    async () => {
      await withProject(
        {
          'entry.js': dedent`
            import { css } from 'test-css-processor';
            import { depDir, depFile } from './nested/dep';

            const entryFile = __filename;
            const entryDir = __dirname;

            export const className = css\`
              --entry-file: ${'${entryFile}'};
              --entry-dir: ${'${entryDir}'};
              --dep-file: ${'${depFile}'};
              --dep-dir: ${'${depDir}'};
            \`;
          `,
          'nested/dep.js': dedent`
            export const depFile = __filename;
            export const depDir = __dirname;
          `,
        },
        async ({ file, root, transformEntry }) => {
          const css = await transformEntry({
            pluginOptions: withoutCodeRemover(),
          });

          expect(css).toMatchObject({
            'dep-dir': file('nested'),
            'dep-file': file('nested/dep.js'),
            'entry-dir': root,
            'entry-file': file('entry.js'),
          });
        }
      );
    },
    EVAL_TEST_TIMEOUT
  );
});

describe('eval DOM', () => {
  const domProbe = dedent`
    import { css } from 'test-css-processor';

    const kinds = [typeof document, typeof window, typeof global].join(',');

    const probeDom = () => {
      const handler = () => {};
      document.addEventListener('click', handler);
      document.removeEventListener('click', handler);
      window.addEventListener('click', handler);
      window.removeEventListener('click', handler);

      const container = document.createElement('section');
      const el = document.createElement('div');
      el.setAttribute('id', 'test');
      container.appendChild(el);
      document.body.appendChild(container);
      const attached = document.body.contains(el);
      container.remove();

      return [container.innerHTML, el.tagName.toLowerCase(), attached].join(
        '|'
      );
    };

    const dom = typeof document === 'object' ? probeDom() : 'none';

    export const className = css\`
      --kinds: ${'${kinds}'};
      --dom: ${'${dom}'};
    \`;
  `;

  it(
    'provides DOM globals, APIs and manipulation with happyDOM',
    async () => {
      await withProject(
        { 'entry.js': domProbe },
        async ({ transformEntry }) => {
          const css = await transformEntry({
            pluginOptions: withoutCodeRemover(),
          });

          expect(css.kinds).toBe('object,object,object');
          expect(css.dom).toBe('<div id="test"></div>|div|true');
        }
      );
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'keeps window and global but no document without happyDOM',
    async () => {
      await withProject(
        { 'entry.js': domProbe },
        async ({ transformEntry }) => {
          const css = await transformEntry({
            pluginOptions: withoutCodeRemover({ happyDOM: false }),
          });

          expect(css.kinds).toBe('undefined,object,object');
          expect(css.dom).toBe('none');
        }
      );
    },
    EVAL_TEST_TIMEOUT
  );
});

describe('eval realm', () => {
  // Literals, engine errors and global names must all come from one realm,
  // with or without DOM emulation (#498).
  const realmProbe = dedent`
    import { css } from 'test-css-processor';

    const engineError = (() => {
      try {
        return null.x;
      } catch (e) {
        return e;
      }
    })();

    const realm = [
      ({}).constructor === Object,
      [] instanceof Array,
      Object.getPrototypeOf([]) === Array.prototype,
      engineError instanceof TypeError,
    ].join(',');

    const buffer =
      typeof Buffer === 'function'
        ? String(Buffer.from('a') instanceof Uint8Array)
        : 'none';
    const document_ = typeof document;

    export const className = css\`
      --realm: ${'${realm}'};
      --buffer: ${'${buffer}'};
      --document: ${'${document_}'};
    \`;
  `;

  it.each([
    // The eval runner installs the host Buffer and Uint8Array only on the
    // DOM window.
    { happyDOM: true, buffer: 'true', document: 'object' },
    { happyDOM: false, buffer: 'none', document: 'undefined' },
  ])(
    'evaluates literals and global constructors in one realm with happyDOM: $happyDOM',
    async ({ happyDOM, buffer, document }) => {
      await withProject(
        { 'entry.js': realmProbe },
        async ({ transformEntry }) => {
          const css = await transformEntry({
            pluginOptions: withoutCodeRemover({ happyDOM }),
          });

          expect(css).toEqual({
            realm: 'true,true,true,true',
            buffer,
            document,
          });
        }
      );
    },
    EVAL_TEST_TIMEOUT
  );
});

describe('evaluated dependencies', () => {
  it(
    'sees an outer binding that a called function reassigns',
    async () => {
      await withProject(
        {
          'entry.js': dedent`
            import { css } from 'test-css-processor';
            import { V } from './dep';

            export const className = css\`
              --value: ${'${V}'};
            \`;
          `,
          'dep.js': dedent`
            let n = 0;
            function init() {
              n = 5;
            }
            init();
            export const V = n;
          `,
        },
        async ({ transformEntry }) => {
          const css = await transformEntry();

          expect(css.value).toBe('5');
        }
      );
    },
    EVAL_TEST_TIMEOUT
  );
});
