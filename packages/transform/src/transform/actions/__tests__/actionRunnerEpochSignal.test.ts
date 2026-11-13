/* eslint-disable require-yield */
import { getEventListeners } from 'node:events';

import {
  createEntrypoint,
  createServices,
  getHandlers,
} from '../../__tests__/entrypoint-helpers';
import type { Entrypoint } from '../../Entrypoint';
import type {
  AsyncScenarioForAction,
  IWorkflowAction,
  Services,
} from '../../types';
import { asyncActionRunner } from '../actionRunner';

const WAITING_STEPS = 64;

const createGate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

const countAbortListeners = (signal: AbortSignal) =>
  getEventListeners(signal, 'abort').length;

const getEpochSignal = (services: Services) =>
  services.cache.getEpochAbortSignal(services.cache.getCurrentEpoch());

const retireEpoch = (services: Services) => {
  const recovery = services.cache.startUnknownGraphRecovery(
    '/foo/recovery.js',
    new Set(['/foo/missing.js']),
    'export const value = 1;',
    services.cache.createGraphTraversalToken(services.cache.getCurrentEpoch())
  );
  recovery.complete();
  return recovery.abortError;
};

/**
 * Starts a workflow whose async step marks its start and then waits until
 * `release` resolves: it settles with a result, with `failure`, or not at all.
 */
const startWaitingWorkflow = (
  entrypoint: Entrypoint,
  release: Promise<void>,
  failure?: Error,
  actionServices?: Services
) => {
  const started = createGate();
  const handlers = getHandlers<'async'>({
    async *workflow(): AsyncScenarioForAction<IWorkflowAction> {
      started.open();
      await release;
      if (failure) {
        throw failure;
      }
      return { code: entrypoint.name, sourceMap: null };
    },
  });
  const action = entrypoint.createAction(
    'workflow',
    undefined,
    null,
    undefined,
    actionServices
  );
  const running = asyncActionRunner(action, handlers);
  running.catch(() => {});
  return { action, running, started: started.opened };
};

describe('asyncActionRunner waiting on a cache epoch', () => {
  let services: Services;

  beforeEach(() => {
    services = createServices();
  });

  const createEntrypoints = (prefix: string) =>
    Array.from({ length: WAITING_STEPS }, (_, index) =>
      createEntrypoint(services, `/foo/${prefix}-${index}.js`, ['default'])
    );

  it('does not add an abort listener to the epoch signal per waiting step', async () => {
    const signal = getEpochSignal(services);
    const gate = createGate();
    const [first, ...rest] = createEntrypoints('listener-count');

    const firstStep = startWaitingWorkflow(first, gate.opened);
    await firstStep.started;
    const withOneWaitingStep = countAbortListeners(signal);

    const restSteps = rest.map((entrypoint) =>
      startWaitingWorkflow(entrypoint, gate.opened)
    );
    await Promise.all(restSteps.map((step) => step.started));
    const withAllWaitingSteps = countAbortListeners(signal);

    gate.open();
    await Promise.all([firstStep, ...restSteps].map((step) => step.running));

    expect(withAllWaitingSteps).toBe(withOneWaitingStep);
  });

  it('leaves no abort listener on the epoch signal once its steps have finished', async () => {
    const signal = getEpochSignal(services);
    const before = countAbortListeners(signal);
    const gate = createGate();
    const failure = new Error('waiting step failed');
    const steps = createEntrypoints('finished').map((entrypoint, index) =>
      startWaitingWorkflow(
        entrypoint,
        gate.opened,
        index % 2 === 0 ? undefined : failure
      )
    );
    await Promise.all(steps.map((step) => step.started));

    gate.open();
    const settled = await Promise.allSettled(steps.map((step) => step.running));

    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(
      WAITING_STEPS / 2
    );
    expect(
      settled.filter(
        (item) => item.status === 'rejected' && item.reason === failure
      )
    ).toHaveLength(WAITING_STEPS / 2);
    expect(countAbortListeners(signal)).toBe(before);
  });

  it('rejects every waiting step with the epoch error when the epoch retires', async () => {
    const never = new Promise<void>(() => {});
    const entrypoints = createEntrypoints('retired');
    const steps = entrypoints.map((entrypoint) =>
      startWaitingWorkflow(entrypoint, never)
    );
    await Promise.all(steps.map((step) => step.started));

    const startedAt = Date.now();
    const abortError = retireEpoch(services);
    const settled = await Promise.allSettled(steps.map((step) => step.running));

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(abortError).toBeInstanceOf(Error);
    expect(
      settled.filter(
        (item) => item.status === 'rejected' && item.reason === abortError
      )
    ).toHaveLength(WAITING_STEPS);
  });

  it('stops a waiting step when the epoch of its action services retires', async () => {
    const entrypointServices = createServices();
    const entrypoint = createEntrypoint(
      entrypointServices,
      '/foo/retired-action-services.js',
      ['default']
    );
    const never = new Promise<void>(() => {});
    const step = startWaitingWorkflow(entrypoint, never, undefined, services);
    expect(step.action.cacheEpoch).not.toBe(entrypoint.cacheEpoch);
    await step.started;

    const startedAt = Date.now();
    const abortError = retireEpoch(services);

    await expect(step.running).rejects.toBe(abortError);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('stops a waiting step when the epoch of its entrypoint retires', async () => {
    const entrypointServices = createServices();
    const entrypoint = createEntrypoint(
      entrypointServices,
      '/foo/retired-entrypoint.js',
      ['default']
    );
    const never = new Promise<void>(() => {});
    const step = startWaitingWorkflow(entrypoint, never, undefined, services);
    expect(step.action.cacheEpoch).not.toBe(entrypoint.cacheEpoch);
    await step.started;

    const startedAt = Date.now();
    const abortError = retireEpoch(entrypointServices);

    await expect(step.running).rejects.toBe(abortError);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('rejects a waiting step when its epoch signal fires without an epoch error', async () => {
    const [entrypoint] = createEntrypoints('without-error');
    const never = new Promise<void>(() => {});
    const step = startWaitingWorkflow(entrypoint, never);
    // A real cache always reports an error for a retired epoch; take that
    // error away to reach the fallback of the runner.
    step.action.assertCurrentCacheEpoch = () => {};
    await step.started;

    const startedAt = Date.now();
    retireEpoch(services);

    await expect(step.running).rejects.toThrow(
      '[wyw-in-js] Action cache epoch retired without an error'
    );
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});
