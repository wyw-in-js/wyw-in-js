import { AbortError } from '../../actions/AbortError';
import {
  createEntrypoint,
  createServices,
} from '../../__tests__/entrypoint-helpers';
import { createPrevalPayload } from '../../prevalPayload';
import type { Services } from '../../types';
import { workflow } from '../workflow';

const oldCode = 'export const token = "old";';
const newCode = 'export const token = "new";';
const name = '/src/entry.tsx';

const evalPayload = createPrevalPayload({
  evalDependencies: [],
  evalValues: new Map(),
  filename: name,
  strategy: 'hybrid',
});

const collectResult = {
  code: 'OLD-COLLECT',
  map: null,
  metadata: {
    dependencies: [],
    processors: [],
    replacements: [],
    rules: {},
  },
};

const extractResult = {
  cssSourceMapText: '',
  cssText: 'OLD-CSS',
  replacements: [],
  rules: {},
};

const prepareWorkflow = () => {
  const services = createServices();
  services.options = {
    pluginOptions: { outputMetadata: false },
  } as Services['options'];
  const entrypoint = createEntrypoint(services, name, [], oldCode);
  entrypoint.setTransformResult({
    code: oldCode,
    metadata: {
      dependencies: [],
      processors: [],
      replacements: [],
      rules: {},
    },
  });
  const action = entrypoint.createAction('workflow', undefined, null);
  const generator = workflow.call(action);
  generator.next();
  generator.next(undefined);

  const evaluated = entrypoint.createEvaluated(services);
  services.cache.add('entrypoints', name, evaluated);
  entrypoint
    .createAction('evalFile', undefined, null, action.actionContext, services)
    .recordCachePublication(evaluated);

  return { action, entrypoint, evaluated, generator, services };
};

describe('workflow publication fencing', () => {
  it('accepts the exact root-to-evaluated publication produced by eval', () => {
    const { generator } = prepareWorkflow();

    const afterEval = generator.next(evalPayload);

    expect(afterEval.done).toBe(false);
    expect(afterEval.value[0]).toBe('collect');
  });

  it('rejects an eval payload after another root replaces its publication', () => {
    const { entrypoint, generator, services } = prepareWorkflow();
    const replacement = createEntrypoint(services, name, [], newCode);

    expect(services.cache.get('entrypoints', name)).toBe(replacement);
    expect(entrypoint.supersededWith).toBeNull();
    expect(() => generator.next(evalPayload)).toThrow(AbortError);
  });

  it('rejects a replacement published while extract is running', () => {
    const { entrypoint, generator, services } = prepareWorkflow();
    generator.next(evalPayload);
    const afterCollect = generator.next(collectResult);
    expect(afterCollect.done).toBe(false);
    expect(afterCollect.value[0]).toBe('extract');

    const replacement = createEntrypoint(services, name, [], newCode);
    expect(services.cache.get('entrypoints', name)).toBe(replacement);
    expect(entrypoint.supersededWith).toBeNull();

    expect(() => generator.next(extractResult)).toThrow(AbortError);
  });
});
