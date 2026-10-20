// Starts a Vite dev server in middleware mode (no httpServer, as Storybook and
// test harnesses run it) with the wyw-in-js plugin and the given plugin
// options, transforms src/index.js of the working directory, closes the server
// and prints how many eval runner processes of this process were alive before
// and after the close. The dev-server-close test runs it in its own process,
// like the build-watch fixture.
import { execFileSync } from 'child_process';
import path from 'path';

import { createServer } from 'vite';

import wywInJS from '../../index';

const EXIT_WAIT_MS = 5_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const evalRunners = (): number =>
  execFileSync('ps', ['-A', '-o', 'ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter(
      (line) =>
        line.includes('eval/runner') &&
        line.trim().split(/\s+/)[0] === String(process.pid)
    ).length;

const run = async () => {
  // Idle transform workers are unref'd: without a handle of its own the
  // process could end while it awaits their disposal.
  const keepAlive = setInterval(() => {}, 1_000);
  const options = JSON.parse(process.argv[2] ?? '{}');
  const root = process.cwd();
  const server = await createServer({
    root,
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false },
    plugins: [
      wywInJS({
        configFile: path.join(root, 'wyw-in-js.config.cjs'),
        ...options,
      }),
    ],
  });

  const result = await server.transformRequest('/src/index.js');
  const before = evalRunners();
  await server.close();

  let after = evalRunners();
  for (let waited = 0; after > 0 && waited < EXIT_WAIT_MS; waited += 100) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(100);
    after = evalRunners();
  }

  clearInterval(keepAlive);
  process.stdout.write(
    JSON.stringify({
      after,
      before,
      transformed: Boolean(result && !result.code.includes('css`')),
    }),
    // An eval runner left behind keeps the process alive: end it here.
    () => process.exit(0)
  );
};

run().catch((error) => {
  process.stderr.write(String(error?.stack ?? error), () => process.exit(1));
});
