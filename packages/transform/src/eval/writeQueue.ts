type StreamWriteCallback = (error?: Error | null) => void;

type QueueWritable = {
  off(
    event: 'close' | 'drain' | 'error',
    listener: (...args: unknown[]) => void
  ): void;
  once(
    event: 'close' | 'drain' | 'error',
    listener: (...args: unknown[]) => void
  ): void;
  write(chunk: string, callback?: StreamWriteCallback): boolean;
};

export type WriteQueue = {
  onIdle(): Promise<void>;
  write(chunk: string): Promise<void>;
};

const normalizeWriteError = (label: string, error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }

  return new Error(`[wyw-in-js] Failed to write to ${label}: ${String(error)}`);
};

export const writeToStream = (
  stream: QueueWritable,
  chunk: string,
  label: string
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let settled = false;
    let writeCompleted = false;
    let drainCompleted = true;
    let onClose: () => void;
    let onDrain: () => void;
    let onError: (error: unknown) => void;

    const removeSettleListeners = () => {
      stream.off('close', onClose);
      stream.off('drain', onDrain);
    };

    const cleanup = () => {
      removeSettleListeners();
      stream.off('error', onError);
    };

    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }

      if (error) {
        settled = true;
        // A Node writable passes a write error to the callback first and
        // emits 'error' after it, so the `once` listener stays to take that
        // event instead of leaving it unhandled.
        removeSettleListeners();
        reject(normalizeWriteError(label, error));
        return;
      }

      if (!writeCompleted || !drainCompleted) {
        return;
      }

      settled = true;
      cleanup();
      resolve();
    };

    onClose = () => {
      finish(new Error(`${label} closed before pending write completed`));
    };

    onDrain = () => {
      drainCompleted = true;
      finish();
    };

    onError = (error: unknown) => {
      finish(error);
    };

    stream.once('close', onClose);
    stream.once('error', onError);

    const needsDrain = !stream.write(chunk, (error) => {
      writeCompleted = true;
      if (error) {
        finish(error);
        return;
      }

      finish();
    });

    if (needsDrain) {
      drainCompleted = false;
      stream.once('drain', onDrain);
    }
  });

export const createWriteQueue = (
  stream: QueueWritable,
  label: string
): WriteQueue => {
  let failed: Error | null = null;
  let tail = Promise.resolve();

  return {
    onIdle() {
      return tail;
    },
    write(chunk: string) {
      if (failed) {
        return Promise.reject(failed);
      }

      const task = tail.then(() => writeToStream(stream, chunk, label));

      tail = task.catch((error) => {
        failed = normalizeWriteError(label, error);
        throw failed;
      });
      // Callers handle `task` and rarely await `onIdle()`, so a failed `tail`
      // must not be reported as an unhandled rejection.
      tail.catch(() => undefined);

      return task;
    },
  };
};
