import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

const transformSource = async (code: string) => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-var-before-declaration-'));
  const entryFile = join(root, 'entry.js');
  writeFileSync(entryFile, code);

  try {
    return await transform(
      {
        cache: new TransformCacheCollection(),
        options: {
          filename: entryFile,
          root,
          pluginOptions: {
            configFile: false,
            eval: { strategy: 'hybrid' },
            tagResolver: (source: string, tag: string) =>
              source === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
          },
        },
      },
      code,
      async (what: string) =>
        what === 'test-css-processor' ? processorFile : null
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe('a var read before its declaration', () => {
  // Template interpolations are evaluated lazily at the end of the module, so
  // the evaluated value is the one assigned by the later declaration.
  it.each([
    ['a plain interpolation', '${color}'],
    ['a condition', "${color ? color : 'blue'}"],
    ['a negation', "${!color ? 'blue' : color}"],
  ])(
    'keeps the end-of-module value in %s',
    async (_description, value) => {
      const result = await transformSource(dedent`
      import { css } from 'test-css-processor';

      export const className = css\`color: ${value};\`;

      var color = 'red';
    `);

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).not.toContain('blue');
    },
    30_000
  );
});

type Strategy = 'execute' | 'hybrid' | 'static';

type Project = {
  entryFile: string;
  root: string;
};

const createProject = (
  entry: string,
  files: Record<string, string> = {}
): Project => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-var-before-declaration-'));
  const entryFile = join(root, 'entry.js');
  writeFileSync(entryFile, entry);
  Object.entries(files).forEach(([name, content]) => {
    writeFileSync(join(root, name), content);
  });

  return { entryFile, root };
};

const removeProject = ({ root }: Project) =>
  rmSync(root, { force: true, recursive: true });

const resolveIn = async (what: string, importer: string) => {
  if (what === 'test-css-processor') {
    return processorFile;
  }

  if (what.startsWith('.')) {
    const file = resolve(dirname(importer), what);
    return file.endsWith('.js') ? file : `${file}.js`;
  }

  return null;
};

const transformProject = (
  { entryFile, root }: Project,
  strategy: Strategy,
  cache = new TransformCacheCollection()
) =>
  transform(
    {
      cache,
      options: {
        filename: entryFile,
        root,
        pluginOptions: {
          configFile: false,
          eval: { strategy },
          tagResolver: (source: string, tag: string) =>
            source === 'test-css-processor' && tag === 'css'
              ? processorFile
              : null,
        },
      },
    },
    readFileSync(entryFile, 'utf8'),
    resolveIn
  );

const colorOf = (cssText: string | undefined) =>
  /color:\s*([^;}]*?)\s*[;}]/.exec(cssText ?? '')?.[1];

// The warnings that name a file of the project, as transform reports them
// through `console.warn` or `process.emitWarning`.
const captureWarnings = (project: Project) => {
  const messages: string[] = [];
  const record = (message: unknown) => {
    const text = message instanceof Error ? message.message : String(message);
    if (text.includes(project.root) || text.includes('entry.js')) {
      messages.push(text);
    }
  };
  const warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((message: unknown) => record(message));
  const emitWarningSpy = jest
    .spyOn(process, 'emitWarning')
    .mockImplementation((warning: string | Error) => record(warning));

  return {
    messages,
    restore: () => {
      warnSpy.mockRestore();
      emitWarningSpy.mockRestore();
    },
  };
};

const withProject = async <T>(
  entry: string,
  files: Record<string, string>,
  run: (project: Project) => Promise<T>
): Promise<T> => {
  const project = createProject(entry, files);
  try {
    return await run(project);
  } finally {
    removeProject(project);
  }
};

const colorIn = (
  entry: string,
  strategy: Strategy,
  files: Record<string, string> = {}
) =>
  withProject(entry, files, async (project) =>
    colorOf((await transformProject(project, strategy)).cssText)
  );

const interpolationAbove = (value: string, below: string, above = '') =>
  dedent`
    import { css } from 'test-css-processor';

    ${above}

    export const className = css\`color: ${value};\`;

    ${below}
  `;

const interpolationBelow = (value: string, above: string) =>
  dedent`
    import { css } from 'test-css-processor';

    ${above}

    export const className = css\`color: ${value};\`;
  `;

