import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const testFiles = fs
  .readdirSync(__dirname)
  .filter(
    (file) => file.endsWith('.test.ts') && file !== path.basename(__filename)
  )
  .sort();

// `bun test src` runs every test file of the package in one process, and the
// order of the files differs between machines. A module mock registered by
// one file stays in effect for the files after it, so each file has to pass
// when it is the first one, in a fresh child process.
describe('bun test files', () => {
  it.each(testFiles)(
    '%s passes when run on its own',
    (file) => {
      const result = spawnSync(process.execPath, ['test', `./${file}`], {
        cwd: __dirname,
        encoding: 'utf8',
      });

      expect(result.stderr).not.toContain('(fail)');
      expect(result.status).toBe(0);
    },
    30_000
  );
});
