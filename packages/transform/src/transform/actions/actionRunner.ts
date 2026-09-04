/* eslint-disable no-await-in-loop */
import type {
  ActionQueueItem,
  Handler,
  Handlers,
  TypeOfResult,
} from '../types';
import { Pending } from '../types';

import { AbortError } from './AbortError';
import type { BaseAction } from './BaseAction';

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

const assertCurrentCacheEpoch = <TAction extends ActionQueueItem>(
  action: BaseAction<TAction>
) => {
  const assertion = action.entrypoint.assertCurrentCacheEpoch;
  if (typeof assertion === 'function') {
    assertion.call(action.entrypoint);
  }
};

const closeAsyncScenario = async (
  action: BaseAction<ActionQueueItem>,
  generator: {
    return(
      value: never
    ):
      | IteratorResult<unknown, unknown>
      | Promise<IteratorResult<unknown, unknown>>;
  }
) => {
  try {
    const result = await generator.return(undefined as never);
    if (!result.done) {
      action.log('action scenario yielded while closing');
    }
  } catch (error) {
    action.log('failed to close action scenario %O', error);
  }
};

const closeSyncScenario = (
  action: BaseAction<ActionQueueItem>,
  generator: {
    return(value: never): IteratorResult<unknown, unknown>;
  }
) => {
  try {
    const result = generator.return(undefined as never);
    if (!result.done) {
      action.log('action scenario yielded while closing');
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
  if (action.result !== Pending) {
    action.log('result is cached');
    return action.result as TypeOfResult<TAction>;
  }

  const handler = getHandler(action, actionHandlers);
  const generator = action.run<'async' | 'sync'>(handler);
  let actionResult: TypeOfResult<ActionQueueItem> | ActionError | undefined;
  let completed = false;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Let a child failure reach the parent generator so its catch/finally
      // blocks can unwind naturally. If that handler tries to yield more work,
      // the assertion immediately after throw() fences the retired epoch.
      if (!isActionError(actionResult)) {
        assertCurrentCacheEpoch(action);
      }
      if (action.abortSignal?.aborted) {
        action.log('action is aborted');
        generator.throw(new AbortError(stack[0]));
      }

      const result = await (isActionError(actionResult)
        ? generator.throw(actionResult[1])
        : generator.next(actionResult));
      assertCurrentCacheEpoch(action);
      if (result.done) {
        completed = true;
        return result.value as TypeOfResult<TAction>;
      }

      const [type, entrypoint, data, abortSignal, services = action.services] =
        result.value;
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
      } catch (e) {
        nextAction.log('error', e);
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
  if (action.result !== Pending) {
    action.log('result is cached');
    return action.result as TypeOfResult<TAction>;
  }

  const handler = getHandler(action, actionHandlers);
  const generator = action.run<'sync'>(handler);
  let actionResult: TypeOfResult<ActionQueueItem> | ActionError | undefined;
  let completed = false;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!isActionError(actionResult)) {
        assertCurrentCacheEpoch(action);
      }
      if (action.abortSignal?.aborted) {
        action.log('action is aborted');
        generator.throw(new AbortError(stack[0]));
      }

      const result = isActionError(actionResult)
        ? generator.throw(actionResult[1])
        : generator.next(actionResult);
      assertCurrentCacheEpoch(action);
      if (result.done) {
        completed = true;
        return result.value as TypeOfResult<TAction>;
      }

      const [type, entrypoint, data, abortSignal, services = action.services] =
        result.value;
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
      } catch (e) {
        nextAction.log('error', e);
        actionResult = [ACTION_ERROR, e];
      }
    }
  } finally {
    if (!completed) {
      closeSyncScenario(action, generator);
    }
  }
}
