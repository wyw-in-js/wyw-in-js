import { availableParallelism } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import { Worker } from 'node:worker_threads';

import type { RawSourceMap } from 'source-map';

import type { Result } from '../types';
import { MAX_PARSE_CACHE_ENTRIES } from '../utils/parseOxc';
import type {
  MainToWorkerMessage,
  TransformWorkerData,
  TransformWorkerScopeConfig,
  WorkerToMainMessage,
} from './protocol';
import { deserializeError, serializeError } from './protocol';
import { TransformWorkerScope } from './scope';

export type TransformWorkerPoolOptions = {
  /**
   * Initial old-generation heap limit of each worker, in MB. A worker that
   * runs out of memory is replaced by one with twice the limit and its
   * transforms run again. An explicit `--max-old-space-size` overrides it.
   */
  heapLimitMb?: number;
  /** @internal Worker entry; tests replace it. */
  workerUrl?: URL;
  /** Number of worker threads. Defaults to min(4, available cores - 1). */
  workers?: number;
};

type AsyncResolve = (
  what: string,
  importer: string,
  stack: string[]
) => Promise<string | null>;

export type TransformWorkerJob = {
  /** Runs on the calling thread for every import the worker resolves. */
  asyncResolve: AsyncResolve;
  code: string;
  emitWarning?: (message: string) => void;
  filename: string;
  inputSourceMap?: RawSourceMap;
  outputFilename?: string;
};

type TransformMessage = Extract<MainToWorkerMessage, { type: 'transform' }>;

type JobState = {
  job: TransformWorkerJob;
  message: TransformMessage;
  reject: (error: Error) => void;
  resolve: (result: Result) => void;
  slot: WorkerSlot;
};

type WorkerSlot = {
  /** Files routed to this worker; breaks ties between idle workers. */
  assigned: number;
  exited: boolean;
  index: number;
  inFlight: number;
  /** Set once the worker has loaded; a worker that never does is not respawned. */
  ready: boolean;
  worker: Worker;
};

// Sources run through the TypeScript loaders in tests; builds ship JS.
const defaultWorkerUrl = new URL(
  import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js',
  import.meta.url
);

// A worker that does not exit after shutdown is terminated after this delay.
const SHUTDOWN_TIMEOUT_MS = 2000;

// Without a limit a worker heap grows toward the process limit and mostly
// holds garbage. On a large webpack app, workers stayed at 0.6-0.95 GB with
// this limit and 1.2-1.4 GB without it, at the same build time.
const DEFAULT_WORKER_HEAP_LIMIT_MB = 1536;
const MAX_WORKER_HEAP_LIMIT_MB = Math.floor(
  getHeapStatistics().heap_size_limit / 1024 / 1024
);

const isOutOfMemory = (error: Error): boolean =>
  (error as { code?: unknown }).code === 'ERR_WORKER_OUT_OF_MEMORY';

export const getDefaultTransformWorkerCount = (): number =>
  Math.max(1, Math.min(4, availableParallelism() - 1));

export class TransformWorkerPool {
  // A file always returns to the worker that transformed it first, so its
  // dependencies stay warm in that worker's cache across rebuilds.
  readonly #assignments = new Map<string, number>();

  readonly #jobs = new Map<number, JobState>();

  // Shared work inside a worker can outlive the job that started it; such
  // requests fall back to the latest resolver of the same scope.
  readonly #resolvers = new Map<number, AsyncResolve>();

  readonly #scopes = new Map<number, TransformWorkerScopeConfig>();

  readonly #parseCacheEntries: number;

  readonly #slots: WorkerSlot[];

  readonly #workerUrl: URL;

  // Set when a worker cannot start: every later job fails with this error.
  #broken: Error | null = null;

  #disposed: Promise<void> | null = null;

  #heapLimitMb: number;

  #lastJobId = 0;

  #lastScopeId = 0;

