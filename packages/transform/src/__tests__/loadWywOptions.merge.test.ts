/* eslint-env jest */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import { getEvalOptions } from '../utils/evalOptions';

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
