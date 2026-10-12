/* eslint-env jest */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import { getEvalOptions } from '../utils/evalOptions';
import { resolveWithNativeResolver } from '../utils/nativeResolver';

describe('loadWywOptions merge', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wyw-options-merge-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeConfig = (config: Record<string, unknown>): string => {
    const configFile = path.join(root, '.wyw-in-jsrc.json');
    writeFileSync(configFile, JSON.stringify(config));
    return configFile;
  };

  describe('an option set to undefined', () => {
    it('keeps the eval defaults', () => {
      const options = loadWywOptions({
        configFile: false,
        eval: {
          errors: undefined,
          require: undefined,
          resolver: undefined,
          runtime: undefined,
          strategy: undefined,
        },
      });

      expect(options.eval).toEqual({
        errors: 'strict',
        require: 'warn-and-run',
        resolver: 'bundler',
        runtime: 'nodejs',
        strategy: 'hybrid',
      });
    });

    it('keeps the eval options of the config file', () => {
      const configFile = writeConfig({
        eval: { errors: 'loose', resolver: 'hybrid' },
      });

      const options = loadWywOptions({
        configFile,
        eval: { errors: undefined, resolver: undefined },
      });

      expect(options.eval).toMatchObject({
        errors: 'loose',
        resolver: 'hybrid',
      });
    });

    it('keeps the default import loaders', () => {
      const configFile = writeConfig({ importLoaders: { url: false } });

      const options = loadWywOptions({
        configFile,
        importLoaders: { raw: undefined, url: undefined },
      });

      expect(options.importLoaders).toEqual({ raw: 'raw', url: false });
    });

    it('keeps the top-level defaults', () => {
      const options = loadWywOptions({
        configFile: false,
        displayName: undefined,
        evalConsole: undefined,
        extensions: undefined,
        highPriorityPlugins: undefined,
        outputMetadata: undefined,
      });

      expect(options).toMatchObject({
        displayName: false,
        evalConsole: 'pipe',
        extensions: [
          '.cjs',
          '.cts',
          '.js',
          '.jsx',
          '.mjs',
          '.mts',
          '.ts',
          '.tsx',
        ],
        highPriorityPlugins: ['module-resolver'],
        outputMetadata: false,
      });
    });

    it('does not replace a value from the config file', () => {
      const configFile = writeConfig({
        displayName: true,
        outputMetadata: true,
      });

      const options = loadWywOptions({
        configFile,
        displayName: undefined,
        outputMetadata: undefined,
      });

      expect(options.displayName).toBe(true);
      expect(options.outputMetadata).toBe(true);
    });

    it('in the config file keeps the default', () => {
      const configFile = path.join(root, 'wyw-in-js.config.cjs');
      writeFileSync(
        configFile,
        'module.exports = { evalConsole: undefined, eval: { resolver: undefined } };\n'
      );

      const options = loadWywOptions({ configFile });

      expect(options.evalConsole).toBe('pipe');
      expect(options.eval?.resolver).toBe('bundler');
    });
  });

  describe('oxcOptions of the config file', () => {
    // What an adapter passes: the bundler aliases in the plugin oxcOptions.
    const pluginOxcOptions = {
      parser: { fromPlugin: true },
      resolver: {
        alias: {
          '@bundler': ['/bundler'],
          '@shared': ['/from-bundler'],
        },
      },
    };

    it('keeps the bundler aliases under the aliases of the config file', () => {
      const configFile = writeConfig({
        oxcOptions: {
          resolver: {
            alias: {
              '@config': ['/config'],
              '@shared': ['/from-config'],
            },
            tsconfig: 'auto',
          },
          transform: { fromConfig: true },
        },
      });

      const options = loadWywOptions({
        configFile,
        oxcOptions: pluginOxcOptions,
      });

      expect(options.oxcOptions).toEqual({
        resolver: {
          alias: {
            '@bundler': ['/bundler'],
            '@config': ['/config'],
            '@shared': ['/from-config'],
          },
          tsconfig: 'auto',
        },
        transform: { fromConfig: true },
      });
    });

    it('adds the bundler aliases when the config file sets no aliases', () => {
      const configFile = writeConfig({
        oxcOptions: { transform: { fromConfig: true } },
      });

      const options = loadWywOptions({
        configFile,
        oxcOptions: pluginOxcOptions,
      });

      expect(options.oxcOptions).toEqual({
        resolver: { alias: pluginOxcOptions.resolver.alias },
        transform: { fromConfig: true },
      });
    });

    it('lets the native resolver see the bundler aliases', () => {
      const realRoot = realpathSync(root);
      const target = path.join(realRoot, 'src', 'tokens.ts');
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, 'export const token = true;\n');
      const configFile = writeConfig({
        oxcOptions: { resolver: { tsconfig: 'auto' } },
      });

      const options = loadWywOptions({
        configFile,
        oxcOptions: { resolver: { alias: { '@tokens': [target] } } },
      });

      expect(
        resolveWithNativeResolver({
          extensions: options.extensions,
          importer: path.join(realRoot, 'src', 'entry.ts'),
          kind: 'import',
          oxcOptions: options.oxcOptions,
          specifier: '@tokens',
        })
      ).toBe(target);
    });

    it('keeps the plugin oxcOptions when the config file has none', () => {
      const configFile = writeConfig({ displayName: true });

      const options = loadWywOptions({
        configFile,
        oxcOptions: pluginOxcOptions,
      });

      expect(options.oxcOptions).toBe(pluginOxcOptions);
    });
  });

  it('gives the eval defaults to options that skipped loadWywOptions', () => {
    expect(
      getEvalOptions({
        options: {
          pluginOptions: {
            eval: {
              errors: undefined,
              require: undefined,
              resolver: undefined,
            },
          },
        },
      })
    ).toEqual({
      errors: 'strict',
      require: 'warn-and-run',
      resolver: 'bundler',
    });
  });
});
