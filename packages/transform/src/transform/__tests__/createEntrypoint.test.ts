import type { Services } from '../types';
import { createActionContext, disposeActionContext } from '../ActionContext';
import { EventEmitter } from '../../utils/EventEmitter';
import { AbortError } from '../actions/AbortError';

import { createEntrypoint, createServices } from './entrypoint-helpers';

describe('createEntrypoint', () => {
  let services: Services;

  beforeEach(() => {
    services = createServices();
  });

  it('should create a new entrypoint', () => {
    const entrypoint = createEntrypoint(services, '/foo/bar.js', ['default']);
    expect(entrypoint).toMatchObject({
      name: '/foo/bar.js',
      only: ['default'],
      parents: [],
    });
  });

  it('rejects construction when an entrypoint event retires its epoch', () => {
    const cacheEpoch = services.cache.getCurrentEpoch();
    const recoveryError = new Error('reentrant event recovery');
    services.eventEmitter = new EventEmitter(
      () => {},
      () => 0,
      () => services.cache.beginSupersedeStormRecovery(recoveryError)
    );

    let thrown: unknown;
    try {
      createEntrypoint(services, '/foo/reentrant-event.js', ['default']);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(services.cache.getEpochError(cacheEpoch));
    expect(services.cache.get('entrypoints', '/foo/reentrant-event.js')).toBe(
      undefined
    );
  });

  it('rejects construction when loadAndParseFn retires its epoch', () => {
    const cacheEpoch = services.cache.getCurrentEpoch();
    const recoveryError = new Error('reentrant loader recovery');
    const { loadAndParseFn } = services;
    services.loadAndParseFn = (...args) => {
      const result = loadAndParseFn(...args);
      services.cache.beginSupersedeStormRecovery(recoveryError);
      return result;
    };

    let thrown: unknown;
    try {
      createEntrypoint(services, '/foo/reentrant-loader.js', ['default']);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(services.cache.getEpochError(cacheEpoch));
    expect(services.cache.get('entrypoints', '/foo/reentrant-loader.js')).toBe(
      undefined
    );
  });

  it('preserves a same-key replacement created from the created callback', () => {
    const name = '/foo/reentrant-same-key.js';
    let replacement: ReturnType<typeof createEntrypoint> | undefined;
    let reentered = false;
    services.eventEmitter = new EventEmitter(
      () => {},
      () => 0,
      (_sequenceId, _timestamp, event) => {
        if (event.type === 'created' && !reentered) {
          reentered = true;
          replacement = createEntrypoint(
            services,
            name,
            ['replacement'],
            'export const replacement = true;'
          );
        }
      }
    );

    expect(() =>
      createEntrypoint(services, name, ['stale'], 'export const stale = true;')
    ).toThrow(AbortError);
    expect(services.cache.get('entrypoints', name)).toBe(replacement);
    expect(replacement?.initialCode).toBe('export const replacement = true;');
  });

  it('preserves a same-key replacement created from the perf finish callback', () => {
    const name = '/foo/reentrant-perf-same-key.js';
    let replacement: ReturnType<typeof createEntrypoint> | undefined;
    let reentered = false;
    services.eventEmitter = new EventEmitter(
      (_labels, phase) => {
        if (phase === 'finish' && !reentered) {
          reentered = true;
          replacement = createEntrypoint(services, name, ['replacement'], '');
        }
      },
      () => 0,
      () => {}
    );

    expect(() => createEntrypoint(services, name, ['stale'], '')).toThrow(
      AbortError
    );
    expect(services.cache.get('entrypoints', name)).toBe(replacement);
    expect(replacement?.only).toEqual(['replacement', 'stale']);
  });

  it('rejects an evaluated clone when its source epoch retires during the target event', () => {
    const source = createEntrypoint(services, '/foo/reentrant-evaluated.js', [
      'default',
    ]);
    const sourceEpoch = services.cache.getCurrentEpoch();
    const targetServices = createServices();
    const recoveryError = new Error('reentrant evaluated recovery');
    targetServices.eventEmitter = new EventEmitter(
      () => {},
      () => 0,
      () => services.cache.beginSupersedeStormRecovery(recoveryError)
    );

    let thrown: unknown;
    try {
      source.createEvaluated(targetServices);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(services.cache.getEpochError(sourceEpoch));
    expect(
      targetServices.cache.get('entrypoints', '/foo/reentrant-evaluated.js')
    ).toBeUndefined();
  });

  it('rejects an evaluated clone when its target epoch retires during the created event', () => {
    const source = createEntrypoint(
      services,
      '/foo/reentrant-evaluated-target.js',
      ['default']
    );
    const targetServices = createServices();
    const targetEpoch = targetServices.cache.getCurrentEpoch();
    const recoveryError = new Error('reentrant evaluated target recovery');
    targetServices.eventEmitter = new EventEmitter(
      () => {},
      () => 0,
      () => targetServices.cache.beginSupersedeStormRecovery(recoveryError)
    );

    let thrown: unknown;
    try {
      source.createEvaluated(targetServices);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(targetServices.cache.getEpochError(targetEpoch));
    expect(services.cache.getEpochError(source.cacheEpoch)).toBeNull();
  });

  it('rejects an evaluated clone when its source is superseded in the same epoch', () => {
    const name = '/foo/reentrant-evaluated-same-epoch.js';
    const source = createEntrypoint(services, name, ['default'], '');
    let replacement: ReturnType<typeof createEntrypoint> | undefined;
    let reentered = false;
    services.eventEmitter = new EventEmitter(
      () => {},
      () => 0,
      (_sequenceId, _timestamp, event) => {
        if (event.type === 'created' && !reentered) {
          reentered = true;
          replacement = createEntrypoint(services, name, ['replacement'], '');
        }
      }
    );

    expect(() => source.createEvaluated(services)).toThrow(AbortError);
    expect(source.supersededWith).toBe(replacement);
    expect(services.cache.get('entrypoints', name)).toBe(replacement);
  });

  it('does not publish a cross-cache child when its parent epoch retires during the target event', () => {
    const parent = createEntrypoint(services, '/foo/parent.js', ['default']);
    const parentEpoch = services.cache.getCurrentEpoch();
    const targetServices = createServices();
    const recoveryError = new Error('reentrant child recovery');
    targetServices.eventEmitter = new EventEmitter(
      () => {},
      () => 0,
      () => services.cache.beginSupersedeStormRecovery(recoveryError)
    );

    let thrown: unknown;
    try {
      parent.createChild(
        '/foo/reentrant-child.js',
        ['default'],
        undefined,
        targetServices
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(services.cache.getEpochError(parentEpoch));
    expect(
      targetServices.cache.get('entrypoints', '/foo/reentrant-child.js')
    ).toBeUndefined();
  });

  it('does not publish a cross-cache child when the target perf callback retires its parent', () => {
    const parent = createEntrypoint(services, '/foo/parent-perf.js', [
      'default',
    ]);
    const parentEpoch = services.cache.getCurrentEpoch();
    const targetServices = createServices();
    const recoveryError = new Error('reentrant child perf recovery');
    targetServices.eventEmitter = new EventEmitter(
      (_labels, phase) => {
        if (phase === 'finish') {
          services.cache.beginSupersedeStormRecovery(recoveryError);
        }
      },
      () => 0,
      () => {}
    );

    let thrown: unknown;
    try {
      parent.createChild(
        '/foo/reentrant-perf-child.js',
        ['default'],
        undefined,
        targetServices
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(services.cache.getEpochError(parentEpoch));
    expect(
      targetServices.cache.get('entrypoints', '/foo/reentrant-perf-child.js')
    ).toBeUndefined();
  });

  it('does not mutate a cached cross-cache child when its parent retires during replacement', () => {
    const parent = createEntrypoint(services, '/foo/parent-cached.js', [
      'default',
    ]);
    const parentEpoch = services.cache.getCurrentEpoch();
    const targetServices = createServices();
    const childName = '/foo/reentrant-cached-child.js';
    const childCode = '';
    const cachedChild = createEntrypoint(
      targetServices,
      childName,
      ['value'],
      childCode
    );
    const recoveryError = new Error('reentrant cached-child recovery');
    targetServices.eventEmitter = new EventEmitter(
      () => {},
      () => 0,
      () => services.cache.beginSupersedeStormRecovery(recoveryError)
    );

    let thrown: unknown;
    try {
      parent.createChild(childName, ['other'], childCode, targetServices);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(services.cache.getEpochError(parentEpoch));
    expect(targetServices.cache.get('entrypoints', childName)).toBe(
      cachedChild
    );
    expect(cachedChild.supersededWith).toBeNull();
    expect(cachedChild.parents).toEqual([]);
    expect(cachedChild.only).toEqual(['value']);
  });

  it('publishes a detached deferred retry through a distinct cache owner', () => {
    const sourceServices = createServices();
    const parent = createEntrypoint(services, '/foo/deferred-parent.js', [
      'default',
    ]);
    const childName = '/foo/deferred-cross-owner.js';
    const child = parent.createChild(childName, ['first'], '', services);
    expect(child).not.toBe('loop');
    if (child === 'loop') return;

    child.beginProcessing();
    try {
      expect(parent.createChild(childName, ['second'], '', services)).toBe(
        child
      );
      const next = child.applyDeferredSupersede(sourceServices);

      expect(next).not.toBeNull();
      expect(child.supersededWith).toBeNull();
      expect(sourceServices.cache.get('entrypoints', childName)).toBe(next);
      expect(services.cache.get('entrypoints', childName)).toBe(child);
      expect(next?.only).toEqual(['first', 'second']);
      expect(createEntrypoint(services, childName, ['first'], '')).toBe(child);
    } finally {
      child.endProcessing();
    }
  });

  it('should take from cache', () => {
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['default']);
    const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['default']);
    expect(entrypoint1).toBe(entrypoint2);
  });

  it('disposes actions created for a completed transform context', () => {
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['default']);
    const entrypoint2 = createEntrypoint(services, '/foo/baz.js', ['default']);
    const actionContext = createActionContext();
    const action1 = entrypoint1.createAction(
      'workflow',
      undefined,
      null,
      actionContext
    );
    const action2 = entrypoint2.createAction(
      'workflow',
      undefined,
      null,
      actionContext
    );

    disposeActionContext(actionContext);

    expect(
      entrypoint1.createAction('workflow', undefined, null, actionContext)
    ).not.toBe(action1);
    expect(
      entrypoint2.createAction('workflow', undefined, null, actionContext)
    ).not.toBe(action2);
  });

  it('should invalidate cache if source code was changed', () => {
    const entrypoint1 = createEntrypoint(
      services,
      '/foo/bar.js',
      ['default'],
      'foo'
    );
    const entrypoint2 = createEntrypoint(
      services,
      '/foo/bar.js',
      ['default'],
      'bar'
    );
    expect(entrypoint1).not.toBe(entrypoint2);
    expect(entrypoint1.supersededWith).toBe(entrypoint2);
  });

  it('should not take from cache if path differs', () => {
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['default']);
    const entrypoint2 = createEntrypoint(services, '/foo/baz.js', ['default']);
    expect(entrypoint1).not.toBe(entrypoint2);
    expect(entrypoint1).toMatchObject({
      name: '/foo/bar.js',
      only: ['default'],
    });
    expect(entrypoint2).toMatchObject({
      name: '/foo/baz.js',
      only: ['default'],
    });
  });

  it('should not take from cache if only differs', () => {
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['default']);
    const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['named']);
    expect(entrypoint1).not.toBe(entrypoint2);
    expect(entrypoint1.supersededWith).toBe(entrypoint2);
    expect(entrypoint2).toMatchObject({
      name: '/foo/bar.js',
      only: ['default', 'named'],
    });
  });

  it('uses the requesting services when widening a cached root', () => {
    let originalEmitterClosed = false;
    const assertOriginalEmitterOpen = () => {
      if (originalEmitterClosed) {
        throw new Error('stale entrypoint emitter was used');
      }
    };
    services.eventEmitter = new EventEmitter(
      assertOriginalEmitterOpen,
      () => {
        assertOriginalEmitterOpen();
        return 0;
      },
      assertOriginalEmitterOpen
    );

    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['default']);
    originalEmitterClosed = true;

    const nextEvents: string[] = [];
    const nextServices: Services = {
      ...services,
      eventEmitter: new EventEmitter(
        () => {},
        () => 0,
        (_sequenceId, _timestamp, event) => nextEvents.push(event.type)
      ),
    };
    const entrypoint2 = createEntrypoint(nextServices, '/foo/bar.js', [
      'named',
    ]);

    expect(entrypoint2).not.toBe(entrypoint1);
    expect(entrypoint1.supersededWith).toBe(entrypoint2);
    expect(entrypoint2.only).toEqual(['default', 'named']);
    expect(nextEvents).toEqual(
      expect.arrayContaining(['created', 'superseded'])
    );
  });

  it('should take from cache if only is subset of cached', () => {
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', [
      'default',
      'named',
    ]);
    const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['default']);
    expect(entrypoint1).toBe(entrypoint2);
  });

  it('should take from cache if wildcard is cached', () => {
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['*']);
    const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['default']);
    expect(entrypoint1).toBe(entrypoint2);
  });

  it('widens root requests immediately when cached entrypoint is processing', () => {
    const entrypoint1 = createEntrypoint(
      services,
      '/foo/bar.js',
      ['__wywPreval'],
      'export const named = 1;'
    );

    entrypoint1.beginProcessing();

    try {
      const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['named']);

      expect(entrypoint2).not.toBe(entrypoint1);
      expect(entrypoint1.supersededWith).toBe(entrypoint2);
      expect(entrypoint2.only).toEqual(['__wywPreval', 'named']);
    } finally {
      entrypoint1.endProcessing();
    }
  });

  it('should call callback if entrypoint was superseded', () => {
    const callback = jest.fn();
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['default']);

    entrypoint1.onSupersede(callback);

    const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['named']);
    expect(entrypoint1).not.toBe(entrypoint2);
    expect(entrypoint1.supersededWith).toBe(entrypoint2);
    expect(callback).toBeCalledWith(entrypoint2);
  });

  it('should not call supersede callback if it was unsubscribed', () => {
    const callback = jest.fn();
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['default']);

    const unsubscribe = entrypoint1.onSupersede(callback);
    unsubscribe();

    const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['named']);
    expect(entrypoint1).not.toBe(entrypoint2);
    expect(entrypoint1.supersededWith).toBe(entrypoint2);
    expect(callback).not.toBeCalled();
  });

  it('should keep requested only for safe modules', () => {
    services.loadAndParseFn = jest.fn((s, name, loadedCode) => ({
      ast: s.babel.parseSync(loadedCode ?? '', {
        babelrc: false,
        configFile: false,
        filename: name,
      })!,
      code: loadedCode ?? '',
      evaluator: jest.fn(),
      evalConfig: {},
    }));

    const code = `
      export const a = 1;
      export const b = 2;
      export const c = { x: 'y' };
    `;

    const entrypoint1 = createEntrypoint(
      services,
      '/foo/tokens.ts',
      ['a'],
      code
    );
    expect(entrypoint1.only).toEqual(['a']);

    const entrypoint2 = createEntrypoint(
      services,
      '/foo/tokens.ts',
      ['b'],
      code
    );
    expect(entrypoint2).not.toBe(entrypoint1);
    expect(entrypoint2.only).toEqual(['a', 'b']);
  });

  it('reuses transformed state from evaluated cache when only is unchanged', () => {
    const loadAndParseFn = jest.fn((s, name, loadedCode) => ({
      ast: s.babel.parseSync(loadedCode ?? '', {
        babelrc: false,
        configFile: false,
        filename: name,
      })!,
      code: loadedCode ?? '',
      evaluator: jest.fn(),
      evalConfig: {},
    }));
    services.loadAndParseFn = loadAndParseFn;

    const code = 'export const value = 1;';
    const entrypoint1 = createEntrypoint(
      services,
      '/foo/bar.js',
      ['value'],
      code
    );
    const preevalResult = {
      ast: null,
      code,
      dependencyNames: [],
      metadata: null,
      staticValueCache: new Map([['_exp', 'red']]),
    };
    entrypoint1.setPreevalResult(preevalResult);
    entrypoint1.setTransformResult({ code, metadata: null });
    const evaluated = entrypoint1.createEvaluated();
    services.cache.add('entrypoints', '/foo/bar.js', evaluated);

    const entrypoint2 = createEntrypoint(
      services,
      '/foo/bar.js',
      ['value'],
      code
    );

    expect(loadAndParseFn).toHaveBeenCalledTimes(1);
    expect(services.cache.get('entrypoints', '/foo/bar.js')).toBe(evaluated);
    expect(entrypoint2.transformedCode).toBe(code);
    expect(entrypoint2.loadedAndParsed.code).toBe(code);
    expect(entrypoint2.loadedAndParsed).toBe(evaluated.loadedAndParsed);
    expect(entrypoint2.getPreevalResult()).toBe(preevalResult);
  });

  it('reuses evaluated parsed state when only changes', () => {
    const loadAndParseFn = jest.fn((s, name, loadedCode) => ({
      ast: s.babel.parseSync(loadedCode ?? '', {
        babelrc: false,
        configFile: false,
        filename: name,
      })!,
      code: loadedCode ?? '',
      evaluator: jest.fn(),
      evalConfig: {},
    }));
    services.loadAndParseFn = loadAndParseFn;

    const code = 'export const a = 1; export const b = 2;';
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['a'], code);
    entrypoint1.setTransformResult({ code, metadata: null });
    const evaluated = entrypoint1.createEvaluated();
    services.cache.add('entrypoints', '/foo/bar.js', evaluated);

    const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['b'], code);

    expect(loadAndParseFn).toHaveBeenCalledTimes(1);
    expect(entrypoint2.loadedAndParsed).toBe(evaluated.loadedAndParsed);
  });

  it('does not reuse transformed state when cached evaluated exports are narrower than requested only', () => {
    const loadAndParseFn = jest.fn((s, name, loadedCode) => ({
      ast: s.babel.parseSync(loadedCode ?? '', {
        babelrc: false,
        configFile: false,
        filename: name,
      })!,
      code: loadedCode ?? '',
      evaluator: jest.fn(),
      evalConfig: {},
    }));
    services.loadAndParseFn = loadAndParseFn;

    const code = 'export const a = 1; export const b = 2; export const c = 3;';
    const narrowPreparedCode = 'export const a = 1; export const b = 2;';
    const entrypoint1 = createEntrypoint(
      services,
      '/foo/bar.js',
      ['a', 'b'],
      code
    );
    entrypoint1.setTransformResult({
      code: narrowPreparedCode,
      metadata: null,
    });
    const evaluated = entrypoint1.createEvaluated();

    (evaluated as unknown as { only: string[] }).only = ['a', 'b', 'c'];

    services.cache.add('entrypoints', '/foo/bar.js', evaluated);

    const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['c'], code);

    expect(loadAndParseFn).toHaveBeenCalledTimes(1);
    expect(entrypoint2.loadedAndParsed).toBe(evaluated.loadedAndParsed);
    expect(entrypoint2.only).toEqual(['a', 'b', 'c']);
    expect(entrypoint2.evaluatedOnly).toEqual(['a', 'b']);
    expect(entrypoint2.transformedCode).toBeNull();
  });

  it('preserves wider cached only when creating loaded root passes', () => {
    const loadAndParseFn = jest.fn((s, name, loadedCode) => ({
      ast: s.babel.parseSync(loadedCode ?? '', {
        babelrc: false,
        configFile: false,
        filename: name,
      })!,
      code: loadedCode ?? '',
      evaluator: jest.fn(),
      evalConfig: {},
    }));
    services.loadAndParseFn = loadAndParseFn;

    const code = 'export const Styles = {};';
    const dependencyEntrypoint = createEntrypoint(
      services,
      '/foo/styles.ts',
      ['Styles'],
      code
    );
    dependencyEntrypoint.setTransformResult({ code, metadata: null });
    const evaluated = dependencyEntrypoint.createEvaluated();
    services.cache.add('entrypoints', '/foo/styles.ts', evaluated);

    const rootEntrypoint = createEntrypoint(
      services,
      '/foo/styles.ts',
      ['__wywPreval'],
      code
    );

    expect(loadAndParseFn).toHaveBeenCalledTimes(1);
    expect(rootEntrypoint).not.toBe(evaluated);
    expect(rootEntrypoint.only).toEqual(['Styles', '__wywPreval']);
    expect(rootEntrypoint.loadedAndParsed).toBe(evaluated.loadedAndParsed);
    expect(rootEntrypoint.transformedCode).toBeNull();
  });
});
