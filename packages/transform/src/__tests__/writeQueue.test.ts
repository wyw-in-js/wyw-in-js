import { spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { pathToFileURL } from 'url';

import { createWriteQueue, writeToStream } from '../eval/writeQueue';

const writeQueueUrl = pathToFileURL(
  path.join(__dirname, '..', 'eval', 'writeQueue.ts')
).href;

// Under bun a write to the stdin of a killed child does not fail, so the
// scenario runs in a separate Node process, where the failed write calls its
// callback before the stream emits 'error'.
const killedReaderScenario = `
import { spawn } from 'child_process';
import { createWriteQueue } from ${JSON.stringify(writeQueueUrl)};

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: ['pipe', 'ignore', 'ignore'],
});
const queue = createWriteQueue(child.stdin, 'child stdin');
const written = queue.write('x'.repeat(1024 * 1024));
child.kill('SIGKILL');

await written.then(
  () => console.log('write resolved'),
  (error) => console.log(\`write rejected: \${error instanceof Error}\`)
);
console.log('survived');
`;

class MockWritable extends EventEmitter {
  public readonly writes: string[] = [];

  private readonly returnValues: boolean[] = [];

  private readonly callbacks: Array<
    ((error?: Error | null) => void) | undefined
  > = [];

  public pushWriteResult(returnValue: boolean) {
    this.returnValues.push(returnValue);
  }

  public completeWrite(index: number, error?: Error) {
    this.callbacks[index]?.(error ?? null);
  }

  public write(chunk: string, callback?: (error?: Error | null) => void) {
    this.writes.push(chunk);
    this.callbacks.push(callback);
    return this.returnValues.shift() ?? true;
  }
}

describe('write queue', () => {
  it('waits for drain after a backpressured write', async () => {
    const stream = new MockWritable();
    stream.pushWriteResult(false);

    let settled = false;
    const task = writeToStream(stream, 'payload', 'test stream').then(() => {
      settled = true;
    });

    expect(stream.writes).toEqual(['payload']);

    stream.completeWrite(0);
    await Promise.resolve();
    expect(settled).toBe(false);

    stream.emit('drain');
    await task;

    expect(settled).toBe(true);
  });

  it('serializes queued writes across backpressure boundaries', async () => {
    const stream = new MockWritable();
    stream.pushWriteResult(false);
    stream.pushWriteResult(true);

    const queue = createWriteQueue(stream, 'test stream');
    const first = queue.write('first');
    const second = queue.write('second');

    await Promise.resolve();
    expect(stream.writes).toEqual(['first']);

    stream.completeWrite(0);
    await Promise.resolve();
    expect(stream.writes).toEqual(['first']);

    stream.emit('drain');
    await first;
    await Promise.resolve();
    expect(stream.writes).toEqual(['first', 'second']);

    stream.completeWrite(1);
    await Promise.all([second, queue.onIdle()]);
  });

  it('rejects without throwing when the stream emits the error after the write callback', async () => {
    const stream = new MockWritable();
    const error = new Error('write EPIPE');
    const outcome = writeToStream(stream, 'payload', 'test stream').then(
      () => 'resolved',
      (reason: unknown) => reason
    );

    stream.completeWrite(0, error);

    expect(() => stream.emit('error', error)).not.toThrow();
    expect(await outcome).toBe(error);
  });

  // bun fails the test on an unhandled rejection.
  it('leaves no unhandled rejection after a failed write', async () => {
    const stream = new MockWritable();
    const error = new Error('write EPIPE');
    const queue = createWriteQueue(stream, 'test stream');
    const outcome = queue.write('payload').then(
      () => 'resolved',
      (reason: unknown) => reason
    );

    await Promise.resolve();
    stream.completeWrite(0, error);

    expect(await outcome).toBe(error);
  });

  it('survives a reader that is killed during a large write', () => {
    const nodeBinary = process.env.WYW_NODE_BINARY || 'node';
    const result = spawnSync(
      nodeBinary,
      [
        '--no-warnings',
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        killedReaderScenario,
      ],
      { encoding: 'utf8', timeout: 30_000 }
    );

    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('write rejected: true\nsurvived\n');
    expect(result.status).toBe(0);
  });
});