  public constructor(options: TransformWorkerPoolOptions = {}) {
    this.#workerUrl = options.workerUrl ?? defaultWorkerUrl;
    this.#heapLimitMb = Math.min(
      options.heapLimitMb ?? DEFAULT_WORKER_HEAP_LIMIT_MB,
      MAX_WORKER_HEAP_LIMIT_MB
    );
    const count = Math.max(
      1,
      Math.floor(options.workers ?? getDefaultTransformWorkerCount())
    );
    // Workers split the parsed-AST cache budget of one process, so a pool
    // keeps about as many ASTs as an in-process transform would.
    this.#parseCacheEntries = Math.ceil(MAX_PARSE_CACHE_ENTRIES / count);
    this.#slots = Array.from({ length: count }, (_, index) =>
      this.#spawn(index)
    );
  }

  public get size(): number {
    return this.#slots.length;
  }

  public createScope(config: TransformWorkerScopeConfig): TransformWorkerScope {
    this.#assertNotDisposed();
    this.#lastScopeId += 1;
    const scopeId = this.#lastScopeId;
    this.#scopes.set(scopeId, config);
    this.#broadcast({ config, scopeId, type: 'scope' });
    return new TransformWorkerScope(this, scopeId);
  }

  /** @internal */
  public runJob(scopeId: number, job: TransformWorkerJob): Promise<Result> {
    this.#assertNotDisposed();
    if (this.#broken) {
      return Promise.reject(this.#broken);
    }

    this.#lastJobId += 1;
    const jobId = this.#lastJobId;
    const slot = this.#pickSlot(job.filename);
    this.#resolvers.set(scopeId, job.asyncResolve);

    const message: TransformMessage = {
      code: job.code,
      filename: job.filename,
      inputSourceMap: job.inputSourceMap,
      jobId,
      outputFilename: job.outputFilename,
      scopeId,
      type: 'transform',
    };

    return new Promise<Result>((resolve, reject) => {
      this.#jobs.set(jobId, { job, message, reject, resolve, slot });
      slot.inFlight += 1;
      if (slot.inFlight === 1) slot.worker.ref();
      slot.worker.postMessage(message);
    });
  }

  /** @internal */
  public notifyScope(
    message: Extract<
      MainToWorkerMessage,
      { type: 'clear' | 'disposeEvalBroker' | 'disposeScope' | 'invalidate' }
    >
  ): void {
    if (this.#disposed) return;
    if (message.type === 'disposeScope') {
      this.#scopes.delete(message.scopeId);
      this.#resolvers.delete(message.scopeId);
    }
    this.#broadcast(message);
  }

  /**
   * Stops accepting jobs, lets running jobs finish, and shuts the workers
   * down together with their eval runners.
   */
  public dispose(): Promise<void> {
    this.#disposed ??= this.#shutdown();
    return this.#disposed;
  }

  async #shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.#jobs.values()].map(
        (state) =>
          new Promise<void>((settle) => {
            const { reject, resolve } = state;
            // eslint-disable-next-line no-param-reassign
            state.resolve = (result) => {
              resolve(result);
              settle();
            };
            // eslint-disable-next-line no-param-reassign
            state.reject = (error) => {
              reject(error);
              settle();
            };
          })
      )
    );

    this.#scopes.clear();
    this.#resolvers.clear();
    this.#assignments.clear();
    await Promise.all(
      this.#slots.map(({ exited, worker }) =>
        exited
          ? undefined
          : new Promise<void>((resolve) => {
              // Idle workers are unref'd; keep the process alive until they
              // have stopped their eval runners and exited.
              worker.ref();
              const timer = setTimeout(() => {
                worker.terminate().then(
                  () => resolve(),
                  () => resolve()
                );
              }, SHUTDOWN_TIMEOUT_MS);
              worker.once('exit', () => {
                clearTimeout(timer);
                resolve();
              });
              worker.postMessage({
                type: 'shutdown',
              } satisfies MainToWorkerMessage);
            })
      )
    );
  }

  #assertNotDisposed() {
    if (this.#disposed) {
      throw new Error('[wyw-in-js] transform worker pool was disposed');
    }
  }

  #broadcast(message: MainToWorkerMessage) {
    this.#slots.forEach((slot) => slot.worker.postMessage(message));
  }

  #pickSlot(filename: string): WorkerSlot {
    const assigned = this.#assignments.get(filename);
    if (assigned !== undefined) {
      return this.#slots[assigned];
    }

    const slot = this.#slots.reduce((best, candidate) =>
      candidate.inFlight < best.inFlight ||
      (candidate.inFlight === best.inFlight &&
        candidate.assigned < best.assigned)
        ? candidate
        : best
    );
    slot.assigned += 1;
    this.#assignments.set(filename, slot.index);
    return slot;
  }

  #spawn(index: number, assigned = 0): WorkerSlot {
    const worker = new Worker(this.#workerUrl, {
      resourceLimits: { maxOldGenerationSizeMb: this.#heapLimitMb },
      workerData: {
        parseCacheEntries: this.#parseCacheEntries,
      } satisfies TransformWorkerData,
    });
    // An idle pool must not keep the process alive; jobs re-ref their worker.
    worker.unref();
    const slot: WorkerSlot = {
      assigned,
      exited: false,
      index,
      inFlight: 0,
      ready: false,
      worker,
    };
    worker.on('message', (message: WorkerToMainMessage) =>
      this.#onMessage(slot, message)
    );
    worker.on('error', (error) => this.#onWorkerFailure(slot, error));
    worker.on('exit', (code) => {
      slot.exited = true;
      if (!this.#disposed) {
        this.#onWorkerFailure(
          slot,
          new Error(`[wyw-in-js] transform worker exited with code ${code}`)
        );
      }
    });
    this.#scopes.forEach((config, scopeId) =>
      worker.postMessage({
        config,
        scopeId,
        type: 'scope',
      } satisfies MainToWorkerMessage)
    );
    return slot;
  }

  #finishJob(jobId: number): JobState | undefined {
    const state = this.#jobs.get(jobId);
    if (!state) return undefined;
    this.#jobs.delete(jobId);
    state.slot.inFlight -= 1;
    if (state.slot.inFlight === 0) state.slot.worker.unref();
    return state;
  }

  #onMessage(slot: WorkerSlot, message: WorkerToMainMessage) {
    switch (message.type) {
      case 'resolve': {
        const reply = (
          payload: Pick<
            Extract<MainToWorkerMessage, { type: 'resolved' }>,
            'error' | 'result'
          >
        ) =>
          slot.worker.postMessage({
            ...payload,
            requestId: message.requestId,
            type: 'resolved',
          } satisfies MainToWorkerMessage);
        const asyncResolve =
          this.#jobs.get(message.jobId)?.job.asyncResolve ??
          this.#resolvers.get(message.scopeId);
        if (!asyncResolve) {
          reply({
            error: serializeError(
              new Error(`Cannot resolve ${message.what}: the scope is disposed`)
            ),
          });
          return;
        }

        Promise.resolve()
          .then(() =>
            asyncResolve(message.what, message.importer, message.stack)
          )
          .then(
            (result) => reply({ result }),
            (error) => reply({ error: serializeError(error) })
          );
        return;
      }
      case 'warning': {
        const state = this.#jobs.get(message.jobId);
        if (state?.job.emitWarning) state.job.emitWarning(message.message);
        // eslint-disable-next-line no-console
        else console.warn(message.message);
        return;
      }
      case 'done': {
        const state = this.#finishJob(message.jobId);
        if (!state) return;
        if (message.error) state.reject(deserializeError(message.error));
        else state.resolve(message.result!);
        break;
      }
      case 'ready':
        // eslint-disable-next-line no-param-reassign
        slot.ready = true;
        break;
      default:
        break;
    }
  }

  #onWorkerFailure(slot: WorkerSlot, error: Error) {
    if (this.#slots[slot.index] !== slot) return;
    // A worker that ran out of memory comes back with twice the heap limit
    // and runs its transforms again, so a low default never fails a build.
    if (
      !this.#disposed &&
      isOutOfMemory(error) &&
      this.#heapLimitMb < MAX_WORKER_HEAP_LIMIT_MB
    ) {
      this.#heapLimitMb = Math.min(
        this.#heapLimitMb * 2,
        MAX_WORKER_HEAP_LIMIT_MB
      );
      const replacement = this.#replace(slot);
      this.#jobs.forEach((state) => {
        if (state.slot !== slot) return;
        // eslint-disable-next-line no-param-reassign
        state.slot = replacement;
        replacement.inFlight += 1;
        if (replacement.inFlight === 1) replacement.worker.ref();
        replacement.worker.postMessage(state.message);
      });
      return;
    }

    // A worker that fails before it has loaded would fail again: stop here
    // instead of respawning it in a loop.
    if (!slot.ready && !this.#broken) {
      this.#broken = new Error(
        `[wyw-in-js] transform worker failed to start: ${error.message}`,
        { cause: error }
      );
    }

    const failure = slot.ready ? error : this.#broken ?? error;
    [...this.#jobs.entries()].forEach(([jobId, state]) => {
      if (!this.#broken && state.slot !== slot) return;
      this.#finishJob(jobId);
      state.reject(failure);
    });
    if (this.#disposed || this.#broken) return;
    this.#replace(slot);
  }

  #replace(slot: WorkerSlot): WorkerSlot {
    slot.worker.removeAllListeners();
    slot.worker.terminate().catch(() => undefined);
    const replacement = this.#spawn(slot.index, slot.assigned);
    this.#slots[slot.index] = replacement;
    return replacement;
  }
}

export const createTransformWorkerPool = (
  options?: TransformWorkerPoolOptions
): TransformWorkerPool => new TransformWorkerPool(options);
