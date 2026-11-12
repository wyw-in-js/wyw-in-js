import { spawnSync } from 'child_process';
import path from 'path';

const packageRoot = path.resolve(__dirname, '..', '..');

/**
 * Every test file of this package mocks `@wyw-in-js/transform` with a factory
 * of its own, while bun runs them all in one process. Run a few of them in a
 * fixed order in a child `bun test` so that a mock of one file cannot decide
 * the outcome of the tests of another.
 */
const runTestFiles = (files: string[]) =>
  spawnSync(
    process.execPath,
    ['test', ...files.map((file) => `./src/__tests__/${file}`)],
    { cwd: packageRoot, encoding: 'utf8', timeout: 60_000 }
  );

describe('vite tests in any file order', () => {
  it('pass when resolve-id-query runs before the eval broker tests', () => {
    const result = runTestFiles([
      'resolve-id-query.test.ts',
      'hmr.test.ts',
      'build-watch-dispose.test.ts',
    ]);
    const output = `${result.stdout}${result.stderr}`;
    const failed = output
      .split('\n')
      .filter((line) => line.startsWith('(fail)'))
      .map((line) => line.replace(/ \[[\d.]+m?s\]$/, ''));

    expect(result.error).toBeUndefined();
    expect(failed).toEqual([]);
    expect(output).toMatch(/\b[1-9]\d* pass\b/);
    expect(output).toMatch(/\b0 fail\b/);
    expect(result.status).toBe(0);
  }, 60_000);
});
