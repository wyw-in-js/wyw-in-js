/* eslint-disable no-await-in-loop */
import type {
  ActionQueueItem,
  Handler,
  Handlers,
  TypeOfResult,
  YieldArg,
  YieldResult,
} from '../types';
import { Pending } from '../types';

import { AbortError } from './AbortError';
import type { BaseAction } from './BaseAction';
import {
  isCacheRecoveryControlError,
  isCacheRecoveryFenceError,
} from './isCacheRecoveryControlError';

function getHandler<
  TMode extends 'async' | 'sync',
  TAction extends ActionQueueItem,
>(
  action: BaseAction<TAction>,
  actionHandlers: Handlers<TMode>
): Handler<TMode, TAction> {
  const handler = actionHandlers[action.type];
  if (!handler) {
    throw new Error(`No handler for action ${action.type}`);
  }

  // FIXME Handlers<TMode>[TAction['type']] is not assignable to Handler<TMode, TAction>
  return handler as unknown as Handler<TMode, TAction>;
}

const getActionRef = (type: string, entrypoint: { ref: string }) =>
  `${type}@${entrypoint.ref}`;

const ACTION_ERROR = Symbol('ACTION_ERROR');
type ActionError = [marker: typeof ACTION_ERROR, err: unknown];
const isActionError = (e: unknown): e is ActionError =>
  Array.isArray(e) && e[0] === ACTION_ERROR;

const MAX_CLOSE_YIELDS = 32;
const MAX_CLOSE_TIME_MS = 250;
const CLOSE_STEP_TIMED_OUT = Symbol('CLOSE_STEP_TIMED_OUT');

const awaitCloseStep = async (
  step:
    | IteratorResult<unknown, unknown>
    | Promise<IteratorResult<unknown, unknown>>,
  deadline: number
): Promise<IteratorResult<unknown, unknown> | typeof CLOSE_STEP_TIMED_OUT> => {
  const observed = Promise.resolve(step).then(
    (result) => ({ kind: 'result' as const, result }),
    (error) => ({ error, kind: 'error' as const })
  );
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return CLOSE_STEP_TIMED_OUT;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof CLOSE_STEP_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(CLOSE_STEP_TIMED_OUT), remaining);
  });
  const settled = await Promise.race([observed, timedOut]);
  if (settled === CLOSE_STEP_TIMED_OUT) {
    return settled;
  }

  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if (settled.kind === 'error') {
    throw settled.error;
  }
  return settled.result;
};

const assertCurrentCacheEpoch = <TAction extends ActionQueueItem>(
  action: BaseAction<TAction>
) => {
  const assertion = action.assertCurrentCacheEpoch;
  if (typeof assertion === 'function') {
    assertion.call(action);
  }
};

const awaitActionStep = async <TAction extends ActionQueueItem, TResult>(
  action: BaseAction<TAction>,
  step: TResult | PromiseLike<TResult>
): Promise<TResult> => {
  const signals = [
    action.cacheEpoch.owner.getEpochAbortSignal(action.cacheEpoch),
    action.entrypoint.cacheEpoch.owner.getEpochAbortSignal(
      action.entrypoint.cacheEpoch
    ),
  ].filter((signal, index, all) => all.indexOf(signal) === index);
  let rejectRetired!: (error: unknown) => void;
  const retired = new Promise<never>((_resolve, reject) => {
    rejectRetired = reject;
  });
  const onRetired = () => {
    try {
      assertCurrentCacheEpoch(action);
      rejectRetired(
        new Error('[wyw-in-js] Action cache epoch retired without an error')
      );
    } catch (error) {
      rejectRetired(error);
    }
  };

  signals.forEach((signal) => {
    signal.addEventListener('abort', onRetired, { once: true });
  });
  // Close the race between reading the signal and registering its listener.
  if (signals.some((signal) => signal.aborted)) {
    onRetired();
  }

  try {
    return await Promise.race([Promise.resolve(step), retired]);
  } finally {
    signals.forEach((signal) => {
      signal.removeEventListener('abort', onRetired);
    });
  }
};

