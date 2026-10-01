import fs from 'fs';
import os from 'os';
import path from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker, EvalBroker } from '../eval/broker';
import { transform } from '../transform';

const processorFile = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const observeBrokers = () => {
  const brokers = new Set<EvalBroker>();
  const originalEvaluate = EvalBroker.prototype.evaluate;
  const spy = jest
    .spyOn(EvalBroker.prototype, 'evaluate')
    .mockImplementation(function captureBroker(this: EvalBroker, ...args) {
      brokers.add(this);
      return originalEvaluate.apply(this, args);
    });
  return { brokers, restore: () => spy.mockRestore() };
};

const setup = () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-local-cache-broker-'))
  );
  const tokensFile = path.join(root, 'tokens.ts');
  fs.writeFileSync(
    tokensFile,
    `export const colors = (() => ({ blue: 'blue' }))();\n`
  );
  const files = [0, 1, 2].map((index) => {
    const filename = path.join(root, `component-${index}.ts`);
    fs.writeFileSync(
      filename,
      dedent`
        import { css } from 'test-css-processor';
        import { colors } from './tokens';

        export const className = css\`
          color: \${colors.blue};
        \`;
      `
    );
    return filename;
  });

  const asyncResolve = async (what: string, importer: string) => {
    if (what === 'test-css-processor') {
      return processorFile;
    }
    return `${path.resolve(path.dirname(importer), what)}.ts`;
  };

  const pluginOptions = (globalCache: boolean) => ({
    configFile: false as const,
    features: { globalCache },
    tagResolver: (source: string, tag: string) =>
      source === 'test-css-processor' && tag === 'css' ? processorFile : null,
    babelOptions: {
      babelrc: false,
      configFile: false,
      presets: [
        ['@babel/preset-env', { loose: true }],
        '@babel/preset-typescript',
      ],
    },
  });

  return { root, files, asyncResolve, pluginOptions };
};

describe('eval broker of a transform-owned cache', () => {
  it('is disposed with the transform when globalCache is off', async () => {
    const { root, files, asyncResolve, pluginOptions } = setup();
    const cache = new TransformCacheCollection();
    const { brokers, restore } = observeBrokers();

    try {
      const results = await Promise.all(
        files.map((filename) =>
          transform(
            {
              asyncResolveKey: 'local-cache-broker-test',
              cache,
              options: { filename, root, pluginOptions: pluginOptions(false) },
            },
            fs.readFileSync(filename, 'utf8'),
            asyncResolve
          )
        )
      );

      for (const result of results) {
        expect(result.cssText).toContain('color:blue;');
      }
      expect(brokers.size).toBe(files.length);
      expect([...brokers].map((broker) => broker.isDisposed)).toEqual(
        files.map(() => true)
      );
    } finally {
      restore();
      disposeEvalBroker(cache);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is disposed with the transform when the caller passes no cache', async () => {
    const { root, files, asyncResolve, pluginOptions } = setup();
    const { brokers, restore } = observeBrokers();

    try {
      const result = await transform(
        {
          options: {
            filename: files[0],
            root,
            pluginOptions: pluginOptions(true),
          },
        },
        fs.readFileSync(files[0], 'utf8'),
        asyncResolve
      );

      expect(result.cssText).toContain('color:blue;');
      expect([...brokers].map((broker) => broker.isDisposed)).toEqual([true]);
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the broker of a caller-owned cache alive across transforms', async () => {
    const { root, files, asyncResolve, pluginOptions } = setup();
    const cache = new TransformCacheCollection();
    const { brokers, restore } = observeBrokers();

    try {
      for (const filename of files) {
        // eslint-disable-next-line no-await-in-loop
        const result = await transform(
          {
            asyncResolveKey: 'local-cache-broker-test',
            cache,
            options: { filename, root, pluginOptions: pluginOptions(true) },
          },
          fs.readFileSync(filename, 'utf8'),
          asyncResolve
        );
        expect(result.cssText).toContain('color:blue;');
      }

      expect([...brokers].map((broker) => broker.isDisposed)).toEqual([false]);

      disposeEvalBroker(cache);
      expect([...brokers].map((broker) => broker.isDisposed)).toEqual([true]);
    } finally {
      restore();
      disposeEvalBroker(cache);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
