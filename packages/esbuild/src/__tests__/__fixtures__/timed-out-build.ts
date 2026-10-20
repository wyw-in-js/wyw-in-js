import * as esbuild from 'esbuild';

// Run by esbuild-service.test.ts in a separate `bun test`: the first test
// times out while its build waits in a plugin, the second one needs esbuild.

// The second test may release the build before esbuild asks the plugin.
let release = () => {};
const released = new Promise<void>((resolve) => {
  release = resolve;
});

it('times out while esbuild builds', async () => {
  await esbuild.build({
    stdin: { contents: `import 'held';` },
    bundle: true,
    logLevel: 'silent',
    write: false,
    plugins: [
      {
        name: 'hold',
        setup(build) {
          build.onResolve({ filter: /^held$/ }, async () => {
            await released;
            return { path: 'held', namespace: 'held' };
          });
          build.onLoad({ filter: /.*/, namespace: 'held' }, () => ({
            contents: '',
          }));
        },
      },
    ],
  });
}, 100);

it('builds after the timed-out test', async () => {
  release();
  const result = await esbuild.transform('export const a = 1;');
  expect(result.code).toContain('a = 1');
});
