// Bundles src/index.js of the working directory with the wyw-in-js plugin and
// prints the emitted CSS modules as JSON. The parity test runs it in its own
// process: `jest.mock` in bun is process-wide, so the transform mock of other
// test files in this package would otherwise reach the plugin.
import path from 'path';

import { rollup } from 'rollup';

import wywInJS from '../../index';

type Options = Omit<Parameters<typeof wywInJS>[0], 'keepComments'> & {
  keepComments?: boolean;
  keepCommentsPattern?: string;
};

const run = async () => {
  const { keepCommentsPattern, ...options }: Options = JSON.parse(
    process.argv[2] ?? '{}'
  );
  // Class names are derived from the path relative to the working directory,
  // which is --source-root for the CLI.
  const root = process.cwd();
  const css: string[] = [];

  const bundle = await rollup({
    input: path.join(root, 'src', 'index.js'),
    external: ['test-css-processor'],
    plugins: [
      wywInJS({
        configFile: path.join(root, 'wyw-in-js.config.cjs'),
        ...options,
        ...(keepCommentsPattern
          ? { keepComments: new RegExp(keepCommentsPattern) }
          : {}),
      }),
      {
        name: 'capture-css',
        transform(code, id) {
          if (!id.endsWith('.css')) return null;
          css.push(code);
          return { code: 'export {};', map: null };
        },
      },
    ],
  });

  await bundle.generate({ format: 'esm' });
  await bundle.close();

  process.stdout.write(JSON.stringify(css));
};

run().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exitCode = 1;
});
