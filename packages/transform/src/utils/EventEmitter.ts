export type OnEvent = (
  labels: Record<string, unknown>,
  type: 'start' | 'finish' | 'single',
  event?: unknown
) => void;

export type DebugEventType = 'staticPlan';

export interface EventEmitterOptions {
  /**
   * Lazily produced debug events consumed by `onEvent`. This is a producer
   * hint and does not filter events passed directly to `single()`. Omit it to
   * preserve the legacy behavior, where every debug event is assumed to have
   * a listener.
   */
  debugEvents?: readonly DebugEventType[];
}

export interface IActionCreated {
  actionIdx: string;
  actionType: string;
  type: 'actionCreated';
}

export interface ICreatedEvent {
  class: string;
  evaluatedOnly: string[];
  filename: string;
  generation: number;
  idx: string;
  isExportsInherited: boolean;
  only: string[];
  parentId: number | null;
  type: 'created';
}

export interface ISupersededEvent {
  type: 'superseded';
  with: number;
}

export interface ISetTransformResultEvent {
  isNull: boolean;
  type: 'setTransformResult';
}

export type EntrypointEvent =
  | IActionCreated
  | ICreatedEvent
  | ISupersededEvent
  | ISetTransformResultEvent;

export type OnEntrypointEvent = (
  idx: number,
  timestamp: number,
  event: EntrypointEvent
) => void;

export type OnActionStartArgs = [
  phase: 'start',
  timestamp: number,
  type: string,
  idx: string,
  entrypointRef: string,
];

export type OnActionFinishArgs = [
  phase: 'finish' | 'fail',
  timestamp: number,
  id: number,
  isAsync: boolean,
  error?: unknown,
];

export const isOnActionStartArgs = (
  args: OnActionStartArgs | OnActionFinishArgs
): args is OnActionStartArgs => {
  return args[0] === 'start';
};

export const isOnActionFinishArgs = (
  args: OnActionStartArgs | OnActionFinishArgs
): args is OnActionFinishArgs => {
  return args[0] === 'finish' || args[0] === 'fail';
};

export interface OnAction {
  (...args: OnActionStartArgs): number;
  (...args: OnActionFinishArgs): void;
}

type PerfStatus = 'failed' | 'finished';

type PerfStartEvent = {
  method: string;
  spanId: number;
  startedAt: number;
  type: 'perf-span-start';
};

export type PerfFinishEvent = {
  durationMs: number;
  error?: unknown;
  finishedAt: number;
  isAsync: boolean;
  method: string;
  spanId: number;
  startedAt: number;
  status: PerfStatus;
  type: 'perf-span';
};

export class EventEmitter {
  static dummy = new EventEmitter(
    () => {},
    () => 0,
    () => {},
    false
  );

  private perfSpanId = 0;

  private readonly debugEvents: ReadonlySet<DebugEventType> | null;

  constructor(
    protected onEvent: OnEvent,
    protected onAction: OnAction,
    protected onEntrypointEvent: OnEntrypointEvent,
    public readonly enabled = true,
    options: EventEmitterOptions = {}
  ) {
    this.debugEvents =
      options.debugEvents === undefined ? null : new Set(options.debugEvents);
  }

  public action<TRes>(
    actonType: string,
    idx: string,
    entrypointRef: string,
    fn: () => TRes
  ) {
    // Fast path: when the emitter is disabled (the dummy used by the
    // production transform path) skip start/finish bookkeeping and the
    // Promise hookup. action() is on the hot path for every step of every
    // action — its per-call overhead is small but ubiquitous.
    if (!this.enabled) {
      return fn();
    }
    const id = this.onAction(
      'start',
      performance.now(),
      actonType,
      idx,
      entrypointRef
    );
    try {
      const result = fn();
      if (result instanceof Promise) {
        result.then(
          () => this.onAction('finish', performance.now(), id, true),
          (e) => this.onAction('fail', performance.now(), id, true, e)
        );
      } else {
        this.onAction('finish', performance.now(), id, false);
      }

      return result;
    } catch (e) {
      this.onAction('fail', performance.now(), id, false, e);
      throw e;
    }
  }

  /** @internal Transform actions fence every public lifecycle callback. */
  public actionGuarded<TRes>(
    actionType: string,
    idx: string,
    entrypointRef: string,
    fn: () => TRes,
    assertCurrent: () => void,
    prepareFinish: () => void
  ): TRes {
    if (!this.enabled) {
      let result: TRes;
      try {
        result = fn();
      } catch (error) {
        prepareFinish();
        throw error;
      }
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            prepareFinish();
            return value;
          },
          (error) => {
            prepareFinish();
            throw error;
          }
        ) as TRes;
      }
      prepareFinish();
      return result;
    }

    let id: number;
    try {
      id = this.onAction(
        'start',
        performance.now(),
        actionType,
        idx,
        entrypointRef
      );
    } finally {
      // If the observer both mutates lifecycle state and throws, the lifecycle
      // control error is authoritative over the observer's own exception.
      assertCurrent();
    }

    const emitFinish = (
      phase: 'fail' | 'finish',
      isAsync: boolean,
      error?: unknown
    ) => {
      try {
        this.onAction(phase, performance.now(), id, isAsync, error);
      } finally {
        assertCurrent();
      }
    };

    let result: TRes;
    try {
      result = fn();
    } catch (error) {
      prepareFinish();
      emitFinish('fail', false, error);
      throw error;
    }
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          prepareFinish();
          emitFinish('finish', true);
          return value;
        },
        (error) => {
          prepareFinish();
          emitFinish('fail', true, error);
          throw error;
        }
      ) as TRes;
    }

    prepareFinish();
    emitFinish('finish', false);
    return result;
  }

  public entrypointEvent(sequenceId: number, event: EntrypointEvent) {
    this.onEntrypointEvent(sequenceId, performance.now(), event);
  }

  public hasEventListener(type: DebugEventType): boolean {
    return (
      this.enabled && (this.debugEvents === null || this.debugEvents.has(type))
    );
  }

  public perf<TRes>(method: string, fn: () => TRes): TRes {
    // Fast path: see action() above. perf() wraps ~28s of cumulative time
    // in the production-path CPU profile; the wrapper overhead per call is
    // small but everywhere.
    if (!this.enabled) {
      return fn();
    }
    const spanId = this.perfSpanId;
    this.perfSpanId += 1;
    const startedAt = performance.now();
    const labels = { method };
    const startEvent: PerfStartEvent = {
      method,
      spanId,
      startedAt,
      type: 'perf-span-start',
    };

    this.onEvent(labels, 'start', startEvent);

    const finish = (status: PerfStatus, isAsync: boolean, error?: unknown) => {
      const finishedAt = performance.now();
      const finishEvent: PerfFinishEvent = {
        durationMs: finishedAt - startedAt,
        finishedAt,
        isAsync,
        method,
        spanId,
        startedAt,
        status,
        type: 'perf-span',
      };

      if (error !== undefined) {
        finishEvent.error = error;
      }

      this.onEvent(labels, 'finish', finishEvent);
    };

    try {
      const result = fn();
      if (result instanceof Promise) {
        result.then(
          () => finish('finished', true),
          (error) => finish('failed', true, error)
        );
      } else {
        finish('finished', false);
      }

      return result;
    } catch (error) {
      finish('failed', false, error);
      throw error;
    }
  }

  public single(labels: Record<string, unknown>) {
    this.onEvent(
      {
        ...labels,
        datetime: new Date(),
      },
      'single'
    );
  }
}
