import { EventEmitter } from 'events';

import { createWriteQueue } from '../eval/writeQueue';

class MockWritable extends EventEmitter {
  public readonly writes: string[] = [];

  private readonly callbacks: Array<
    ((error?: Error | null) => void) | undefined
  > = [];

  public completeWrite(index: number, error?: Error) {
    this.callbacks[index]?.(error ?? null);
  }

  public write(chunk: string, callback?: (error?: Error | null) => void) {
    this.writes.push(chunk);
    this.callbacks.push(callback);
    return true;
  }
}

describe('write queue after a failed write', () => {
  it('rejects later writes and onIdle with the error of the failed write', async () => {
    const stream = new MockWritable();
    const error = new Error('write EPIPE');
    const queue = createWriteQueue(stream, 'test stream');
    const failedWrite = queue.write('payload').then(
      () => 'resolved',
      (reason: unknown) => reason
    );

    await Promise.resolve();
    stream.completeWrite(0, error);
    stream.emit('error', error);

    expect(await failedWrite).toBe(error);

    const laterWrite = await queue.write('x').then(
      () => 'resolved',
      (reason: unknown) => reason
    );
    const idle = await queue.onIdle().then(
      () => 'resolved',
      (reason: unknown) => reason
    );

    expect(laterWrite).toBe(error);
    expect(idle).toBe(error);
    expect(stream.writes).toEqual(['payload']);
  });
});
