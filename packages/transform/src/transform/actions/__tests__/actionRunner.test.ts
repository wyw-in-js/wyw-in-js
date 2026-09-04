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
    expect(parentClosed).toHaveBeenCalledTimes(1);
    expect(childClosed).toHaveBeenCalledTimes(1);
    expect(entrypoint.isProcessing).toBe(false);
  });
});
