/* eslint-disable require-yield */
import { EventEmitter } from '../../../utils/EventEmitter';
import { syncActionRunner } from '../../actions/actionRunner';
import type {
  IProcessEntrypointAction,
  SyncScenarioForAction,
} from '../../types';
import {
  createEntrypoint,
  createServices,
  getHandlers,
} from '../../__tests__/entrypoint-helpers';
import { processImports } from '../processImports';

describe('processImports', () => {
  it('reprocesses fresh transformed dependencies during __wywPreval prepare stage', () => {
    const services = createServices();
    const parent = createEntrypoint(
      services,
      '/foo/parent.js',
      ['__wywPreval'],
      'import { value } from "./dep.js";'
    );
    const depPath = '/foo/dep.js';
    const depCode = 'export const value = 1;';
    const depEntrypoint = createEntrypoint(
      services,
      depPath,
      ['value'],
      depCode
    );
    depEntrypoint.setTransformResult({ code: depCode, metadata: null });

    services.cache.add('entrypoints', depPath, depEntrypoint);

    const freshnessSpy = jest
      .spyOn(services.cache, 'checkFreshness')
      .mockReturnValue(false);
    const createChildSpy = jest.spyOn(parent, 'createChild');
    const handlers = getHandlers<'sync'>({
      processImports,
    });

    const action = parent.createAction(
      'processImports',
      {
        resolved: [
          {
            only: ['value'],
            resolved: depPath,
            source: './dep.js',
          },
        ],
      },
      null
    );

    syncActionRunner(action, handlers);

    expect(freshnessSpy).not.toHaveBeenCalled();
    expect(createChildSpy).toHaveBeenCalledWith(
      depPath,
      ['__wywPreval', 'value'],
      undefined,
      services
    );
    expect(handlers.processEntrypoint).toHaveBeenCalledTimes(1);
  });

  it('reuses fresh transformed dependencies outside __wywPreval prepare stage', () => {
    const services = createServices();
    const parent = createEntrypoint(
      services,
      '/foo/parent.js',
      ['value'],
      'import { value } from "./dep.js"; export { value };'
    );
    const depPath = '/foo/dep.js';
    const depCode = 'export const value = 1;';
    const depEntrypoint = createEntrypoint(
      services,
      depPath,
      ['value'],
      depCode
    );
    depEntrypoint.setTransformResult({ code: depCode, metadata: null });

    services.cache.add('entrypoints', depPath, depEntrypoint);

    const freshnessSpy = jest
      .spyOn(services.cache, 'checkFreshness')
      .mockReturnValue(false);
    const createChildSpy = jest.spyOn(parent, 'createChild');
    const handlers = getHandlers<'sync'>({
      processImports,
    });

    const action = parent.createAction(
      'processImports',
      {
        resolved: [
          {
            only: ['value'],
            resolved: depPath,
            source: './dep.js',
          },
        ],
      },
      null
    );

    syncActionRunner(action, handlers);

    expect(freshnessSpy).toHaveBeenCalledWith(depPath, depPath);
    expect(createChildSpy).not.toHaveBeenCalled();
    expect(handlers.processEntrypoint).not.toHaveBeenCalled();
    expect(depEntrypoint.parents).toContain(parent);
  });

  it('reuses evaluated dependencies during __wywPreval prepare stage when the module has no __wywPreval export', () => {
    const services = createServices();
    const parent = createEntrypoint(
      services,
      '/foo/parent.js',
      ['__wywPreval'],
      'import { value } from "./dep.js";'
    );
    const depPath = '/foo/dep.js';
    const depCode = 'export const value = 1;';
    const depEntrypoint = createEntrypoint(
      services,
      depPath,
      ['value'],
      depCode
    );
    depEntrypoint.setTransformResult({ code: depCode, metadata: null });

    const evaluated = depEntrypoint.createEvaluated();
    services.cache.add('entrypoints', depPath, evaluated);

    const freshnessSpy = jest
      .spyOn(services.cache, 'checkFreshness')
      .mockReturnValue(false);
    const createChildSpy = jest.spyOn(parent, 'createChild');
    const handlers = getHandlers<'sync'>({
      processImports,
    });

    const action = parent.createAction(
      'processImports',
      {
        resolved: [
          {
            only: ['value'],
            resolved: depPath,
            source: './dep.js',
          },
        ],
      },
      null
    );

    syncActionRunner(action, handlers);

    expect(freshnessSpy).toHaveBeenCalledWith(depPath, depPath);
    expect(createChildSpy).not.toHaveBeenCalled();
    expect(handlers.processEntrypoint).not.toHaveBeenCalled();
    expect(evaluated.parents).toContain(parent);
  });

  it('reprocesses evaluated dependencies during __wywPreval prepare stage when the module exports __wywPreval', () => {
    const services = createServices();
    const parent = createEntrypoint(
      services,
      '/foo/parent.js',
      ['__wywPreval'],
      'import { value } from "./dep.js";'
    );
    const depPath = '/foo/dep.js';
    const depCode =
      'export const value = 1; export const __wywPreval = { value: () => value };';
    const depEntrypoint = createEntrypoint(
      services,
      depPath,
      ['value'],
      depCode
    );
    depEntrypoint.setTransformResult({ code: depCode, metadata: null });

    const evaluated = depEntrypoint.createEvaluated();
    services.cache.add('entrypoints', depPath, evaluated);

    const freshnessSpy = jest
      .spyOn(services.cache, 'checkFreshness')
      .mockReturnValue(false);
    const createChildSpy = jest.spyOn(parent, 'createChild');
    const handlers = getHandlers<'sync'>({
      processImports,
    });

    const action = parent.createAction(
      'processImports',
      {
        resolved: [
          {
            only: ['value'],
            resolved: depPath,
            source: './dep.js',
          },
        ],
      },
      null
    );

    syncActionRunner(action, handlers);

    expect(freshnessSpy).not.toHaveBeenCalled();
    expect(createChildSpy).toHaveBeenCalledWith(
      depPath,
      ['__wywPreval', 'value'],
      undefined,
      services
    );
    expect(handlers.processEntrypoint).toHaveBeenCalledTimes(1);
  });

  it('reprocesses evaluated dependencies when freshness check invalidates them', () => {
    const services = createServices();
    const parent = createEntrypoint(
      services,
      '/foo/parent.js',
      ['__wywPreval'],
      'import { value } from "./dep.js";'
    );
    const depPath = '/foo/dep.js';
    const depEntrypoint = createEntrypoint(
      services,
      depPath,
      ['value'],
      'export const value = 1;'
    );
    depEntrypoint.setTransformResult({
      code: 'export const value = 1;',
      metadata: null,
    });

    services.cache.add('entrypoints', depPath, depEntrypoint.createEvaluated());

    jest.spyOn(services.cache, 'checkFreshness').mockReturnValue(true);
    const createChildSpy = jest.spyOn(parent, 'createChild');
    const handlers = getHandlers<'sync'>({
      processImports,
    });

    const action = parent.createAction(
      'processImports',
      {
        resolved: [
          {
            only: ['value'],
            resolved: depPath,
            source: './dep.js',
          },
        ],
      },
      null
    );

    syncActionRunner(action, handlers);

    expect(createChildSpy).toHaveBeenCalledWith(
      depPath,
      ['value'],
      undefined,
      services
    );
    expect(handlers.processEntrypoint).toHaveBeenCalledTimes(1);
  });
  it('continues on the successor when a dependency is superseded while it is processed', () => {
    const services = createServices();
    const parent = createEntrypoint(
      services,
      '/foo/parent.js',
      ['__wywPreval'],
      'import { value } from "./dep.js";'
    );
    const depPath = '/foo/dep.js';
    const processed: string[][] = [];
    let nextActionId = 0;
    let depTransformActionId: number | null = null;
    let reentered = false;
    services.eventEmitter = new EventEmitter(
      () => {},
      (...args) => {
        if (args[0] === 'start') {
          const id = nextActionId;
          nextActionId += 1;
          if (args[2] === 'transform' && depTransformActionId === null) {
            depTransformActionId = id;
          }
          return id;
        }
        if (
          args[0] === 'finish' &&
          args[2] === depTransformActionId &&
          !reentered
        ) {
          reentered = true;
          // A concurrent root widens the dependency while its own transform
          // finishes: the dependency's result acceptance is fenced.
          createEntrypoint(services, depPath, ['other', 'value']);
        }
        return undefined;
      },
      () => {}
    );
    const handlers = getHandlers<'sync'>({
      processImports,
      *processEntrypoint(
        this: IProcessEntrypointAction
      ): SyncScenarioForAction<IProcessEntrypointAction> {
        processed.push([...this.entrypoint.only]);
        yield ['transform', this.entrypoint, undefined, null];
      },
      *transform() {
        return { code: '', metadata: null };
      },
    });

    const action = parent.createAction(
      'processImports',
      {
        resolved: [
          {
            only: ['value'],
            resolved: depPath,
            source: './dep.js',
          },
        ],
      },
      null
    );

    expect(() => syncActionRunner(action, handlers)).not.toThrow();
    expect(processed).toEqual([
      ['__wywPreval', 'value'],
      ['__wywPreval', 'other', 'value'],
    ]);
    expect(parent.supersededWith).toBeNull();
  });
});
