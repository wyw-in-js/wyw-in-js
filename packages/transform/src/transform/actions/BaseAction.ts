/* eslint-disable no-plusplus */
import '../../utils/dispose-polyfill';
import type { Debugger } from '@wyw-in-js/shared';

import type { TransformCacheEpoch } from '../../cache';
import type { Entrypoint } from '../Entrypoint';
import type { IEvaluatedEntrypoint } from '../EvaluatedEntrypoint';
import { AbortError } from './AbortError';
import {
  isCacheRecoveryFenceError,
  markCacheRecoveryFenceError,
} from './isCacheRecoveryControlError';
import type {
  ActionQueueItem,
  ActionTypes,
  AnyIteratorResult,
  AsyncScenarioForAction,
  Handler,
  IBaseAction,
  Services,
  SyncScenarioForAction,
  TypeOfResult,
  YieldArg,
  YieldResult,
} from '../types';
import { Pending } from '../types';

let actionIdx = 0;

type CachePublication = {
  publication: Entrypoint | IEvaluatedEntrypoint | undefined;
};

export type ActionByType<TType extends ActionTypes> = Extract<
  ActionQueueItem,
  {
    type: TType;
  }
>;

type GetBase<TAction extends ActionQueueItem> = IBaseAction<
  TAction,
  TypeOfResult<TAction>,
  TAction['data']
>;

type ActionScenarioController<TMode extends 'async' | 'sync', TResult> = {
  /** @internal Resume finally without emitting public action events. */
  closeNext(arg: never): AnyIteratorResult<TMode, TResult>;
  next(arg: YieldResult): AnyIteratorResult<TMode, TResult>;
  /** @internal Close the underlying scenario. */
  return(value: never): AnyIteratorResult<TMode, TResult>;
  throw(error: unknown): AnyIteratorResult<TMode, TResult>;
};

