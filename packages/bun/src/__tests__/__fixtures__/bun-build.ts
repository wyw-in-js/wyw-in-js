// Bundles src/index.js of the working directory with the wyw-in-js plugin and
// prints the emitted CSS as JSON. The test runs it in its own process:
// `jest.mock` in bun is process-wide, so the transform mock of other test
// files in this package would otherwise reach the plugin.
import path from 'path';

import wywInJS from '../../index';

const run = async () => {
  // Bun.build does not keep the process alive while the plugin waits for an
  // idle (unref'd) worker thread: hold it open until the build is done.
  const keepAlive = setInterval(() => {}, 1_000);
  const root = process.cwd();
  const parallel = process.argv[2] ? Number(process.argv[2]) : undefined;

  const result = await Bun.build({
    entrypoints: [path.join(root, 'src', 'index.js')],
    external: ['test-css-processor'],
    plugins: [
      wywInJS({
        configFile: path.join(root, 'wyw-in-js.config.cjs'),
        parallel,
      }),
    ],
  }).finally(() => clearInterval(keepAlive));

  if (!result.success) {
    throw new AggregateError(result.logs, 'Bun.build failed');
  }

  const css = await Promise.all(
    result.outputs
      .filter((output) => output.path.endsWith('.css'))
      .map((output) => output.text())
  );

  process.stdout.write(JSON.stringify(css));
};

run().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exitCode = 1;
});
