import { spawn } from 'child_process';
import path from 'path';

const packageRoot = path.resolve(__dirname, '../..');

/** Runs `bun test` on `file` from the package root, with its bunfig.toml. */
const runBunTest = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['test', file], {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', () => resolve(output));
  });

it('keeps the esbuild service for the tests after a timed-out test', async () => {
  const output = await runBunTest(
    './src/__tests__/__fixtures__/timed-out-build.ts'
  );

  expect(output).toContain('(fail) times out while esbuild builds');
  expect(output).not.toContain('(fail) builds after the timed-out test');
  expect(output).toMatch(/\b1 pass\b/);
});
