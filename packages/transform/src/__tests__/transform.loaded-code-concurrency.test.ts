import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';

const fixtureDir = path.resolve(
  __dirname,
  '../../../../e2e/vite/fixtures/loaded-code'
);
const processorFile = path.join(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);
const names = ['page', 'header', 'footer', 'button', 'icon', 'spacing'];
const sizes = [32, 24, 8, 16, 8, 8];

it('retains supplied JavaScript through concurrent and warm transforms of disk TypeScript', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-loaded-code-'));
  const cache = new TransformCacheCollection();
  const loaded = names.map((name) => {
    const source = fs
      .readFileSync(path.join(fixtureDir, `${name}.ts`), 'utf8')
      .replace('@wyw-in-js/template-tag-syntax', 'test-css-processor');
    fs.writeFileSync(path.join(root, `${name}.ts`), source);
    return source.replace(/: number/g, '');
  });
  const asyncResolve = async (specifier: string, importer: string) =>
    specifier === 'test-css-processor'
      ? processorFile
      : `${path.resolve(path.dirname(importer), specifier)}.ts`;

  const assertRound = async () => {
    const results = await Promise.all(
      names.map((name, index) =>
        transform(
          {
            cache,
            asyncResolveKey: 'loaded-code-concurrency',
            options: {
              root,
              filename: path.join(root, `${name}.ts`),
              pluginOptions: {
                configFile: false,
                tagResolver: (source, tag) =>
                  source === 'test-css-processor' && tag === 'css'
                    ? processorFile
                    : null,
                babelOptions: { babelrc: false, configFile: false },
              },
            },
          },
          loaded[index],
          asyncResolve
        )
      )
    );

    results.forEach((result, index) => {
      expect(result.code).not.toMatch(/:\s*number/);
      expect(result.code).not.toContain('css`');
      expect(result.cssText).toContain(`margin:${sizes[index]}px`);
    });
  };

  try {
    // The bundler can reach a parent before scheduling its dependencies. That
    // initial pass evaluates dependencies from disk before their JS arrives.
    await transform(
      {
        cache,
        asyncResolveKey: 'loaded-code-concurrency',
        options: {
          root,
          filename: path.join(root, 'page.ts'),
          pluginOptions: {
            configFile: false,
            tagResolver: (source, tag) =>
              source === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
            babelOptions: { babelrc: false, configFile: false },
          },
        },
      },
      loaded[0],
      asyncResolve
    );
    await assertRound();
    await assertRound();
  } finally {
    disposeEvalBroker(cache);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
