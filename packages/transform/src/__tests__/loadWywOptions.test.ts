import fs, { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import path from 'path';

import { loadWywOptions } from '../transform/helpers/loadWywOptions';

describe('loadWywOptions', () => {
  const initialCwd = process.cwd();

  afterEach(() => {
    process.chdir(initialCwd);
  });

  it('keeps bundler resolution as the default and preserves Oxc options', () => {
    const oxcOptions = {
      parser: { sourceType: 'module' },
      resolver: { conditionNames: ['import', 'default'] },
      transform: { jsx: 'automatic' },
    };

    const options = loadWywOptions({
      configFile: false,
      oxcOptions,
      rules: [
        {
          action: 'ignore',
          oxcOptions,
        },
      ],
    });

    expect(options.eval?.resolver).toBe('bundler');
    expect(options.evalConsole).toBe('pipe');
    expect(options.oxcOptions).toBe(oxcOptions);
    expect(options.rules[0].oxcOptions).toBe(oxcOptions);
  });

  it('preserves processor options and lets inline processors replace config processors', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-options-'));
    const configFile = path.join(root, 'wyw-in-js.config.mjs');
    const inlineProcessors = {
      typedProcessorOptionsTest: {
        minifyClassNames: true,
      },
    };

    writeFileSync(
      configFile,
      [
        'export default {',
        '  processors: {',
        '    typedProcessorOptionsTest: {',
        '      configOnly: true,',
        '      minifyClassNames: false,',
        '    },',
        '  },',
        '};',
        '',
      ].join('\n')
    );

    try {
      const options = loadWywOptions({
        configFile,
        processors: inlineProcessors,
      });

      expect(options.processors).toBe(inlineProcessors);
      expect(options.processors).toEqual({
        typedProcessorOptionsTest: {
          minifyClassNames: true,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts native and hybrid resolver modes without changing the default', () => {
    const defaultOptions = loadWywOptions({ configFile: false });
    const nativeOptions = loadWywOptions({
      configFile: false,
      eval: {
        resolver: 'native',
      },
    });
    const hybridOptions = loadWywOptions({
      configFile: false,
      eval: {
        resolver: 'hybrid',
      },
    });

    expect(defaultOptions.eval?.resolver).toBe('bundler');
    expect(nativeOptions.eval?.resolver).toBe('native');
    expect(hybridOptions.eval?.resolver).toBe('hybrid');
  });

  it('rejects the removed node resolver mode instead of aliasing it', () => {
    expect(() =>
      loadWywOptions({
        configFile: false,
        eval: {
          resolver: 'node' as never,
        },
      })
    ).toThrow('Unsupported eval.resolver "node"');
  });

  it('autodiscovers wyw-in-js.config.mjs files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-options-'));
    const configFile = path.join(root, 'wyw-in-js.config.mjs');

    writeFileSync(
      configFile,
      [
        'export default {',
        '  displayName: true,',
        '  tagResolver(source, tag) {',
        "    return source === 'test-css-processor' && tag === 'css'",
        "      ? './processor.js'",
        '      : null;',
        '  },',
        '};',
        '',
      ].join('\n')
    );

    try {
      process.chdir(root);

      const options = loadWywOptions({});

      expect(options.displayName).toBe(true);
      expect(
        options.tagResolver?.(
          'test-css-processor',
          'css',
          path.join(root, 'entry.js')
        )
      ).toBe('./processor.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads explicit .mjs configFile paths', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-options-'));
    const configFile = path.join(root, 'wyw-in-js.config.mjs');

    writeFileSync(
      path.join(root, 'shared.mjs'),
      'export const displayName = true;\n'
    );
    writeFileSync(
      configFile,
      [
        "import { displayName } from './shared.mjs';",
        '',
        'export default {',
        '  displayName,',
        '};',
        '',
      ].join('\n')
    );

    try {
      const options = loadWywOptions({ configFile });

      expect(options.displayName).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['.ts', '.mts'])('loads explicit %s configFile paths', (ext) => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-options-'));
    const configFile = path.join(root, `wyw-in-js.config${ext}`);

    writeFileSync(
      path.join(root, `shared${ext}`),
      'export const suffix: string = "-slug";\n'
    );
    writeFileSync(
      configFile,
      [
        "import type { PluginOptions } from '@wyw-in-js/transform';",
        `import { suffix } from './shared${ext}';`,
        '',
        'const options: Partial<PluginOptions> = {',
        '  displayName: true,',
        '  classNameSlug: (hash: string) => `${hash}${suffix}`,',
        '};',
        '',
        'export default options;',
        '',
      ].join('\n')
    );

    try {
      const options = loadWywOptions({ configFile });

      expect(options.displayName).toBe(true);
      expect(typeof options.classNameSlug).toBe('function');
      expect((options.classNameSlug as (hash: string) => string)('abc')).toBe(
        'abc-slug'
      );
      expect(loadWywOptions({ configFile }).classNameSlug).toBe(
        options.classNameSlug
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // chmod does not stop root from writing.
  (process.getuid?.() === 0 ? it.skip : it)(
    'loads a .ts config without writing next to it',
    () => {
      const root = mkdtempSync(path.join(tmpdir(), 'wyw-options-'));
      const configFile = path.join(root, 'wyw-in-js.config.ts');

      writeFileSync(
        configFile,
        [
          "enum Slug { Suffix = '-ts' }",
          'export default {',
          '  classNameSlug: (hash: string) => `${hash}${Slug.Suffix}`,',
          '  root: __dirname,',
          '};',
          '',
        ].join('\n')
      );
      chmodSync(root, 0o555);

      try {
        const options = loadWywOptions({ configFile }) as ReturnType<
          typeof loadWywOptions
        > & { root?: string };

        expect((options.classNameSlug as (hash: string) => string)('abc')).toBe(
          'abc-ts'
        );
        expect(options.root).toBe(fs.realpathSync(root));
        expect(fs.readdirSync(root)).toEqual(['wyw-in-js.config.ts']);
      } finally {
        chmodSync(root, 0o755);
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('reads __dirname and relative files of a symlinked .ts config next to the link', () => {
    const root = fs.realpathSync(
      mkdtempSync(path.join(tmpdir(), 'wyw-options-'))
    );
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    fs.mkdirSync(real);
    fs.mkdirSync(link);
    writeFileSync(path.join(real, 'flag.js'), 'module.exports = false;\n');
    writeFileSync(path.join(link, 'flag.js'), 'module.exports = true;\n');
    writeFileSync(
      path.join(real, 'wyw-in-js.config.ts'),
      [
        "const flag: boolean = require('./flag.js');",
        'export default { displayName: flag, root: __dirname };',
        '',
      ].join('\n')
    );
    const configFile = path.join(link, 'wyw-in-js.config.ts');
    fs.symlinkSync(path.join(real, 'wyw-in-js.config.ts'), configFile);

    try {
      const options = loadWywOptions({ configFile }) as ReturnType<
        typeof loadWywOptions
      > & { root?: string };

      expect(options.displayName).toBe(true);
      expect(options.root).toBe(link);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names the .ts config file in a syntax error', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-options-'));
    const configFile = path.join(root, 'wyw-in-js.config.ts');
    writeFileSync(configFile, 'export default { displayName: ;\n');

    try {
      expect(() => loadWywOptions({ configFile })).toThrow(
        `TypeScript Error in ${configFile}`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('explains that a .ts config with top-level await cannot load', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-options-'));
    const configFile = path.join(root, 'wyw-in-js.config.ts');
    writeFileSync(
      configFile,
      'const value = await Promise.resolve(true);\nexport default { displayName: value };\n'
    );

    try {
      expect(() => loadWywOptions({ configFile })).toThrow(
        'WyW config loading is synchronous'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads a .ts config that reads import.meta', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-options-'));
    const configFile = path.join(root, 'wyw-in-js.config.ts');
    writeFileSync(
      configFile,
      "export default { displayName: import.meta.url.startsWith('file:') };\n"
    );

    try {
      expect(loadWywOptions({ configFile }).displayName).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads explicit CommonJS .cts configFile paths', () => {
    const root = fs.realpathSync(
      mkdtempSync(path.join(tmpdir(), 'wyw-options-'))
    );
    const configFile = path.join(root, 'wyw-in-js.config.cts');

    writeFileSync(
      configFile,
      [
        'module.exports = {',
        '  classNameSlug: (hash: string) => hash,',
        '  displayName: true,',
        '  root: __dirname,',
        '};',
        '',
      ].join('\n')
    );

    try {
      const options = loadWywOptions({ configFile }) as ReturnType<
        typeof loadWywOptions
      > & { root?: string };

      expect(options.displayName).toBe(true);
      expect(options.root).toBe(root);
      expect(loadWywOptions({ configFile }).classNameSlug).toBe(
        options.classNameSlug
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws a clear error for .mjs config files with top-level await', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-options-'));
    const configFile = path.join(root, 'wyw-in-js.config.mjs');
    // Node refuses to require() an async ESM graph; bun evaluates it. The
    // clear error only exists where the refusal does.
    const probeFile = path.join(root, 'probe.mjs');
    writeFileSync(probeFile, 'await Promise.resolve();\nexport default 1;\n');
    const runtimeRequiresAsyncEsm = (() => {
      try {
        createRequire(probeFile)(probeFile);
        return true;
      } catch {
        return false;
      }
    })();

    writeFileSync(
      configFile,
      [
        'await Promise.resolve();',
        '',
        'export default {',
        '  displayName: true,',
        '};',
        '',
      ].join('\n')
    );

    try {
      if (runtimeRequiresAsyncEsm) {
        expect(loadWywOptions({ configFile }).displayName).toBe(true);
        return;
      }
      expect(() => loadWywOptions({ configFile })).toThrow(
        'WyW config loading is synchronous, so .mjs config files must not use top-level await'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  describe('config discovery', () => {
    const withCwd = <T>(callback: (root: string) => T): T => {
      // Resolve symlinked temp roots (macOS /var -> /private/var) so paths
      // match what process.cwd() reports after chdir.
      const root = fs.realpathSync(
        mkdtempSync(path.join(tmpdir(), 'wyw-cfg-'))
      );
      try {
        process.chdir(root);
        return callback(root);
      } finally {
        process.chdir(initialCwd);
        rmSync(root, { recursive: true, force: true });
      }
    };

    it('probes the search places once per working directory', () => {
      withCwd((root) => {
        const configFile = path.join(root, '.wyw-in-jsrc.json');
        writeFileSync(configFile, JSON.stringify({ displayName: true }));
        const existsSync = jest.spyOn(fs, 'existsSync');

        try {
          expect(loadWywOptions({}).displayName).toBe(true);
          const firstProbes = existsSync.mock.calls.length;
          expect(firstProbes).toBeGreaterThan(0);

          // A new overrides object misses the identity cache, as it does for
          // adapters that build options per module.
          expect(loadWywOptions({}).displayName).toBe(true);
          const repeatedProbes = existsSync.mock.calls
            .slice(firstProbes)
            .map(([probed]) => probed);
          expect(repeatedProbes).toEqual([configFile]);
        } finally {
          existsSync.mockRestore();
        }
      });
    });

    it('remembers that no config file was found', () => {
      withCwd(() => {
        const existsSync = jest.spyOn(fs, 'existsSync');

        try {
          expect(loadWywOptions({}).displayName).toBe(false);
          const firstProbes = existsSync.mock.calls.length;
          expect(firstProbes).toBeGreaterThan(0);

          expect(loadWywOptions({}).displayName).toBe(false);
          expect(existsSync.mock.calls.length).toBe(firstProbes);
        } finally {
          existsSync.mockRestore();
        }
      });
    });

    it('searches again when the discovered config file is removed', () => {
      withCwd((root) => {
        const configFile = path.join(root, '.wyw-in-jsrc.json');
        writeFileSync(configFile, JSON.stringify({ displayName: true }));

        expect(loadWywOptions({}).displayName).toBe(true);
        rmSync(configFile);
        expect(loadWywOptions({}).displayName).toBe(false);
      });
    });
  });
});
