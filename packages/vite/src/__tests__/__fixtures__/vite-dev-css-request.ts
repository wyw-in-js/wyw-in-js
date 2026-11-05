// Starts a Vite dev server in middleware mode with the wyw-in-js plugin,
// transforms src/index.js of the working directory, requests the CSS file it
// generated with the `?direct` query (as Vite does for a stylesheet the
// browser fetches) and without it (as a JavaScript import does), closes the
// server and prints both results. The dev-server-css-request test runs it in
// its own process, like the dev-server-close fixture.
import path from 'path';

import { createServer } from 'vite';

import wywInJS from '../../index';

const run = async () => {
  const root = process.cwd();
  const server = await createServer({
    root,
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false },
    plugins: [wywInJS({ configFile: path.join(root, 'wyw-in-js.config.cjs') })],
  });

  let report: { direct: string | null; module: string | null };
  try {
    await server.transformRequest('/src/index.js');
    const direct = await server.transformRequest(
      '/src/index.wyw-in-js.css?direct'
    );
    const module = await server.transformRequest('/src/index.wyw-in-js.css');
    report = { direct: direct?.code ?? null, module: module?.code ?? null };
  } finally {
    await server.close();
  }

  process.stdout.write(JSON.stringify(report), () => process.exit(0));
};

run().catch((error) => {
  process.stderr.write(String(error?.stack ?? error), () => process.exit(1));
});
