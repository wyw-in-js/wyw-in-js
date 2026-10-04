import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

import type { RawSourceMap } from 'source-map';

import type { Result } from '../types';
import type {
  MainToWorkerMessage,
  TransformWorkerScopeConfig,
  WorkerToMainMessage,
} from './protocol';
import { deserializeError, serializeError } from './protocol';
import { TransformWorkerScope } from './scope';

export type TransformWorkerPoolOptions = {
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

type JobState = {
  job: TransformWorkerJob;
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

  readonly #slots: WorkerSlot[];

  readonly #workerUrl: URL;

  // Set when a worker cannot start: every later job fails with this error.
  #broken: Error | null = null;

  #disposed: Promise<void> | null = null;

  #lastJobId = 0;

  #lastScopeId = 0;

  public constructor(options: TransformWorkerPoolOptions = {}) {
    this.#workerUrl = options.workerUrl ?? defaultWorkerUrl;
    const count = Math.max(
      1,
      Math.floor(options.workers ?? getDefaultTransformWorkerCount())
    );
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

    return new Promise<Result>((resolve, reject) => {
      this.#jobs.set(jobId, { job, reject, resolve, slot });
      slot.inFlight += 1;
      if (slot.inFlight === 1) slot.worker.ref();
      slot.worker.postMessage({
        code: job.code,
        filename: job.filename,
        inputSourceMap: job.inputSourceMap,
        jobId,
        outputFilename: job.outputFilename,
        scopeId,
        type: 'transform',
      } satisfies MainToWorkerMessage);
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
    const worker = new Worker(this.#workerUrl);
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
    slot.worker.removeAllListeners();
    slot.worker.terminate().catch(() => undefined);
    this.#slots[slot.index] = this.#spawn(slot.index, slot.assigned);
  }
}

export const createTransformWorkerPool = (
  options?: TransformWorkerPoolOptions
): TransformWorkerPool => new TransformWorkerPool(options);
