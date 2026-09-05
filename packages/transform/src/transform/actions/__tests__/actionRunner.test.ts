/* eslint-disable require-yield */
import type { IEntrypointDependency } from '../../Entrypoint.types';
import {
  createEntrypoint,
  createServices,
  getHandlers,
} from '../../__tests__/entrypoint-helpers';
import { processEntrypoint } from '../../generators/processEntrypoint';
import type {
  Services,
  AsyncScenarioForAction,
  IProcessEntrypointAction,
  SyncScenarioForAction,
  IResolveImportsAction,
  IWorkflowAction,
  ITransformAction,
  YieldArg,
} from '../../types';
import type { BaseAction } from '../BaseAction';
import { asyncActionRunner, syncActionRunner } from '../actionRunner';
import { AbortError } from '../AbortError';
import { EventEmitter } from '../../../utils/EventEmitter';

describe('actionRunner', () => {
  let services: Services;

  beforeEach(() => {
    services = createServices();
  });

  it('should be defined', () => {
    expect(asyncActionRunner).toBeDefined();
    expect(syncActionRunner).toBeDefined();
  });

  it('should run action', () => {
    const handlers = getHandlers<'sync'>({});

    const entrypoint = createEntrypoint(services, '/foo/bar.js', ['default']);
    const action = entrypoint.createAction(
      'processEntrypoint',
      undefined,
      null
    );

    syncActionRunner(action, handlers);
    expect(handlers.processEntrypoint).toHaveBeenCalled();
  });

  it('does not return an action superseded by its actionCreated callback', () => {
    const name = '/foo/reentrant-action-created.js';
    const entrypoint = createEntrypoint(services, name, ['default']);
    const handlerSideEffect = jest.fn();
    let reentered = false;
    services.eventEmitter = new EventEmitter(
      () => {},
      () => 0,
      (_sequenceId, _timestamp, event) => {
        if (event.type === 'actionCreated' && !reentered) {
          reentered = true;
          createEntrypoint(services, name, ['replacement']);
        }
      }
    );
    const handlers = getHandlers<'sync'>({
      *workflow() {
        handlerSideEffect();
        return { code: '', sourceMap: null };
      },
    });

    expect(() => {
      const action = entrypoint.createAction('workflow', undefined, null);
      syncActionRunner(action, handlers);
    }).toThrow(AbortError);
    expect(handlerSideEffect).not.toHaveBeenCalled();
  });

  it('does not enter a sync handler superseded by its action start callback', () => {
    const name = '/foo/reentrant-action-start.js';
    const entrypoint = createEntrypoint(services, name, ['default']);
    const action = entrypoint.createAction('workflow', undefined, null);
    const handlerSideEffect = jest.fn();
    let reentered = false;
    services.eventEmitter = new EventEmitter(
      () => {},
      (phase) => {
        if (phase === 'start' && !reentered) {
          reentered = true;
          createEntrypoint(services, name, ['replacement']);
        }
        return 0;
      },
      () => {}
    );
    const handlers = getHandlers<'sync'>({
      *workflow() {
        handlerSideEffect();
        return { code: '', sourceMap: null };
      },
    });

    expect(() => syncActionRunner(action, handlers)).toThrow(AbortError);
    expect(handlerSideEffect).not.toHaveBeenCalled();
  });

  it('does not accept a result superseded by its action finish callback', () => {
    const name = '/foo/reentrant-action-finish.js';
    const entrypoint = createEntrypoint(services, name, ['default']);
    const action = entrypoint.createAction('workflow', undefined, null);
    let reentered = false;
    services.eventEmitter = new EventEmitter(
      () => {},
      (phase) => {
        if (phase === 'finish' && !reentered) {
          reentered = true;
          createEntrypoint(services, name, ['replacement']);
        }
        return 0;
      },
      () => {}
    );
    const handlers = getHandlers<'sync'>({
      *workflow() {
        return { code: 'stale', sourceMap: null };
      },
    });

    expect(() => syncActionRunner(action, handlers)).toThrow(AbortError);
    expect(action.result).not.toEqual({ code: 'stale', sourceMap: null });
  });

  it('does not deliver a child finish fence error to the parent catch', () => {
    const name = '/foo/reentrant-child-finish.js';
    const entrypoint = createEntrypoint(services, name, ['default']);
    const parentCaught = jest.fn();
    const parentResumed = jest.fn();
    const parentClosed = jest.fn();
    let nextActionId = 0;
    let childActionId: number | null = null;
    let reentered = false;
    services.eventEmitter = new EventEmitter(
      () => {},
      (...args) => {
        if (args[0] === 'start') {
          const id = nextActionId;
          nextActionId += 1;
          if (args[2] === 'transform') childActionId = id;
          return id;
        }
        if (args[0] === 'finish' && args[2] === childActionId && !reentered) {
          reentered = true;
          createEntrypoint(services, name, ['replacement']);
        }
        return undefined;
      },
      () => {}
    );
    const handlers = getHandlers<'sync'>({
      *workflow(this: IWorkflowAction) {
        try {
          yield ['transform', this.entrypoint, undefined, null];
          parentResumed();
          return { code: '', sourceMap: null };
        } catch {
          parentCaught();
          return { code: 'stale fallback', sourceMap: null };
        } finally {
          parentClosed();
        }
      },
      *transform() {
        return { code: '', metadata: null };
      },
    });

    expect(() =>
      syncActionRunner(
        entrypoint.createAction('workflow', undefined, null),
        handlers
      )
    ).toThrow(AbortError);
    expect(parentResumed).not.toHaveBeenCalled();
    expect(parentCaught).not.toHaveBeenCalled();
    expect(parentClosed).toHaveBeenCalledTimes(1);
  });

  it('does not enter a sync action after its start event retires the epoch', () => {
    const sideEffect = jest.fn();
    const staleRecover = jest.fn();
    const entrypoint = createEntrypoint(services, '/foo/reentrant.js', [
      'default',
    ]);
    const { cacheEpoch } = entrypoint;
    let controlError: Error | null = null;
    services.eventEmitter = new EventEmitter(
      () => {},
      (phase) => {
        if (phase === 'start' && !controlError) {
          services.cache.beginSupersedeStormRecovery(
            new Error('reentrant action recovery')
          );
          controlError = services.cache.getEpochError(cacheEpoch);
        }
        return 0;
      },
      () => {}
    );
    function* workflow(): SyncScenarioForAction<IWorkflowAction> {
      sideEffect();
      return { code: '', sourceMap: null };
    }
    workflow.recover = jest.fn((): YieldArg => {
      staleRecover();
      return ['transform', entrypoint, undefined, null];
    });
    const handlers = getHandlers<'sync'>({ workflow });

    let thrown: unknown;
    try {
      syncActionRunner(
        entrypoint.createAction('workflow', undefined, null),
        handlers
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(controlError);
    expect(sideEffect).not.toHaveBeenCalled();
    expect(workflow.recover).not.toHaveBeenCalled();
    expect(staleRecover).not.toHaveBeenCalled();
  });

  it('does not enter an async action after its start event retires the epoch', async () => {
    const sideEffect = jest.fn();
    const entrypoint = createEntrypoint(services, '/foo/reentrant.js', [
      'default',
    ]);
    const { cacheEpoch } = entrypoint;
    let controlError: Error | null = null;
    services.eventEmitter = new EventEmitter(
      () => {},
      (phase) => {
        if (phase === 'start' && !controlError) {
          services.cache.beginSupersedeStormRecovery(
            new Error('reentrant action recovery')
          );
          controlError = services.cache.getEpochError(cacheEpoch);
        }
        return 0;
      },
      () => {}
    );
    const handlers = getHandlers({
      *workflow() {
        sideEffect();
        return { code: '', sourceMap: null };
      },
    });

    const running = asyncActionRunner(
      entrypoint.createAction('workflow', undefined, null),
      handlers
    );

    await expect(running).rejects.toBe(controlError);
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('fences a distinct sync action-services epoch before entering the handler', () => {
    const entrypointServices = createServices();
    const entrypoint = createEntrypoint(
      entrypointServices,
      '/foo/cross-owner-sync.js',
      ['default']
    );
    const serviceEpoch = services.cache.getCurrentEpoch();
    const sideEffect = jest.fn();
    const staleRecover = jest.fn();
    let controlError: Error | null = null;
    services.eventEmitter = new EventEmitter(
      () => {},
      (phase) => {
        if (phase === 'start' && !controlError) {
          services.cache.beginSupersedeStormRecovery(
            new Error('cross-owner sync action recovery')
          );
          controlError = services.cache.getEpochError(serviceEpoch);
        }
        return 0;
      },
      () => {}
    );
    function* workflow(): SyncScenarioForAction<IWorkflowAction> {
      sideEffect();
      return { code: '', sourceMap: null };
    }
    workflow.recover = jest.fn((): YieldArg => {
      staleRecover();
      return ['transform', entrypoint, undefined, null];
    });
    const handlers = getHandlers<'sync'>({ workflow });
    const action = entrypoint.createAction(
      'workflow',
      undefined,
      null,
      undefined,
      services
    );

    let thrown: unknown;
    try {
      syncActionRunner(action, handlers);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(controlError);
    expect(sideEffect).not.toHaveBeenCalled();
    expect(workflow.recover).not.toHaveBeenCalled();
    expect(staleRecover).not.toHaveBeenCalled();
  });

  it('fences a distinct async action-services epoch before entering the handler', async () => {
    const entrypointServices = createServices();
    const entrypoint = createEntrypoint(
      entrypointServices,
      '/foo/cross-owner-async.js',
      ['default']
    );
    const serviceEpoch = services.cache.getCurrentEpoch();
    const sideEffect = jest.fn();
    let controlError: Error | null = null;
    services.eventEmitter = new EventEmitter(
      () => {},
      (phase) => {
        if (phase === 'start' && !controlError) {
          services.cache.beginSupersedeStormRecovery(
            new Error('cross-owner async action recovery')
          );
          controlError = services.cache.getEpochError(serviceEpoch);
        }
        return 0;
      },
      () => {}
    );
    const handlers = getHandlers({
      *workflow() {
        sideEffect();
        return { code: '', sourceMap: null };
      },
    });
    const action = entrypoint.createAction(
      'workflow',
      undefined,
      null,
      undefined,
      services
    );

    await expect(asyncActionRunner(action, handlers)).rejects.toBe(
      controlError
    );
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('prefers the retired services epoch over a later async iterator rejection', async () => {
    const entrypoint = createEntrypoint(services, '/foo/async-rejection.js', [
      'default',
    ]);
    const serviceEpoch = services.cache.getCurrentEpoch();
    const lateError = new Error('late async iterator rejection');
    let controlError: Error | null = null;
    const handlers = getHandlers({
      async *workflow() {
        services.cache.beginSupersedeStormRecovery(
          new Error('async iterator recovery')
        );
        controlError = services.cache.getEpochError(serviceEpoch);
        throw lateError;
      },
    });
    const action = entrypoint.createAction('workflow', undefined, null);

    await expect(asyncActionRunner(action, handlers)).rejects.toBe(
      controlError
    );
    expect(controlError).not.toBe(lateError);
  });

  it('separates cached nested actions by their service scope', () => {
    const analysisServices = createServices();
    const rootEntrypoint = createEntrypoint(services, '/foo/root.js', [
      'default',
    ]);
    const analysisEntrypoint = createEntrypoint(
      analysisServices,
      '/foo/analysis.js',
      ['default']
    );
    const captured: Services[] = [];
    const handlers = getHandlers<'sync'>({
      *workflow(this: IWorkflowAction) {
        yield* this.getNext('transform', analysisEntrypoint, undefined, null);
        yield* this.getNext(
          'transform',
          analysisEntrypoint,
          undefined,
          null,
          analysisServices
        );
        return { code: '', sourceMap: null };
      },
      // eslint-disable-next-line require-yield
      *transform(this: ITransformAction) {
        captured.push(this.services);
        return { code: '', metadata: null };
      },
    });

    syncActionRunner(
      rootEntrypoint.createAction('workflow', undefined, null),
      handlers
    );

    expect(captured).toEqual([services, analysisServices]);
  });

  it('should not run action if its copy was already run', async () => {
    const handler = jest.fn();
    function* handlerGenerator(
      this: IProcessEntrypointAction
    ): SyncScenarioForAction<IProcessEntrypointAction> {
      handler();
      yield ['resolveImports', this.entrypoint, { imports: new Map() }, null];
    }

    const handlers = getHandlers({
      processEntrypoint: handlerGenerator,
    });

    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['default']);
    const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['default']);

    expect(entrypoint1).toBe(entrypoint2);

    const action1 = entrypoint1.createAction(
      'processEntrypoint',
      undefined,
      null
    );
    const action2 = entrypoint2.createAction(
      'processEntrypoint',
      undefined,
      null
    );

    expect(action1).toBe(action2);

    const task1 = asyncActionRunner(action1, handlers);
    const task2 = asyncActionRunner(action2, handlers);
    await Promise.all([task1, task2]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handlers.resolveImports).toHaveBeenCalledTimes(1);
  });

  it('should return value from yielded action', async () => {
    const resolveImportsData = { imports: new Map() };

    const valueCatcher = jest.fn();
    const resolvedImports: IEntrypointDependency[] = [
      {
        source: './bar',
        only: ['default'],
        resolved: '/foo/bar.js',
      },
    ];

    function* resolveImports(): SyncScenarioForAction<IResolveImportsAction> {
      return resolvedImports;
    }

    const handlers = getHandlers({
      *processEntrypoint(
        this: IProcessEntrypointAction
      ): SyncScenarioForAction<IProcessEntrypointAction> {
        const result = yield [
          'resolveImports',
          this.entrypoint,
          resolveImportsData,
          null,
        ];

        valueCatcher(result);
      },
      resolveImports,
    });

    const entrypoint = createEntrypoint(services, '/foo/bar.js', ['default']);

    const action = entrypoint.createAction(
      'processEntrypoint',
      undefined,
      null
    );

    await asyncActionRunner(action, handlers);

    expect(valueCatcher).toBeCalledTimes(1);
    expect(valueCatcher).toBeCalledWith(resolvedImports);
  });

  it('should throw if action was aborted', () => {
    const abortController = new AbortController();
    abortController.abort();

    function* handlerGenerator(
      this: IWorkflowAction
    ): SyncScenarioForAction<IWorkflowAction> {
      yield [
        'processEntrypoint',
        this.entrypoint,
        undefined,
        abortController.signal,
      ];

      throw new Error('Should not be reached');
    }

    const handlers = getHandlers<'sync'>({
      workflow: handlerGenerator,
    });

    const entrypoint = createEntrypoint(services, '/foo/bar.js', ['default']);
    const action = entrypoint.createAction('workflow', undefined, null);

    expect(() => syncActionRunner(action, handlers)).toThrowError(
      /^workflow@\d{5}#1$/
    );
  });

  it('rejects an aborted async action without entering its handler', async () => {
    const abortController = new AbortController();
    abortController.abort();
    const handlerSideEffect = jest.fn();
    const handlers = getHandlers<'async'>({
      async *workflow(): AsyncScenarioForAction<IWorkflowAction> {
        handlerSideEffect();
        return { code: '', sourceMap: null };
      },
    });
    const entrypoint = createEntrypoint(services, '/foo/async-abort.js', [
      'default',
    ]);

    await expect(
      asyncActionRunner(
        entrypoint.createAction('workflow', undefined, abortController.signal),
        handlers
      )
    ).rejects.toBeInstanceOf(AbortError);
    expect(handlerSideEffect).not.toHaveBeenCalled();
  });

  it('should call recover', () => {
    const abortController = new AbortController();
    abortController.abort();

    function* workflow(
      this: IWorkflowAction
    ): SyncScenarioForAction<IWorkflowAction> {
      yield [
        'processEntrypoint',
        this.entrypoint,
        undefined,
        abortController.signal,
      ];

      throw new Error('Should not be reached');
    }

    const shouldNotBeCalled = jest.fn();

    function* processEntrypointMock(
      this: IProcessEntrypointAction
    ): SyncScenarioForAction<IProcessEntrypointAction> {
      shouldNotBeCalled();
    }

    processEntrypointMock.recover = jest.fn<
      YieldArg,
      [e: unknown, action: BaseAction<IProcessEntrypointAction>]
    >((e): YieldArg => {
      throw e;
    });

    const handlers = getHandlers<'sync'>({
      processEntrypoint: processEntrypointMock,
      workflow,
    });

    const entrypoint = createEntrypoint(services, '/foo/bar.js', ['default']);
    const action = entrypoint.createAction('workflow', undefined, null);

    expect(() => syncActionRunner(action, handlers)).toThrowError(
      /^workflow@\d{5}#1$/
    );

    expect(processEntrypointMock.recover).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/^workflow@\d{5}#1$/),
        name: 'AbortError',
      }),
      expect.objectContaining({ type: 'processEntrypoint' })
    );
    expect(shouldNotBeCalled).not.toHaveBeenCalled();
  });

  it('should recover', () => {
    const abortController = new AbortController();
    abortController.abort();

    const shouldBeCalled = jest.fn();

    function* workflow(
      this: IWorkflowAction
    ): SyncScenarioForAction<IWorkflowAction> {
      yield [
        'processEntrypoint',
        this.entrypoint,
        undefined,
        abortController.signal,
      ];

      shouldBeCalled();

      return {
        code: '',
        sourceMap: null,
      };
    }

    function* processEntrypointMock(
      this: IProcessEntrypointAction
      // eslint-disable-next-line @typescript-eslint/no-empty-function
    ): SyncScenarioForAction<IProcessEntrypointAction> {}

    processEntrypointMock.recover = jest.fn<
      YieldArg,
      [e: unknown, action: BaseAction<IProcessEntrypointAction>]
    >((e, action): YieldArg => {
      return ['processEntrypoint', action.entrypoint, undefined, null];
    });

    const handlers = getHandlers<'sync'>({
      processEntrypoint: processEntrypointMock,
      workflow,
    });

    const entrypoint = createEntrypoint(services, '/foo/bar.js', ['default']);
    const action = entrypoint.createAction('workflow', undefined, null);

    syncActionRunner(action, handlers);
    expect(processEntrypointMock.recover).toHaveBeenCalled();
    expect(shouldBeCalled).toHaveBeenCalledTimes(1);
  });

  it('should process triple superseded entrypoint', () => {
    const fooBarDefault = createEntrypoint(services, '/foo/bar.js', [
      'default',
    ]);
    let supersedeCount = 0;

    const handlers = getHandlers<'sync'>({
      transform: function* transform(
        this: ITransformAction
      ): SyncScenarioForAction<ITransformAction> {
        if (supersedeCount === 0) {
          supersedeCount += 1;
          createEntrypoint(services, '/foo/bar.js', ['named']);
          createEntrypoint(services, '/foo/bar.js', ['default', 'bar']);
        }

        return { code: '', metadata: null };
      },
      processEntrypoint,
    });

    const action = fooBarDefault.createAction(
      'processEntrypoint',
      undefined,
      null
    );

    syncActionRunner(action, handlers);
  });

  it('drains finally yields without scheduling cleanup actions', () => {
    let recoveryError: Error | undefined;
    let thrown: unknown;
    const cleanupStarted = jest.fn();
    const cleanupFinished = jest.fn();
    const cleanupActionRan = jest.fn();
    const entrypoint = createEntrypoint(services, '/foo/bar.js', ['default']);
    let actionStarts = 0;
    services.eventEmitter = new EventEmitter(
      () => {},
      (phase) => {
        if (phase === 'start') actionStarts += 1;
        return 0;
      },
      () => {}
    );
    const handlers = getHandlers<'sync'>({
      *workflow(this: IWorkflowAction): SyncScenarioForAction<IWorkflowAction> {
        try {
          const recovery = services.cache.startUnknownGraphRecovery(
            '/foo/recovery.js',
            new Set(['/foo/missing.js']),
            'export const value = 1;',
            services.cache.createGraphTraversalToken(entrypoint.cacheEpoch)
          );
          recoveryError = recovery.abortError;
          recovery.complete();
          yield ['transform', this.entrypoint, undefined, null];
          return { code: '', sourceMap: null };
        } finally {
          cleanupStarted();
          yield ['transform', this.entrypoint, undefined, null];
          cleanupFinished();
        }
      },
      *transform(
        this: ITransformAction
      ): SyncScenarioForAction<ITransformAction> {
        cleanupActionRan();
        return { code: '', metadata: null };
      },
    });

    try {
      syncActionRunner(
        entrypoint.createAction('workflow', undefined, null),
        handlers
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(recoveryError);
    expect(cleanupStarted).toHaveBeenCalledTimes(1);
    expect(cleanupFinished).toHaveBeenCalledTimes(1);
    expect(cleanupActionRan).not.toHaveBeenCalled();
    expect(actionStarts).toBe(1);
  });

  it('bounds sync cleanup that keeps yielding for a child result', () => {
    let recoveryError: Error | undefined;
    let cleanupYields = 0;
    const entrypoint = createEntrypoint(services, '/foo/bounded-close.js', [
      'default',
    ]);
    const handlers = getHandlers<'sync'>({
      *workflow(this: IWorkflowAction): SyncScenarioForAction<IWorkflowAction> {
        try {
          const recovery = services.cache.startUnknownGraphRecovery(
            '/foo/recovery.js',
            new Set(['/foo/missing.js']),
            'export const value = 1;',
            services.cache.createGraphTraversalToken(entrypoint.cacheEpoch)
          );
          recoveryError = recovery.abortError;
          recovery.complete();
          yield ['transform', this.entrypoint, undefined, null];
          return { code: '', sourceMap: null };
        } finally {
          for (;;) {
            cleanupYields += 1;
            yield ['transform', this.entrypoint, undefined, null];
          }
        }
      },
    });

    let thrown: unknown;
    try {
      syncActionRunner(
        entrypoint.createAction('workflow', undefined, null),
        handlers
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(recoveryError);
    expect(cleanupYields).toBeGreaterThan(1);
    expect(cleanupYields).toBeLessThan(40);
  });

  it('bounds async cleanup that keeps yielding for a child result', async () => {
    let recoveryError: Error | undefined;
    let cleanupYields = 0;
    const entrypoint = createEntrypoint(
      services,
      '/foo/bounded-async-close.js',
      ['default']
    );
    const handlers = getHandlers<'async'>({
      async *workflow(
        this: IWorkflowAction
      ): AsyncScenarioForAction<IWorkflowAction> {
        try {
          const recovery = services.cache.startUnknownGraphRecovery(
            '/foo/recovery.js',
            new Set(['/foo/missing.js']),
            'export const value = 1;',
            services.cache.createGraphTraversalToken(entrypoint.cacheEpoch)
          );
          recoveryError = recovery.abortError;
          recovery.complete();
          yield ['transform', this.entrypoint, undefined, null];
          return { code: '', sourceMap: null };
        } finally {
          for (;;) {
            cleanupYields += 1;
            yield ['transform', this.entrypoint, undefined, null];
          }
        }
      },
    });

    await expect(
      asyncActionRunner(
        entrypoint.createAction('workflow', undefined, null),
        handlers
      )
    ).rejects.toBe(recoveryError);
    expect(cleanupYields).toBeGreaterThan(1);
    expect(cleanupYields).toBeLessThan(40);
  });

  it('bounds async cleanup whose return step never settles', async () => {
    let recoveryError: Error | undefined;
    const cleanupStarted = jest.fn();
    const entrypoint = createEntrypoint(
      services,
      '/foo/bounded-stuck-async-close.js',
      ['default']
    );
    const never = new Promise<void>(() => {});
    const handlers = getHandlers<'async'>({
      async *workflow(
        this: IWorkflowAction
      ): AsyncScenarioForAction<IWorkflowAction> {
        try {
          const recovery = services.cache.startUnknownGraphRecovery(
            '/foo/recovery.js',
            new Set(['/foo/missing.js']),
            'export const value = 1;',
            services.cache.createGraphTraversalToken(entrypoint.cacheEpoch)
          );
          recoveryError = recovery.abortError;
          recovery.complete();
          yield ['transform', this.entrypoint, undefined, null];
          return { code: '', sourceMap: null };
        } finally {
          cleanupStarted();
          await never;
        }
      },
    });
    const startedAt = Date.now();

    await expect(
      asyncActionRunner(
        entrypoint.createAction('workflow', undefined, null),
        handlers
      )
    ).rejects.toBe(recoveryError);
    expect(cleanupStarted).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('stops waiting for an async iterator step when its epoch is retired', async () => {
    let markHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    const never = new Promise<void>(() => {});
    const entrypoint = createEntrypoint(
      services,
      '/foo/retired-pending-step.js',
      ['default']
    );
    const handlers = getHandlers<'async'>({
      async *workflow(): AsyncScenarioForAction<IWorkflowAction> {
        markHandlerStarted();
        await never;
        return { code: 'stale', sourceMap: null };
      },
    });
    const running = asyncActionRunner(
      entrypoint.createAction('workflow', undefined, null),
      handlers
    );

    await handlerStarted;
    const startedAt = Date.now();
    const recovery = services.cache.startUnknownGraphRecovery(
      '/foo/recovery.js',
      new Set(['/foo/missing.js']),
      'export const value = 1;',
      services.cache.createGraphTraversalToken(entrypoint.cacheEpoch)
    );
    recovery.complete();

    await expect(running).rejects.toBe(recovery.abortError);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('does not resume stale catch continuations after an epoch failure', () => {
    let recoveryError: Error | undefined;
    let thrown: unknown;
    const continuationStarted = jest.fn();
    const continuationFinished = jest.fn();
    const cleanupFinished = jest.fn();
    const cleanupActionRan = jest.fn();
    const entrypoint = createEntrypoint(services, '/foo/bar.js', ['default']);
    const handlers = getHandlers<'sync'>({
      *workflow(this: IWorkflowAction): SyncScenarioForAction<IWorkflowAction> {
        try {
          const recovery = services.cache.startUnknownGraphRecovery(
            '/foo/recovery.js',
            new Set(['/foo/missing.js']),
            'export const value = 1;',
            services.cache.createGraphTraversalToken(entrypoint.cacheEpoch)
          );
          recoveryError = recovery.abortError;
          recovery.complete();
          throw recovery.abortError;
        } catch {
          yield ['transform', this.entrypoint, undefined, null];
          continuationStarted();
          yield ['transform', this.entrypoint, undefined, null];
          continuationFinished();
        } finally {
          cleanupFinished();
        }

        return { code: '', sourceMap: null };
      },
      *transform(
        this: ITransformAction
      ): SyncScenarioForAction<ITransformAction> {
        cleanupActionRan();
        return { code: '', metadata: null };
      },
    });

    try {
      syncActionRunner(
        entrypoint.createAction('workflow', undefined, null),
        handlers
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(recoveryError);
    expect(continuationStarted).not.toHaveBeenCalled();
    expect(continuationFinished).not.toHaveBeenCalled();
    expect(cleanupFinished).toHaveBeenCalledTimes(1);
    expect(cleanupActionRan).not.toHaveBeenCalled();
  });

  it('does not resume a parent action after its cache epoch is retired', async () => {
    let releaseChild!: () => void;
    let markChildStarted!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });
    const parentResumed = jest.fn();
    const parentCaught = jest.fn();
    const parentClosed = jest.fn();
    const childClosed = jest.fn();
    const entrypoint = createEntrypoint(services, '/foo/bar.js', ['default']);
    const handlers = getHandlers<'async'>({
      async *workflow(
        this: IWorkflowAction
      ): AsyncScenarioForAction<IWorkflowAction> {
        try {
          yield ['processEntrypoint', this.entrypoint, undefined, null];
          parentResumed();
          return { code: '', sourceMap: null };
        } catch {
          parentCaught();
          return { code: 'stale fallback', sourceMap: null };
        } finally {
          parentClosed();
        }
      },
      async *processEntrypoint(
        this: IProcessEntrypointAction
      ): AsyncScenarioForAction<IProcessEntrypointAction> {
        this.entrypoint.beginProcessing();
        try {
          markChildStarted();
          await childGate;
        } finally {
          this.entrypoint.endProcessing();
          childClosed();
        }
      },
    });
    const running = asyncActionRunner(
      entrypoint.createAction('workflow', undefined, null),
      handlers
    );

    await childStarted;
    const recovery = services.cache.startUnknownGraphRecovery(
      '/foo/recovery.js',
      new Set(['/foo/missing.js']),
      'export const value = 1;',
      services.cache.createGraphTraversalToken(entrypoint.cacheEpoch)
    );
    recovery.complete();
    releaseChild();

    await expect(running).rejects.toBe(recovery.abortError);
    expect(parentResumed).not.toHaveBeenCalled();
    expect(parentCaught).not.toHaveBeenCalled();
    expect(parentClosed).toHaveBeenCalledTimes(1);
    expect(childClosed).toHaveBeenCalledTimes(1);
    expect(entrypoint.isProcessing).toBe(false);
  });

  it('does not resume a superseded parent after a distinct child succeeds', async () => {
    let releaseChild!: () => void;
    let markChildStarted!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });
    const parentResumed = jest.fn();
    const parent = createEntrypoint(services, '/foo/parent.js', ['default']);
    const child = createEntrypoint(services, '/foo/child.js', ['default']);
    const handlers = getHandlers<'async'>({
      async *workflow(
        this: IWorkflowAction
      ): AsyncScenarioForAction<IWorkflowAction> {
        yield ['processEntrypoint', child, undefined, null];
        parentResumed();
        return { code: 'stale', sourceMap: null };
      },
      async *processEntrypoint(): AsyncScenarioForAction<IProcessEntrypointAction> {
        markChildStarted();
        await childGate;
      },
    });
    const running = asyncActionRunner(
      parent.createAction('workflow', undefined, null),
      handlers
    );

    await childStarted;
    createEntrypoint(services, parent.name, ['replacement']);
    releaseChild();

    await expect(running).rejects.toBeInstanceOf(AbortError);
    expect(parentResumed).not.toHaveBeenCalled();
  });
});