describe('the execution point of a var read before its declaration', () => {
  // Interpolations run at the end of the module, where the var already holds
  // the value of its declaration. Eval is the oracle for every case.
  it.each([
    ['a nullish fallback', "${color ?? 'blue'}", 'red'],
    ['a logical or', "${color || 'blue'}", 'red'],
    ['a logical and', "${color && 'green'}", 'green'],
    ['typeof', '${typeof color}', 'string'],
    ['a comparison', "${color === undefined ? 'blue' : color}", 'red'],
    ['a plain read', '${color}', 'red'],
  ])(
    'reads the value of the var at the end of the module in %s',
    async (_description, value, expected) => {
      const entry = interpolationAbove(value, "var color = 'red';");

      expect(await colorIn(entry, 'execute')).toBe(expected);
      expect(await colorIn(entry, 'hybrid')).toBe(expected);
      expect(await colorIn(entry, 'static')).toBe(expected);
    },
    30_000
  );

  it.each([
    ['returns the var', "return color ?? 'blue';"],
    [
      'reads the var into a local',
      "const value = color;\nreturn value ?? 'blue';",
    ],
  ])(
    'reads the value of the var at the end of the module in a function that %s, called from an interpolation',
    async (_description, body) => {
      const entry = interpolationAbove(
        '${pick()}',
        "var color = 'red';",
        `function pick() {\n${body}\n}`
      );

      expect(await colorIn(entry, 'execute')).toBe('red');
      expect(await colorIn(entry, 'hybrid')).toBe('red');
      expect(await colorIn(entry, 'static')).toBe('red');
    },
    30_000
  );

  // The initializer of a module binding runs at its declaration, before the
  // later var gets its value, even when the interpolation stands below both.
  it.each([
    ['reads the var', "const c = color ?? 'blue';"],
    [
      'calls a function that reads the var',
      "function pick() {\n  return color ?? 'blue';\n}\nconst c = pick();",
    ],
  ])(
    'does not read the value of the var at the end of the module in an initializer that %s',
    async (_description, declaration) => {
      const entry = interpolationBelow(
        '${c}',
        `${declaration}\nvar color = 'red';`
      );

      expect(await colorIn(entry, 'execute')).toBe('blue');
      expect(await colorIn(entry, 'hybrid')).toBe('blue');
      expect(await colorIn(entry, 'static')).toBe('blue');
    },
    30_000
  );

  const unknownAtTheEnd: [string, string, string, string, string][] = [
    [
      'a reassignment',
      interpolationAbove(
        "${color ?? 'blue'}",
        "var color = 'red';\ncolor = 'green';"
      ),
      "color ?? 'blue'",
      'green',
      'blue',
    ],
    [
      'a conditional assignment',
      interpolationAbove(
        "${color ?? 'blue'}",
        "var color;\nif (Date.now() > 0) {\n  color = 'red';\n}"
      ),
      "color ?? 'blue'",
      'red',
      'blue',
    ],
    [
      'an initializer that reads the var at its declaration',
      interpolationBelow(
        "${c || 'blue'}",
        "const c = color;\nvar color = 'red';"
      ),
      "c || 'blue'",
      'blue',
      'red',
    ],
  ];

  it.each(unknownAtTheEnd)(
    'leaves the value of the end of the module to eval in hybrid after %s',
    async (_description, entry, _source, evaluated) => {
      const project = createProject(entry);
      const warnings = captureWarnings(project);
      try {
        const executed = await transformProject(project, 'execute');
        const hybrid = await transformProject(project, 'hybrid');

        expect(colorOf(executed.cssText)).toBe(evaluated);
        expect(colorOf(hybrid.cssText)).toBe(evaluated);
        expect(warnings.messages).toEqual([]);
      } finally {
        warnings.restore();
        removeProject(project);
      }
    },
    30_000
  );

  it.each(unknownAtTheEnd)(
    'keeps the earlier value in static and warns once when the value of the end of the module is unknown after %s',
    async (_description, entry, source, _evaluated, earlier) => {
      const project = createProject(entry);
      const warnings = captureWarnings(project);
      try {
        const first = await transformProject(project, 'static');

        expect(colorOf(first.cssText)).toBe(earlier);
        expect(warnings.messages).toHaveLength(1);
        expect(warnings.messages[0]).toContain('[wyw-in-js]');
        expect(warnings.messages[0]).toContain('entry.js');
        expect(warnings.messages[0]).toContain(source);

        const second = await transformProject(project, 'static');

        expect(colorOf(second.cssText)).toBe(earlier);
        expect(warnings.messages).toHaveLength(1);
      } finally {
        warnings.restore();
        removeProject(project);
      }
    },
    30_000
  );

  it.each<Strategy>(['execute', 'hybrid', 'static'])(
    'reads a later var at the declaration of an export of another module in %s',
    async (strategy) => {
      const entry = dedent`
        import { css } from 'test-css-processor';
        import { x } from './tokens';

        export const className = css\`color: ${'${x}'};\`;
      `;
      const tokens = "export const x = y ?? 'blue';\nvar y = 'red';\n";

      expect(await colorIn(entry, strategy, { 'tokens.js': tokens })).toBe(
        'blue'
      );
    },
    30_000
  );

  // In static, the interpolation reads `c` in its TDZ and fails, which this
  // case does not cover.
  it.each<Strategy>(['execute', 'hybrid'])(
    'reads a later var at the declaration of an initializer between the interpolation and the var in %s',
    async (strategy) => {
      const entry = interpolationAbove(
        '${c}',
        "const c = color ?? 'blue';\nvar color = 'red';"
      );

      expect(await colorIn(entry, strategy)).toBe('blue');
    },
    30_000
  );

  it.each<Strategy>(['execute', 'hybrid', 'static'])(
    'reads an unset process.env variable as undefined in a fallback in %s',
    async (strategy) => {
      const entry = interpolationAbove(
        "${process.env.WYW_VAR_BEFORE_DECLARATION_UNSET ?? 'blue'}",
        ''
      );

      expect(await colorIn(entry, strategy)).toBe('blue');
    },
    30_000
  );
});