// Once an epoch assertion fails, never resume the yielded continuation: it may
// be ordinary catch/control-flow code from the retired graph. Calling return()
// can itself enter a finally block and yield cleanup actions. Those yields are
// not scheduled. Drain a bounded number of cleanup yields so ordinary finally
// blocks can finish without letting result-dependent cleanup hide the original
// recovery error forever.
const closeAsyncScenario = async (
  action: BaseAction<ActionQueueItem>,
  generator: {
    closeNext(
      value: never
    ):
      | IteratorResult<unknown, unknown>
      | Promise<IteratorResult<unknown, unknown>>;
    return(
      value: never
    ):
      | IteratorResult<unknown, unknown>
      | Promise<IteratorResult<unknown, unknown>>;
  }
) => {
  try {
    const deadline = Date.now() + MAX_CLOSE_TIME_MS;
    let result = await awaitCloseStep(
      generator.return(undefined as never),
      deadline
    );
    if (result === CLOSE_STEP_TIMED_OUT) {
      action.log(
        'stopped draining action scenario after %dms',
        MAX_CLOSE_TIME_MS
      );
      return;
    }
    let closeYields = 0;
    while (!result.done && closeYields < MAX_CLOSE_YIELDS) {
      // A generator return is allowed to enter a finally block that yields.
      // Cleanup yields are never scheduled as actions after the runner has
      // failed, but resume the generator so the rest of finally still runs.
      action.log('action scenario yielded while closing');
      closeYields += 1;
      result = await awaitCloseStep(
        generator.closeNext(undefined as never),
        deadline
      );
      if (result === CLOSE_STEP_TIMED_OUT) {
        action.log(
          'stopped draining action scenario after %dms',
          MAX_CLOSE_TIME_MS
        );
        return;
      }
    }
    if (!result.done) {
      action.log(
        'stopped draining action scenario after %d cleanup yields',
        MAX_CLOSE_YIELDS
      );
    }
  } catch (error) {
    action.log('failed to close action scenario %O', error);
  }
};

const closeSyncScenario = (
  action: BaseAction<ActionQueueItem>,
  generator: {
    closeNext(value: never): IteratorResult<unknown, unknown>;
    return(value: never): IteratorResult<unknown, unknown>;
  }
) => {
  try {
    let result = generator.return(undefined as never);
    let closeYields = 0;
    while (!result.done && closeYields < MAX_CLOSE_YIELDS) {
      action.log('action scenario yielded while closing');
      closeYields += 1;
      result = generator.closeNext(undefined as never);
    }
    if (!result.done) {
      action.log(
        'stopped draining action scenario after %d cleanup yields',
        MAX_CLOSE_YIELDS
      );
    }
  } catch (error) {
    action.log('failed to close action scenario %O', error);
  }
};

