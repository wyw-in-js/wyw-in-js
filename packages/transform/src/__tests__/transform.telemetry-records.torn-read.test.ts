import { spawnSync } from 'child_process';
import path from 'path';

const preload = path.join(
  __dirname,
  '__fixtures__',
  'telemetry-records-torn-read.ts'
);

// The file reporter writes the records of pipeline-telemetry.jsonl through an
// async stream after `onDone`, so a test that polls the file can read it in
// the middle of that write. The preload makes the reads of a child run of the
// telemetry records test meet the write that way every time; the test has to
// wait for complete records instead of parsing a part of one.
describe('transform telemetry records test', () => {
  it('waits for complete records when its reads meet the records write', () => {
    const result = spawnSync(
      process.execPath,
      [
        'test',
        '--preload',
        preload,
        './transform.telemetry-records.test.ts',
        '-t',
        'records the physical eval preparation stages of an observed root',
      ],
      { cwd: __dirname, encoding: 'utf8' }
    );

    expect(result.stderr).not.toContain('JSON Parse error');
    expect(result.status).toBe(0);
    const replayedReads = Number(
      /reads that met the records write: (\d+)/.exec(result.stdout)?.[1]
    );
    expect(replayedReads).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
