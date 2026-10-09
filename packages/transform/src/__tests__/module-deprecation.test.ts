import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type ReportedWarning = { code?: string; message: string; name: string };

type ChildReport = {
  afterModule: ReportedWarning[];
  afterTransform: ReportedWarning[];
  cssText: string;
};

const childScript = path.join(
  __dirname,
  '__fixtures__',
  'module-deprecation-child.ts'
);

// The warning is emitted once per process, and the test runner shares one
// process between test files, so the scenario runs in a fresh child process.
const runChild = async (): Promise<ChildReport> => {
  const { stdout } = await execFileAsync(process.execPath, [childScript], {
    cwd: path.resolve(__dirname, '..', '..'),
  });
  const lines = stdout.trim().split('\n');

  return JSON.parse(lines[lines.length - 1]) as ChildReport;
};

describe('Module deprecation', () => {
  it('warns once per process when Module is constructed, and transform() does not warn', async () => {
    const report = await runChild();

    expect(report.cssText).toContain('color:blue');
    expect(report.afterTransform).toEqual([]);
    expect(report.afterModule).toHaveLength(1);
    expect(report.afterModule[0]).toMatchObject({
      code: 'WYW_MODULE_DEPRECATED',
      name: 'DeprecationWarning',
    });
    expect(report.afterModule[0].message).toContain('3.0');
  }, 60_000);
});
