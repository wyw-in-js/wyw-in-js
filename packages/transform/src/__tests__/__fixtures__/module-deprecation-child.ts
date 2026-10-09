/**
 * Runs in a separate process spawned by module-deprecation.test.ts, so the
 * once-per-process deprecation state starts fresh. Prints a JSON report.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  disposeEvalBroker,
  Entrypoint,
  loadWywOptions,
  Module,
  transform,
  TransformCacheCollection,
  withDefaultServices,
} from '../../index';

const processorFile = path.resolve(__dirname, 'test-css-processor.js');

const warnings: { code?: string; message: string; name: string }[] = [];
process.on('warning', (warning: Error & { code?: string }) => {
  warnings.push({
    code: warning.code,
    message: warning.message,
    name: warning.name,
  });
});

const flushWarnings = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const runTransform = async (root: string) => {
  const tokensFile = path.join(root, 'tokens.ts');
  const filename = path.join(root, 'component.ts');
  fs.writeFileSync(
    tokensFile,
    `export const colors = (() => ({ blue: 'blue' }))();\n`
  );
  const code = [
    `import { css } from 'test-css-processor';`,
    `import { colors } from './tokens';`,
    'export const className = css`color: ${colors.blue};`;',
  ].join('\n');

  const cache = new TransformCacheCollection();
  try {
    const result = await transform(
      {
        cache,
        options: {
          filename,
          root,
          pluginOptions: {
            configFile: false,
            tagResolver: (source: string, tag: string) =>
              source === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
          },
        },
      },
      code,
      async (what, importer) =>
        what === 'test-css-processor'
          ? processorFile
          : `${path.resolve(path.dirname(importer), what)}.ts`
    );
    return result.cssText ?? '';
  } finally {
    disposeEvalBroker(cache);
  }
};

const constructModule = (filename: string) => {
  const services = withDefaultServices({
    options: {
      filename,
      pluginOptions: loadWywOptions({ configFile: false }),
    },
  });
  const entrypoint = Entrypoint.createRoot(
    services,
    filename,
    ['*'],
    'export const answer = 42;'
  );

  return new Module(services, entrypoint);
};

const main = async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-module-deprecation-'))
  );

  try {
    const cssText = await runTransform(root);
    await flushWarnings();
    const afterTransform = [...warnings];

    constructModule(path.join(root, 'first.js'));
    constructModule(path.join(root, 'second.js'));
    await flushWarnings();

    process.stdout.write(
      `${JSON.stringify({
        afterModule: warnings,
        afterTransform,
        cssText,
      })}\n`
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

await main();
