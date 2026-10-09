import { asyncActionRunner } from '../../actions/actionRunner';
import {
  createEntrypoint,
  createServices,
  getHandlers,
} from '../../__tests__/entrypoint-helpers';
import type { ITransformAction, SyncScenarioForAction } from '../../types';
import { processEntrypoint } from '../processEntrypoint';

const flushAsyncSteps = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe('processEntrypoint', () => {
  it('runs transform once and stores its result', async () => {
    const services = createServices();
    const entrypoint = createEntrypoint(
      services,
      '/foo/entry.js',
      ['value'],
      'export const value = 1;'
    );
    const handlers = getHandlers<'async'>({
      processEntrypoint,
      // eslint-disable-next-line require-yield
      *transform(): SyncScenarioForAction<ITransformAction> {
        return { code: 'export const value = 2;', metadata: null };
      },
    });

    await asyncActionRunner(
      entrypoint.createAction('processEntrypoint', undefined, null),
      handlers
    );

    expect(entrypoint.transformed).toBe(true);
    expect(entrypoint.isProcessing).toBe(false);
  });

  it('skips transform when the entrypoint is already transformed', async () => {
    const services = createServices();
    const entrypoint = createEntrypoint(
      services,
      '/foo/entry.js',
      ['value'],
      'export const value = 1;'
    );
    entrypoint.setTransformResult({
      code: 'export const value = 1;',
      metadata: null,
    });

    const handlers = getHandlers<'async'>({
      processEntrypoint,
    });

    const action = entrypoint.createAction(
      'processEntrypoint',
      undefined,
      null
    );

    await asyncActionRunner(action, handlers);

    expect(handlers.transform).not.toHaveBeenCalled();
  });

  it('waits for the request that is already processing the entrypoint', async () => {
    const services = createServices();
    const entrypoint = createEntrypoint(
      services,
      '/foo/entry.js',
      ['value'],
      'export const value = 1;'
    );

    entrypoint.beginProcessing();

    const handlers = getHandlers<'async'>({
      processEntrypoint,
    });

    const action = entrypoint.createAction(
      'processEntrypoint',
      undefined,
      null
    );

    let settled = false;
    const running = asyncActionRunner(action, handlers).then(() => {
      settled = true;
    });

    try {
      await flushAsyncSteps();

      expect(settled).toBe(false);
      expect(handlers.transform).not.toHaveBeenCalled();
    } finally {
      entrypoint.endProcessing();
    }

    await running;

    expect(settled).toBe(true);
    expect(handlers.transform).not.toHaveBeenCalled();
  });
});