export async function asyncActionRunner<TAction extends ActionQueueItem>(
  action: BaseAction<TAction>,
  actionHandlers: Handlers<'async' | 'sync'>,
  stack: string[] = [getActionRef(action.type, action.entrypoint)]
): Promise<TypeOfResult<TAction>> {
  assertCurrentCacheEpoch(action);
  action.entrypoint.assertNotSuperseded();
  if (action.result !== Pending) {
    action.log('result is cached');
    return action.result as TypeOfResult<TAction>;
  }

  const handler = getHandler(action, actionHandlers);
  const generator = action.run<'async' | 'sync'>(handler);
  let actionResult: TypeOfResult<ActionQueueItem> | ActionError | undefined;
  let abortDelivered = false;
  let completed = false;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // A normal child failure still reaches the parent catch. If the child
      // retired this action's epoch, fence it before generator.throw() can run
      // stale catch/control-flow code; closeAsyncScenario will still unwind
      // the parent's finally blocks through generator.return().
      assertCurrentCacheEpoch(action);
      let result: IteratorResult<YieldArg, TypeOfResult<TAction>>;
      const actionError = isActionError(actionResult) ? actionResult : null;
      try {
        if (action.abortSignal?.aborted && !abortDelivered) {
          action.log('action is aborted');
          abortDelivered = true;
          result = await awaitActionStep(
            action,
            generator.throw(new AbortError(stack[0]))
          );
        } else if (actionError) {
          result = await awaitActionStep(
            action,
            generator.throw(actionError[1])
          );
        } else {
          result = await awaitActionStep(
            action,
            generator.next(actionResult as YieldResult)
          );
        }
      } catch (error) {
        // A rejected async iterator step skips the normal post-await fence.
        // Prefer the exact attempt-owner abort over an error produced after
        // that attempt had already been retired.
        assertCurrentCacheEpoch(action);
        throw error;
      }
      assertCurrentCacheEpoch(action);
      if (result.done) {
        completed = true;
        return result.value as TypeOfResult<TAction>;
      }

      const [type, entrypoint, data, abortSignal, services = action.services] =
        result.value;
      const parentWasSuperseded = action.entrypoint.supersededWith !== null;
      const nextAction = entrypoint.createAction(
        type,
        data,
        abortSignal,
        action.actionContext,
        services
      );

      try {
        actionResult = await asyncActionRunner(nextAction, actionHandlers, [
          ...stack,
          getActionRef(type, entrypoint),
        ]);
        // The child may belong to a different entrypoint. Its successful
        // completion therefore says nothing about whether a previously-current
        // parent was superseded while it waited. Turn that transition into the
        // next generator throw. A parent that was already superseded when it
        // yielded (its recovery path) remains resumable even if the replacement
        // chain widens again while the child runs.
        if (!parentWasSuperseded && action.entrypoint.supersededWith !== null) {
          throw new AbortError('superseded');
        }
      } catch (e) {
        nextAction.log('error', e);
        if (isCacheRecoveryFenceError(e) || isCacheRecoveryControlError(e)) {
          throw e;
        }
        actionResult = [ACTION_ERROR, e];
      }
    }
  } finally {
    if (!completed) {
      await closeAsyncScenario(action, generator);
    }
  }
}

export function syncActionRunner<TAction extends ActionQueueItem>(
  action: BaseAction<TAction>,
  actionHandlers: Handlers<'sync'>,
  stack: string[] = [getActionRef(action.type, action.entrypoint)]
): TypeOfResult<TAction> {
  assertCurrentCacheEpoch(action);
  action.entrypoint.assertNotSuperseded();
  if (action.result !== Pending) {
    action.log('result is cached');
    return action.result as TypeOfResult<TAction>;
  }

  const handler = getHandler(action, actionHandlers);
  const generator = action.run<'sync'>(handler);
  let actionResult: TypeOfResult<ActionQueueItem> | ActionError | undefined;
  let abortDelivered = false;
  let completed = false;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      assertCurrentCacheEpoch(action);
      let result: IteratorResult<YieldArg, TypeOfResult<TAction>>;
      const actionError = isActionError(actionResult) ? actionResult : null;
      if (action.abortSignal?.aborted && !abortDelivered) {
        action.log('action is aborted');
        abortDelivered = true;
        result = generator.throw(new AbortError(stack[0]));
      } else if (actionError) {
        result = generator.throw(actionError[1]);
      } else {
        result = generator.next(actionResult as YieldResult);
      }
      assertCurrentCacheEpoch(action);
      if (result.done) {
        completed = true;
        return result.value as TypeOfResult<TAction>;
      }

      const [type, entrypoint, data, abortSignal, services = action.services] =
        result.value;
      const parentWasSuperseded = action.entrypoint.supersededWith !== null;
      const nextAction = entrypoint.createAction(
        type,
        data,
        abortSignal,
        action.actionContext,
        services
      );

      try {
        actionResult = syncActionRunner(nextAction, actionHandlers, [
          ...stack,
          getActionRef(type, entrypoint),
        ]);
        if (!parentWasSuperseded && action.entrypoint.supersededWith !== null) {
          throw new AbortError('superseded');
        }
      } catch (e) {
        nextAction.log('error', e);
        if (isCacheRecoveryFenceError(e) || isCacheRecoveryControlError(e)) {
          throw e;
        }
        actionResult = [ACTION_ERROR, e];
      }
    }
  } finally {
    if (!completed) {
      closeSyncScenario(action, generator);
    }
  }
}