export class BaseAction<TAction extends ActionQueueItem>
  implements GetBase<TAction>
{
  public readonly idx: string;

  public result: TypeOfResult<TAction> | typeof Pending = Pending;

  private cachePublication: CachePublication | null = null;

  private activeScenario:
    | SyncScenarioForAction<TAction>
    | AsyncScenarioForAction<TAction>
    | null = null;

  private activeScenarioError?: unknown;

  private activeScenarioNextResults: AnyIteratorResult<
    'async' | 'sync',
    TypeOfResult<TAction>
  >[] = [];

  private handler: null | unknown = null;

  /** @internal Actions publish through their services owner's captured epoch. */
  public readonly cacheEpoch: TransformCacheEpoch;

  public constructor(
    public readonly type: TAction['type'],
    public readonly services: Services,
    public readonly entrypoint: Entrypoint,
    public readonly data: TAction['data'],
    public readonly abortSignal: AbortSignal | null,
    public readonly actionContext: unknown
  ) {
    actionIdx += 1;
    this.idx = actionIdx.toString(16).padStart(6, '0');
    this.cacheEpoch = services.cacheEpoch ?? services.cache.getCurrentEpoch();
    this.assertCurrentCacheEpoch();
  }

  public get log(): Debugger {
    return this.entrypoint.log.extend(this.ref);
  }

  public get ref() {
    return `${this.type}@${this.idx}`;
  }

  /** @internal Carries an exact cache identity alongside the public result. */
  public recordCachePublication(
    publication: Entrypoint | IEvaluatedEntrypoint | undefined
  ): void {
    this.cachePublication = { publication };
  }

  /** @internal Consume cache identity after the parent resumes. */
  public takeCachePublication(): CachePublication | null {
    const publication = this.cachePublication;
    this.cachePublication = null;
    return publication;
  }

  /** @internal Action execution must fence both of its semantic owners. */
  public assertCurrentCacheEpoch(): void {
    // The action services own the top-level attempt and therefore its retry
    // identity. Check that epoch first, then fence a distinct entrypoint owner.
    this.cacheEpoch.owner.assertEpoch(this.cacheEpoch);
    this.entrypoint.assertCurrentCacheEpoch();
  }

  public createAbortSignal(): AbortSignal & Disposable {
    const abortController = new AbortController();

    const unsubscribeFromParentAbort = this.onAbort(() => {
      this.entrypoint.log('parent aborted');
      abortController.abort();
    });

    const unsubscribeFromSupersede = this.entrypoint.onSupersede(() => {
      this.entrypoint.log('entrypoint superseded, aborting processing');
      abortController.abort();
    });

    const abortSignal = abortController.signal as AbortSignal & Disposable;
    abortSignal[Symbol.dispose] = () => {
      unsubscribeFromParentAbort();
      unsubscribeFromSupersede();
    };

    return abortSignal;
  }

  public *getNext<
    TNextType extends ActionTypes,
    TNextAction extends ActionByType<TNextType> = ActionByType<TNextType>,
  >(
    type: TNextType,
    entrypoint: Entrypoint,
    data: TNextAction['data'],
    abortSignal: AbortSignal | null = this.abortSignal,
    services?: Services
  ): Generator<
    [TNextType, Entrypoint, TNextAction['data'], AbortSignal | null, Services?],
    TypeOfResult<TNextAction>,
    YieldResult
  > {
    const next: [
      TNextType,
      Entrypoint,
      TNextAction['data'],
      AbortSignal | null,
      Services?,
    ] = [type, entrypoint, data, abortSignal];

    if (services !== undefined) {
      next.push(services);
    }

    return (yield next) as TypeOfResult<TNextAction>;
  }

  public onAbort(fn: () => void): () => void {
    this.abortSignal?.addEventListener('abort', fn);

    return () => {
      this.abortSignal?.removeEventListener('abort', fn);
    };
  }

  public run<
    TMode extends 'async' | 'sync',
    THandler extends Handler<TMode, TAction> = Handler<TMode, TAction>,
  >(handler: THandler): ActionScenarioController<TMode, TypeOfResult<TAction>> {
    type IterationResult = AnyIteratorResult<TMode, TypeOfResult<TAction>>;

    if (this.handler && this.handler !== handler) {
      throw new Error(
        `action handler is already set for ${this.ref} (${this.entrypoint.name})`
      );
    }

    this.assertCurrentCacheEpoch();

    this.handler = handler;

    if (!this.activeScenario) {
      this.activeScenario = handler.call(this);
      this.activeScenarioNextResults = [];
    }

    let nextIdx = 0;

    const assertSupersedeState = (
      expected: Entrypoint | null,
      expectedPublication: unknown,
      onFenceError: (error: unknown) => void
    ) => {
      try {
        this.assertCurrentCacheEpoch();
        if (this.entrypoint.supersededWith !== expected) {
          throw new AbortError('superseded');
        }
        if (
          this.services.cache.get('entrypoints', this.entrypoint.name) !==
          expectedPublication
        ) {
          throw new AbortError('superseded');
        }
      } catch (error) {
        const fenceError = markCacheRecoveryFenceError(error);
        onFenceError(fenceError);
        throw fenceError;
      }
    };

    const throwFn = (
      e: unknown,
      onFenceError: (error: unknown) => void
    ): IterationResult => {
      // A parent is legitimately allowed to resume its catch after a child
      // supersedes it. What is not safe is a *new* supersede introduced by the
      // public start/finish callbacks for this throw step. Fence the relative
      // identity rather than requiring the parent to still be unsuperseded.
      const expectedSupersededWith = this.entrypoint.supersededWith;
      let expectedPublication = this.services.cache.get(
        'entrypoints',
        this.entrypoint.name
      );
      const assertThrowCurrent = () =>
        assertSupersedeState(
          expectedSupersededWith,
          expectedPublication,
          onFenceError
        );
      const prepareThrowFinish = () => {
        try {
          this.assertCurrentCacheEpoch();
          if (this.entrypoint.supersededWith !== expectedSupersededWith) {
            throw new AbortError('superseded');
          }
          expectedPublication = this.services.cache.get(
            'entrypoints',
            this.entrypoint.name
          );
        } catch (error) {
          // This fence runs after the handler body but before the public
          // finish callback. A handler-driven supersede is normal control
          // flow and must remain catchable by its parent action. Keep the
          // error local to this action step; only observer-boundary fences
          // are globally marked below.
          onFenceError(error);
          throw error;
        }
      };
      this.assertCurrentCacheEpoch();
      const result = this.emitAction(
        nextIdx,
        () => {
          assertThrowCurrent();
          return this.activeScenario!.throw(e);
        },
        assertThrowCurrent,
        prepareThrowFinish
      ) as IterationResult;

      if ('then' in result) {
        const resultPromise = result as Promise<
          IteratorResult<YieldArg, TypeOfResult<TAction>>
        >;
        const guarded = resultPromise.then((value) => {
          assertThrowCurrent();
          return value;
        });
        // The finish-event fence below can throw before the runner receives
        // the iterator promise. Observe both the original and guarded chains.
        resultPromise.catch(() => {});
        guarded.catch(() => {});
        assertThrowCurrent();
        return guarded as IterationResult;
      }

      assertThrowCurrent();
      return result;
    };

    const nextFn = (
      arg: YieldResult,
      onFenceError: (error: unknown) => void
    ) => {
      const expectedSupersededWith = this.entrypoint.supersededWith;
      let expectedPublication = this.services.cache.get(
        'entrypoints',
        this.entrypoint.name
      );
      const assertNextCurrent = () => {
        try {
          this.assertCurrentCacheEpoch();
          if (this.entrypoint.supersededWith !== expectedSupersededWith) {
            throw new AbortError('superseded');
          }
          if (
            this.services.cache.get('entrypoints', this.entrypoint.name) !==
            expectedPublication
          ) {
            throw new AbortError('superseded');
          }
        } catch (error) {
          const fenceError = markCacheRecoveryFenceError(error);
          onFenceError(fenceError);
          throw fenceError;
        }
      };
      const prepareNextFinish = () => {
        try {
          this.assertCurrentCacheEpoch();
          if (this.entrypoint.supersededWith !== expectedSupersededWith) {
            throw new AbortError('superseded');
          }
          expectedPublication = this.services.cache.get(
            'entrypoints',
            this.entrypoint.name
          );
        } catch (error) {
          // See prepareThrowFinish: handler-driven supersedes are recoverable
          // by the parent scenario, unlike mutations from lifecycle observers.
          onFenceError(error);
          throw error;
        }
      };
      this.assertCurrentCacheEpoch();
      const result = this.emitAction(
        nextIdx,
        () => {
          assertNextCurrent();
          return this.activeScenario!.next(arg);
        },
        assertNextCurrent,
        prepareNextFinish
      ) as IterationResult;
      if ('then' in result) {
        const resultPromise = result as Promise<
          IteratorResult<YieldArg, TypeOfResult<TAction>>
        >;
        const guarded = resultPromise.then((value) => {
          assertNextCurrent();
          return value;
        });
        resultPromise.catch(() => {});
        guarded.catch(() => {});
        assertNextCurrent();
        return guarded as IterationResult;
      }

      assertNextCurrent();
      return result;
    };

    const processNextResult = (
      result: IterationResult,
      onError?: (e: unknown) => void
    ) => {
      if ('then' in result) {
        result
          .then((r) => {
            this.assertCurrentCacheEpoch();
            if (r.done) {
              this.result = r.value;
            }
          }, onError)
          // The runner awaits the original promise and propagates its error.
          // Do not let an error thrown by this bookkeeping observer become a
          // second, unhandled rejection.
          .catch(() => {});
      } else if (result.done) {
        this.result = result.value;
      }

      this.activeScenarioNextResults.push(result);
    };

    const processError = (e: unknown) => {
      if (isCacheRecoveryFenceError(e)) {
        this.activeScenarioError = e;
        throw e;
      }

      if (this.activeScenarioNextResults.length > nextIdx) {
        this.log(
          'error was already handled in another branch, result idx is %d',
          nextIdx
        );
        return;
      }

      this.log('error processing, result idx is %d', nextIdx);

      let fenceError: unknown;
      try {
        const nextResult = throwFn(e, (error) => {
          fenceError = error;
        });
        processNextResult(nextResult, (error) => {
          if (error !== fenceError) {
            processError(error);
          }
        });
      } catch (errorInGenerator) {
        if (errorInGenerator === fenceError) {
          throw errorInGenerator;
        }
        this.assertCurrentCacheEpoch();
        const { recover } = handler;
        if (recover) {
          const nextResult = {
            done: false,
            value: recover(errorInGenerator, this),
          };

          processNextResult(nextResult as IterationResult, processError);
          return;
        }

        this.activeScenarioError = errorInGenerator;
        throw errorInGenerator;
      }
    };

    const processNext = (arg: YieldResult) => {
      if (this.activeScenarioNextResults.length > nextIdx) {
        this.log(
          'next was already handled in another branch, result idx is %d',
          nextIdx
        );
        return;
      }

      this.log('next processing, result idx is %d', nextIdx);

      let fenceError: unknown;
      let nextResult: IterationResult;
      try {
        nextResult = nextFn(arg, (error) => {
          fenceError = error;
        }) as IterationResult;
      } catch (e) {
        if (e === fenceError) {
          throw e;
        }
        processError(e);
        return;
      }

      if ('then' in nextResult) {
        // A finish callback can retire the action before processNextResult
        // attaches its observer. Ensure a later iterator rejection is already
        // handled even when the finish fence below throws synchronously.
        nextResult.catch(() => {});
      }

      processNextResult(nextResult, processError);
    };

    return {
      /** @internal Resume finally without emitting public action events. */
      closeNext: (arg: never): IterationResult =>
        this.activeScenario!.next(arg) as IterationResult,
      next: (arg: YieldResult): IterationResult => {
        this.rethrowActiveScenarioError();
        processNext(arg);
        return this.activeScenarioNextResults[nextIdx++] as IterationResult;
      },
      throw: (e: unknown): IterationResult => {
        this.rethrowActiveScenarioError();
        processError(e);
        return this.activeScenarioNextResults[nextIdx++] as IterationResult;
      },
      return: (value: never): IterationResult => {
        return this.activeScenario!.return(value) as IterationResult;
      },
    };
  }

  protected emitAction<TRes>(
    yieldIdx: number,
    fn: () => TRes,
    assertCurrent?: () => void,
    prepareFinish?: () => void
  ) {
    if (assertCurrent && prepareFinish) {
      return this.services.eventEmitter.actionGuarded(
        this.type,
        `${this.idx}:${yieldIdx + 1}`,
        this.entrypoint.ref,
        fn,
        assertCurrent,
        prepareFinish
      );
    }

    return this.services.eventEmitter.action(
      this.type,
      `${this.idx}:${yieldIdx + 1}`,
      this.entrypoint.ref,
      fn
    );
  }

  private rethrowActiveScenarioError() {
    if (!this.activeScenarioError) {
      return;
    }

    this.log(
      'scenario has an unhandled error from another branch, rethrow %o',
      this.activeScenarioError
    );

    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    throw this.activeScenarioError;
  }
}
