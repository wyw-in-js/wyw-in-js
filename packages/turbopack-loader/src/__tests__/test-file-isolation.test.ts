import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const packageRoot = path.resolve(__dirname, '..', '..');

const testFiles = fs
  .readdirSync(__dirname)
  .filter(
    (file) => file.endsWith('.test.ts') && file !== path.basename(__filename)
  )
  .sort();

/**
 * `bun test src` runs every test file of this package in one process, and the
 * order of the files differs between machines. The test files mock
 * `@wyw-in-js/transform` and `@wyw-in-js/shared` with factories of their
 * own, and a module mock registered by one file stays in effect for the files
 * after it. Run the files in a child `bun test` together in both orders and
 * each on its own, so that the outcome of a test cannot depend on which files
 * ran before it.
 */
const expectTestFilesToPass = (files: string[]) => {
  if (files.length === 0) {
    throw new Error('No test files to run');
  }

  const result = spawnSync(
    process.execPath,
    ['test', ...files.map((file) => `./src/__tests__/${file}`)],
    { cwd: packageRoot, encoding: 'utf8', timeout: 110_000 }
  );
  const output = `${result.stdout}${result.stderr}`;
  const failed = output
    .split('\n')
    .filter((line) => line.includes('(fail)'))
    .map((line) => line.replace(/ \[[\d.]+m?s\]$/, ''));

  expect(result.error).toBeUndefined();
  expect(failed).toEqual([]);
  expect(output).toMatch(/\b[1-9]\d* pass\b/);
  expect(output).toMatch(/\b0 fail\b/);
  expect(output).toMatch(new RegExp(`\\bacross ${files.length} files?\\b`));
  expect(result.status).toBe(0);
};

describe('turbopack-loader test files', () => {
  it('include more than one file besides this one', () => {
    expect(testFiles.length).toBeGreaterThan(1);
  });

  it('pass when run together in sorted order', () => {
    expectTestFilesToPass(testFiles);
  }, 120_000);

  it('pass when run together in reverse order', () => {
    expectTestFilesToPass([...testFiles].reverse());
  }, 120_000);

  it.each(testFiles)(
    '%s passes when run on its own',
    (file) => {
      expectTestFilesToPass([file]);
    },
    120_000
  );
});
