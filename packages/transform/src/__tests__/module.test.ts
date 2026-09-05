import fs from 'fs';
import os from 'os';
import path from 'path';
import type * as vm from 'vm';

import * as babel from '@babel/core';
import dedent from 'dedent';

import type { StrictOptions } from '@wyw-in-js/shared';
import { logger } from '@wyw-in-js/shared';

import { TransformCacheCollection } from '../cache';
import { DefaultModuleImplementation, Module } from '../module';
import type { ModuleEvaluation } from '../module-evaluation';
import { Entrypoint } from '../transform/Entrypoint';
import type { IEvaluatedEntrypoint } from '../transform/EvaluatedEntrypoint';
import type { LoadAndParseFn } from '../transform/Entrypoint.types';
import { AbortError } from '../transform/actions/AbortError';
import { isUnprocessedEntrypointError } from '../transform/actions/UnprocessedEntrypointError';
import type { Services } from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';

const options: StrictOptions = {
  babelOptions: {},
  displayName: false,
  extensions: ['.cjs', '.js', '.jsx', '.ts', '.tsx'],
  features: {
    dangerousCodeRemover: true,
    globalCache: true,
    happyDOM: true,
    softErrors: false,
    useBabelConfigs: true,
    useWeakRefInEval: true,
  },
  highPriorityPlugins: [],
  outputMetadata: false,
  overrideContext: (context) => ({
    ...context,
    HighLevelAPI: () => "I'm a high level API",
  }),
  rules: [],
};

const filename = path.resolve(__dirname, './__fixtures__/test.js');

const createServices = (partial: Partial<Services>): Services => {
  const loadAndParseFn: LoadAndParseFn = (services, name, loadedCode) => ({
    get ast() {
      return services.babel.parseSync(loadedCode ?? '', { filename: name })!;
    },
    code: loadedCode!,
    evaluator: jest.fn(),
    evalConfig: {},
  });

  return {
    babel,
    cache: new TransformCacheCollection(),
    emitWarning: jest.fn(),
    loadAndParseFn,
    log: logger,
    eventEmitter: EventEmitter.dummy,
    options: {
      filename,
      pluginOptions: { ...options },
    },
    ...partial,
  };
};

const createEntrypoint = (
  services: Services,
  name: string,
  only: string[],
  code: string
) => {
  const entrypoint = Entrypoint.createRoot(services, name, only, code);

  if (entrypoint.ignored) {
    throw new Error('entrypoint was ignored');
  }

  entrypoint.setTransformResult({
    code,
    metadata: null,
  });

  return entrypoint;
};

const create = (strings: TemplateStringsArray, ...expressions: unknown[]) => {
  const code = dedent(strings, ...expressions);
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const entrypoint = createEntrypoint(services, filename, ['*'], code);
  const mod = new Module(services, entrypoint);

  return {
    entrypoint,
    mod,
    services,
  };
};

async function safeEvaluate(m: Module): Promise<void> {
  try {
    return await m.evaluate();
  } catch (e) {
    if (isUnprocessedEntrypointError(e)) {
      e.entrypoint.setTransformResult({
        code: e.entrypoint.loadedAndParsed.code ?? '',
        metadata: null,
      });

      const { services } = m as unknown as { services: Services };
      const { moduleImpl } = m as unknown as { moduleImpl: unknown };
      const { entrypoint: rootEntrypoint } = m as unknown as {
        entrypoint: Entrypoint;
      };

      const nextModule = new Module(
        services,
        rootEntrypoint,
        undefined,
        moduleImpl as any
      );

      return safeEvaluate(nextModule);
    }

    throw e;
  }
}

function safeRequire(m: Module, id: string): unknown {
  try {
    return m.require(id);
  } catch (e) {
    if (isUnprocessedEntrypointError(e)) {
      e.entrypoint.setTransformResult({
        code: e.entrypoint.loadedAndParsed.code ?? '',
        metadata: null,
      });

      return safeRequire(m, id);
    }

    throw e;
  }
}

it('creates module for JS files', async () => {
  const { mod } = create`
    module.exports = () => 42;
  `;

  await safeEvaluate(mod);

  expect((mod.exports as any)()).toBe(42);
  expect(mod.id).toBe(filename);
  expect(mod.filename).toBe(filename);
});

it('keeps a strong entrypoint reference when WeakRef eval mode is disabled', async () => {
  const realWeakRef = globalThis.WeakRef;
  let weakRefConstructed = false;

  class EmptyWeakRef<T extends object> {
    private target: T;

    constructor(target: T) {
      this.target = target;
      weakRefConstructed = true;
    }

    deref(): T | undefined {
      expect(this.target).toBeDefined();
      return undefined;
    }
  }

  try {
    (globalThis as typeof globalThis & { WeakRef: typeof WeakRef }).WeakRef =
      EmptyWeakRef as typeof WeakRef;

    const code = dedent`
      module.exports = () => 42;
    `;
    const cache = new TransformCacheCollection();
    const services = createServices({ cache });
    services.options.pluginOptions.features.useWeakRefInEval = false;
    const entrypoint = createEntrypoint(services, filename, ['*'], code);
    const mod = new Module(services, entrypoint);

    await safeEvaluate(mod);

    expect((mod.exports as any)()).toBe(42);
    expect(weakRefConstructed).toBe(false);
  } finally {
    (globalThis as typeof globalThis & { WeakRef: typeof WeakRef }).WeakRef =
      realWeakRef;
  }
});

it('uses the module services for evaluated and ignored child entrypoints', async () => {
  const entrypointServices = createServices({});
  const moduleServices = createServices({});
  const entrypoint = createEntrypoint(entrypointServices, filename, ['*'], '');
  moduleServices.cache.add('entrypoints', filename, entrypoint);
  const mod = new Module(moduleServices, entrypoint);
  const createEvaluatedSpy = jest.spyOn(entrypoint, 'createEvaluated');

  await mod.evaluate();

  expect(createEvaluatedSpy).toHaveBeenCalledWith(moduleServices);

  const createChildSpy = jest.spyOn(entrypoint, 'createChild');
  (mod as unknown as { ignored: boolean }).ignored = true;
  const childFilename = path.resolve(
    __dirname,
    './__fixtures__/sample-script.js'
  );

  mod.getEntrypoint(childFilename, ['*'], logger);

  expect(createChildSpy).toHaveBeenCalledWith(
    childFilename,
    ['*'],
    fs.readFileSync(childFilename, 'utf-8'),
    moduleServices
  );
});

it('translates traversal ownership for a non-ignored cross-cache dependency', () => {
  const entrypointServices = createServices({});
  const moduleServices = createServices({});
  const entrypoint = createEntrypoint(entrypointServices, filename, ['*'], '');
  moduleServices.cache.add('entrypoints', filename, entrypoint);
  const mod = new Module(moduleServices, entrypoint);
  const childFilename = path.resolve(
    __dirname,
    './__fixtures__/sample-script.js'
  );

  const child = mod.getEntrypoint(childFilename, ['*'], logger);

  expect(child.name).toBe(childFilename);
  expect(child.cacheEpoch.owner).toBe(
    moduleServices.cache.getCurrentEpoch().owner
  );
  expect(moduleServices.cache.get('entrypoints', childFilename)).toBe(child);
});

it('retires same-key replacements created during failed evaluation', async () => {
  const cache = new TransformCacheCollection();
  const initialEpoch = cache.getCurrentEpoch();
  let replacement: Entrypoint | undefined;
  const services = createServices({ cache });
  services.options.pluginOptions.overrideContext = (context) => ({
    ...context,
    replaceAndFail: () => {
      replacement = createEntrypoint(
        services,
        filename,
        ['replacement'],
        'module.exports = { replacement: true };'
      );
      throw new Error('expected evaluation failure');
    },
  });
  const entrypoint = createEntrypoint(
    services,
    filename,
    ['*'],
    'replaceAndFail();'
  );
  const mod = new Module(services, entrypoint);

  await expect(mod.evaluate()).rejects.toThrow('expected evaluation failure');
  expect(replacement).toBeDefined();
  expect(replacement?.cacheEpoch).toBe(initialEpoch);
  expect(cache.getCurrentEpoch()).not.toBe(initialEpoch);
  expect(cache.get('entrypoints', filename)).toBeUndefined();
});

it('preserves a same-key replacement that wins before VM execution', async () => {
  let releaseLink!: () => void;
  let markLinkStarted!: () => void;
  const linkGate = new Promise<void>((resolve) => {
    releaseLink = resolve;
  });
  const linkStarted = new Promise<void>((resolve) => {
    markLinkStarted = resolve;
  });
  const cache = new TransformCacheCollection();
  const initialEpoch = cache.getCurrentEpoch();
  const services = createServices({ cache });
  const entrypoint = createEntrypoint(
    services,
    filename,
    ['*'],
    'module.exports = { stale: true };'
  );
  const mod = new Module(services, entrypoint);
  const mutableModule = mod as unknown as {
    linkModule: (module: unknown) => Promise<void>;
  };
  const linkModule = mutableModule.linkModule.bind(mod);
  mutableModule.linkModule = async (module) => {
    markLinkStarted();
    await linkGate;
    await linkModule(module);
  };

  const running = mod.evaluate();
  await linkStarted;
  const replacement = createEntrypoint(
    services,
    filename,
    ['replacement'],
    'module.exports = { replacement: true };'
  );
  releaseLink();

  await expect(running).rejects.toBeInstanceOf(AbortError);
  expect(replacement.cacheEpoch).toBe(initialEpoch);
  expect(cache.getCurrentEpoch()).toBe(initialEpoch);
  expect(cache.get('entrypoints', filename)).toBe(replacement);
  expect(replacement.exports.stale).toBeUndefined();
});

it('surfaces the retired epoch when superseded after VM execution', async () => {
  const cache = new TransformCacheCollection();
  const epoch = cache.getCurrentEpoch();
  const services = createServices({ cache });
  const entrypoint = createEntrypoint(
    services,
    filename,
    ['*'],
    'exports.value = 1;'
  );
  const mod = new Module(services, entrypoint);
  const mutableModule = mod as unknown as {
    linkModule: (module: vm.Module) => Promise<void>;
  };
  const linkModule = mutableModule.linkModule.bind(mod);
  mutableModule.linkModule = async (module) => {
    await linkModule(module);
    const mutableVmModule = module;
    const evaluate = mutableVmModule.evaluate.bind(mutableVmModule);
    mutableVmModule.evaluate = async () => {
      const result = await evaluate();
      createEntrypoint(
        services,
        filename,
        ['replacement'],
        'exports.value = 2;'
      );
      return result;
    };
  };

  let thrown: unknown;
  try {
    await mod.evaluate();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBe(cache.getEpochError(epoch));
  expect((thrown as { reason?: string }).reason).toBe('evaluation-side-effect');
  expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(
    AbortError
  );
});

it('evicts a stale foreign source without retiring the target epoch', async () => {
  let releaseLink!: () => void;
  let markLinkStarted!: () => void;
  const linkGate = new Promise<void>((resolve) => {
    releaseLink = resolve;
  });
  const linkStarted = new Promise<void>((resolve) => {
    markLinkStarted = resolve;
  });
  const sourceServices = createServices({});
  const targetServices = createServices({});
  const targetEpoch = targetServices.cache.getCurrentEpoch();
  const source = createEntrypoint(
    sourceServices,
    filename,
    ['*'],
    'module.exports = { value: 1 };'
  );
  targetServices.cache.add('entrypoints', filename, source);
  const mod = new Module(targetServices, source);
  const mutableModule = mod as unknown as {
    linkModule: (module: unknown) => Promise<void>;
  };
  const linkModule = mutableModule.linkModule.bind(mod);
  mutableModule.linkModule = async (module) => {
    markLinkStarted();
    await linkGate;
    await linkModule(module);
  };

  const running = mod.evaluate();
  await linkStarted;
  const sourceEpoch = source.cacheEpoch;
  sourceServices.cache.beginSupersedeStormRecovery(
    new Error('foreign source retired')
  );
  const controlError = sourceServices.cache.getEpochError(sourceEpoch);
  releaseLink();

  await expect(running).rejects.toBe(controlError);
  expect(targetServices.cache.getCurrentEpoch()).toBe(targetEpoch);
  expect(targetServices.cache.get('entrypoints', filename)).toBeUndefined();
});

it('uses one evaluation flight for concurrent callers', async () => {
  const cache = new TransformCacheCollection();
  let evaluations = 0;
  const services = createServices({ cache });
  services.options.pluginOptions.overrideContext = (context) => ({
    ...context,
    recordEvaluation: () => {
      evaluations += 1;
    },
  });
  const entrypoint = createEntrypoint(
    services,
    filename,
    ['*'],
    'recordEvaluation(); exports.value = 42;'
  );
  const mod = new Module(services, entrypoint);

  const first = mod.evaluate();
  const second = mod.evaluate();

  expect(second).toBe(first);
  await Promise.all([first, second]);
  expect(evaluations).toBe(1);
  expect(mod.exports.value).toBe(42);
});

it('shares an active evaluation across Module instances', async () => {
  const cache = new TransformCacheCollection();
  let evaluations = 0;
  const services = createServices({ cache });
  services.options.pluginOptions.overrideContext = (context) => ({
    ...context,
    recordEvaluation: () => {
      evaluations += 1;
    },
  });
  services.options.pluginOptions.eval = {
    customResolver: async () => ({
      external: true,
      id: 'virtual:active-flight-dependency',
    }),
    resolver: 'custom',
  };
  const entrypoint = createEntrypoint(
    services,
    filename,
    ['*'],
    "import './active-flight-dependency'; recordEvaluation(); exports.value = 42;"
  );
  const first = new Module(services, entrypoint);
  const second = new Module(services, entrypoint);

  const firstRunning = first.evaluate();
  const secondRunning = second.evaluate();
  expect(secondRunning).toBe(firstRunning);
  await expect(Promise.all([firstRunning, secondRunning])).resolves.toEqual([
    undefined,
    undefined,
  ]);
  await expect(second.evaluate()).resolves.toBeUndefined();
  expect(evaluations).toBe(1);
  expect(second.dependencies).toEqual(first.dependencies);
  expect(second.dependencies).toEqual(['./active-flight-dependency']);
  await expect(
    new Module(services, entrypoint).evaluate()
  ).resolves.toBeUndefined();
  expect(evaluations).toBe(2);
  expect(entrypoint.exports.value).toBe(42);
});

it('promotes a queued single flight into a reentrant evaluation lease', async () => {
  const cache = new TransformCacheCollection();
  let dependencyEvaluations = 0;
  let rootEvaluations = 0;
  const rootServices = createServices({ cache });
  const dependencyServices = createServices({ cache });
  rootServices.options.pluginOptions.overrideContext = (context) => ({
    ...context,
    recordRootEvaluation: () => {
      rootEvaluations += 1;
    },
  });
  dependencyServices.options.pluginOptions.overrideContext = (context) => ({
    ...context,
    recordDependencyEvaluation: () => {
      dependencyEvaluations += 1;
    },
  });

  const dependencyFilename = path.resolve(
    __dirname,
    './__fixtures__/active-flight-dependency.js'
  );
  const dependency = createEntrypoint(
    dependencyServices,
    dependencyFilename,
    ['*'],
    'recordDependencyEvaluation(); export default 42;'
  );
  rootServices.options.pluginOptions.eval = {
    customResolver: async (specifier) => {
      if (specifier !== './active-flight-dependency') return null;
      await new Module(dependencyServices, dependency).evaluate();
      return { external: true, id: dependencyFilename };
    },
    resolver: 'custom',
  };
  const root = createEntrypoint(
    rootServices,
    filename,
    ['*'],
    "import './active-flight-dependency'; recordRootEvaluation();"
  );

  const rootRunning = new Module(rootServices, root).evaluate();
  const dependencyRunning = new Module(
    dependencyServices,
    dependency
  ).evaluate();
  let timeoutId!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('reentrant evaluation timed out')),
      1000
    );
  });

  try {
    await expect(
      Promise.race([Promise.all([rootRunning, dependencyRunning]), timeout])
    ).resolves.toEqual([undefined, undefined]);
  } finally {
    clearTimeout(timeoutId);
  }
  expect(dependencyEvaluations).toBe(1);
  expect(rootEvaluations).toBe(1);
});

it('reparents an already-promoted sibling flight for a nested evaluation', async () => {
  const cache = new TransformCacheCollection();
  const epoch = cache.getCurrentEpoch();
  let rootEvaluations = 0;
  let firstDependencyEvaluations = 0;
  let secondDependencyEvaluations = 0;
  const rootServices = createServices({ cache });
  const firstDependencyServices = createServices({ cache });
  const secondDependencyServices = createServices({ cache });
  rootServices.options.pluginOptions.overrideContext = (context) => ({
    ...context,
    recordRootEvaluation: () => {
      rootEvaluations += 1;
    },
  });
  firstDependencyServices.options.pluginOptions.overrideContext = (
    context
  ) => ({
    ...context,
    recordFirstDependencyEvaluation: () => {
      firstDependencyEvaluations += 1;
    },
  });
  secondDependencyServices.options.pluginOptions.overrideContext = (
    context
  ) => ({
    ...context,
    recordSecondDependencyEvaluation: () => {
      secondDependencyEvaluations += 1;
    },
  });

  const firstDependencyFilename = path.resolve(
    __dirname,
    './__fixtures__/active-flight-first-dependency.js'
  );
  const secondDependencyFilename = path.resolve(
    __dirname,
    './__fixtures__/active-flight-second-dependency.js'
  );
  const secondDependency = createEntrypoint(
    secondDependencyServices,
    secondDependencyFilename,
    ['*'],
    'recordSecondDependencyEvaluation(); export default 42;'
  );
  const firstDependency = createEntrypoint(
    firstDependencyServices,
    firstDependencyFilename,
    ['*'],
    "import './second-dependency'; recordFirstDependencyEvaluation();"
  );
  let rootModule!: Module;
  firstDependencyServices.options.pluginOptions.eval = {
    customResolver: async (specifier) => {
      if (specifier !== './second-dependency') return null;
      const secondDependencyRunning = new Module(
        secondDependencyServices,
        secondDependency
      ).evaluate();
      const rootEvaluation = (
        rootModule as unknown as { evaluation: ModuleEvaluation }
      ).evaluation;
      const lateAncestorJoin = rootEvaluation.runInLeaseContext(() =>
        new Module(secondDependencyServices, secondDependency).evaluate()
      );
      await Promise.all([secondDependencyRunning, lateAncestorJoin]);
      return { external: true, id: secondDependencyFilename };
    },
    resolver: 'custom',
  };
  rootServices.options.pluginOptions.eval = {
    customResolver: async (specifier) => {
      if (specifier !== './promote-dependencies') return null;
      await Promise.all([
        new Module(firstDependencyServices, firstDependency).evaluate(),
        new Module(secondDependencyServices, secondDependency).evaluate(),
      ]);
      return { external: true, id: 'virtual:promote-dependencies' };
    },
    resolver: 'custom',
  };
  const root = createEntrypoint(
    rootServices,
    filename,
    ['*'],
    "import './promote-dependencies'; recordRootEvaluation();"
  );

  rootModule = new Module(rootServices, root);
  const rootRunning = rootModule.evaluate();
  const firstDependencyRunning = new Module(
    firstDependencyServices,
    firstDependency
  ).evaluate();
  const secondDependencyRunning = new Module(
    secondDependencyServices,
    secondDependency
  ).evaluate();
  let timeoutId!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('promotion-chain evaluation timed out')),
      1000
    );
  });

  try {
    await expect(
      Promise.race([
        Promise.all([
          rootRunning,
          firstDependencyRunning,
          secondDependencyRunning,
        ]),
        timeout,
      ])
    ).resolves.toEqual([undefined, undefined, undefined]);
  } finally {
    clearTimeout(timeoutId);
  }
  expect(firstDependencyEvaluations).toBe(1);
  expect(secondDependencyEvaluations).toBe(1);
  expect(rootEvaluations).toBe(1);
  expect(cache.getCurrentEpoch()).toBe(epoch);
});

it('fails fast for a reentrant evaluation flight cycle', async () => {
  const cache = new TransformCacheCollection();
  const epoch = cache.getCurrentEpoch();
  const services = createServices({ cache });
  const reentrantServices = createServices({ cache });
  const reentrantModuleImpl = Object.create(
    DefaultModuleImplementation
  ) as typeof DefaultModuleImplementation;
  const dependencyFilename = path.resolve(
    __dirname,
    './__fixtures__/cyclic-active-flight-dependency.js'
  );
  let root!: Entrypoint;
  let dependency!: Entrypoint;
  services.options.pluginOptions.eval = {
    customResolver: async (specifier, importer) => {
      if (importer === filename && specifier === './cycle-dependency') {
        await new Module(services, dependency).evaluate();
        return { external: true, id: dependencyFilename };
      }
      if (importer === dependencyFilename && specifier === './cycle-root') {
        await new Module(
          reentrantServices,
          root,
          undefined,
          reentrantModuleImpl
        ).evaluate();
        return { external: true, id: filename };
      }
      return null;
    },
    resolver: 'custom',
  };
  root = createEntrypoint(
    services,
    filename,
    ['*'],
    "import './cycle-dependency';"
  );
  dependency = createEntrypoint(
    services,
    dependencyFilename,
    ['*'],
    "import './cycle-root';"
  );

  await expect(new Module(services, root).evaluate()).rejects.toThrow(
    'Reentrant Module.evaluate() cycle detected'
  );
  expect(cache.getCurrentEpoch()).toBe(epoch);

  services.options.pluginOptions.eval = {
    customResolver: async (_specifier, importer) => ({
      external: true,
      id: importer === filename ? dependencyFilename : filename,
    }),
    resolver: 'custom',
  };
  await expect(new Module(services, root).evaluate()).resolves.toBeUndefined();
});

it('clears a shared active evaluation after a pre-VM failure', async () => {
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const entrypoint = createEntrypoint(
    services,
    filename,
    ['*'],
    'exports.value = 42;'
  );
  const createEvaluated = entrypoint.createEvaluated.bind(entrypoint);
  let attempts = 0;
  jest
    .spyOn(entrypoint, 'createEvaluated')
    .mockImplementation((nextServices) => {
      attempts += 1;
      if (attempts === 1) throw new Error('pre-VM failure');
      return createEvaluated(nextServices);
    });
  const first = new Module(services, entrypoint);
  const second = new Module(services, entrypoint);

  const firstRunning = first.evaluate();
  const secondRunning = second.evaluate();
  expect(secondRunning).toBe(firstRunning);
  const [firstResult, secondResult] = await Promise.allSettled([
    firstRunning,
    secondRunning,
  ]);
  expect(firstResult.status).toBe('rejected');
  expect(secondResult.status).toBe('rejected');
  if (firstResult.status === 'rejected' && secondResult.status === 'rejected') {
    expect(secondResult.reason).toBe(firstResult.reason);
  }

  await expect(
    new Module(services, entrypoint).evaluate()
  ).resolves.toBeUndefined();
  expect(attempts).toBe(2);
  expect(entrypoint.exports.value).toBe(42);
});

it('re-evaluates an exact source entrypoint after its transform changes', async () => {
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const entrypoint = createEntrypoint(
    services,
    filename,
    ['*'],
    'exports.value = 1;'
  );

  await new Module(services, entrypoint).evaluate();
  expect(entrypoint.exports.value).toBe(1);

  entrypoint.setTransformResult({
    code: 'exports.value = 2;',
    metadata: null,
  });
  await new Module(services, entrypoint).evaluate();
  expect(entrypoint.exports.value).toBe(2);
});

it('re-evaluates an exact source entrypoint with different services', async () => {
  const cache = new TransformCacheCollection();
  const firstServices = createServices({ cache });
  const secondServices = createServices({ cache });
  firstServices.options.pluginOptions.overrideContext = (context) => ({
    ...context,
    serviceValue: 1,
  });
  secondServices.options.pluginOptions.overrideContext = (context) => ({
    ...context,
    serviceValue: 2,
  });
  const entrypoint = createEntrypoint(
    firstServices,
    filename,
    ['*'],
    'exports.value = serviceValue;'
  );

  await new Module(firstServices, entrypoint).evaluate();
  expect(entrypoint.exports.value).toBe(1);
  await new Module(secondServices, entrypoint).evaluate();
  expect(entrypoint.exports.value).toBe(2);
});

it('does not mask an unrelated constructor-time cache winner', async () => {
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const entrypoint = createEntrypoint(
    services,
    filename,
    ['*'],
    'exports.value = 1;'
  );
  await new Module(services, entrypoint).evaluate();
  const evaluated = cache.get('entrypoints', filename);
  expect(evaluated?.evaluated).toBe(true);

  const unrelatedName = `${filename}.unrelated`;
  const unrelatedSource = createEntrypoint(services, unrelatedName, ['*'], '');
  const unrelated = unrelatedSource.createEvaluated(services);
  cache.add('entrypoints', filename, unrelated);
  const staleModule = new Module(services, entrypoint);
  cache.add('entrypoints', filename, evaluated!);

  await expect(staleModule.evaluate()).rejects.toBeInstanceOf(AbortError);
  expect(cache.get('entrypoints', filename)).toBe(evaluated);
});

it('evicts a live cached closure when evaluation is aborted', async () => {
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const dependencyName = path.resolve(
    __dirname,
    './__fixtures__/transactional-closure-dependency.js'
  );
  const rootName = path.resolve(
    __dirname,
    './__fixtures__/transactional-closure-root.js'
  );
  const dependencyCode = dedent`
    const state = { count: 0 };
    exports.increment = () => { state.count += 1; };
    exports.read = () => state.count;
  `;
  const dependency = createEntrypoint(
    services,
    dependencyName,
    ['increment', 'read'],
    dependencyCode
  );
  await new Module(services, dependency).evaluate();
  const evaluatedDependency = cache.get('entrypoints', dependencyName);
  if (!evaluatedDependency || !evaluatedDependency.evaluated) {
    throw new Error('dependency was not evaluated');
  }
  cache.checkFreshness = () => false;

  const root = createEntrypoint(services, rootName, ['*'], '');
  root.addDependency({
    only: ['increment'],
    resolved: dependencyName,
    source: './transactional-closure-dependency.js',
  });
  root.setTransformResult({
    code: dedent`
      import { increment } from './transactional-closure-dependency.js';
      increment();
      exports.ok = true;
    `,
    metadata: null,
  });
  const epoch = cache.getCurrentEpoch();
  const mod = new Module(services, root);
  const mutableModule = mod as unknown as {
    linkModule: (module: vm.Module) => Promise<void>;
  };
  const linkModule = mutableModule.linkModule.bind(mod);
  mutableModule.linkModule = async (module) => {
    await linkModule(module);
    const evaluatedModule = module;
    const evaluate = evaluatedModule.evaluate.bind(evaluatedModule);
    evaluatedModule.evaluate = async () => {
      const result = await evaluate();
      cache.beginSupersedeStormRecovery(
        new Error('retire after the VM side effect')
      );
      return result;
    };
  };

  let thrown: unknown;
  try {
    await mod.evaluate();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBe(cache.getEpochError(epoch));
  expect(cache.get('entrypoints', dependencyName)).toBeUndefined();
});

it('preserves callable dependency state across successful evaluations', async () => {
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const dependencyName = path.resolve(
    __dirname,
    './__fixtures__/transactional-state-dependency.js'
  );
  const firstRootName = path.resolve(
    __dirname,
    './__fixtures__/transactional-state-first-root.js'
  );
  const secondRootName = path.resolve(
    __dirname,
    './__fixtures__/transactional-state-second-root.js'
  );
  const dependencyCode = dedent`
    const state = { count: 0 };
    exports.increment = () => { state.count += 1; };
    exports.read = () => state.count;
  `;
  const dependency = createEntrypoint(
    services,
    dependencyName,
    ['increment', 'read'],
    dependencyCode
  );
  await new Module(services, dependency).evaluate();
  const evaluatedDependency = cache.get('entrypoints', dependencyName);
  if (!evaluatedDependency || !evaluatedDependency.evaluated) {
    throw new Error('dependency was not evaluated');
  }
  cache.checkFreshness = () => false;

  const firstRoot = createEntrypoint(services, firstRootName, ['*'], '');
  firstRoot.addDependency({
    only: ['increment', 'read'],
    resolved: dependencyName,
    source: './transactional-state-dependency.js',
  });
  firstRoot.setTransformResult({
    code: dedent`
      import { increment, read } from './transactional-state-dependency.js';
      increment();
      exports.value = read();
    `,
    metadata: null,
  });
  await new Module(services, firstRoot).evaluate();

  const secondRoot = createEntrypoint(services, secondRootName, ['*'], '');
  secondRoot.addDependency({
    only: ['increment', 'read'],
    resolved: dependencyName,
    source: './transactional-state-dependency.js',
  });
  secondRoot.setTransformResult({
    code: dedent`
      import { increment, read } from './transactional-state-dependency.js';
      increment();
      increment();
      exports.value = read();
    `,
    metadata: null,
  });
  await new Module(services, secondRoot).evaluate();

  expect(firstRoot.exports.value).toBe(1);
  expect(secondRoot.exports.value).toBe(3);
  expect((evaluatedDependency.exports.read as () => number)()).toBe(3);
});

it('preserves passive root exports when a successful evaluation widens', async () => {
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const rootName = path.resolve(
    __dirname,
    './__fixtures__/transactional-widened-root.js'
  );
  const code = dedent`
    exports.count = (exports.count ?? 0) + 1;
    exports.extra = 42;
  `;

  const first = createEntrypoint(services, rootName, ['count'], code);
  await new Module(services, first).evaluate();
  expect(cache.get('entrypoints', rootName)?.exports.count).toBe(1);

  const widened = createEntrypoint(
    services,
    rootName,
    ['count', 'extra'],
    code
  );
  await new Module(services, widened).evaluate();

  expect(cache.get('entrypoints', rootName)?.exports.count).toBe(2);
});

it('serializes concurrent evaluations so successful updates are not lost', async () => {
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const dependencyName = path.resolve(
    __dirname,
    './__fixtures__/transactional-passive-dependency.js'
  );
  const dependency = createEntrypoint(
    services,
    dependencyName,
    ['state'],
    'exports.state = { count: 0 };'
  );
  await new Module(services, dependency).evaluate();
  const evaluatedDependency = cache.get('entrypoints', dependencyName);
  if (!evaluatedDependency || !evaluatedDependency.evaluated) {
    throw new Error('dependency was not evaluated');
  }
  cache.checkFreshness = () => false;

  const createRoot = (name: string, increments: number) => {
    const root = createEntrypoint(services, name, ['*'], '');
    root.addDependency({
      only: ['state'],
      resolved: dependencyName,
      source: './transactional-passive-dependency.js',
    });
    root.setTransformResult({
      code: dedent`
        import { state } from './transactional-passive-dependency.js';
        ${Array.from({ length: increments }, () => 'state.count += 1;').join(
          '\n'
        )}
      `,
      metadata: null,
    });
    return root;
  };

  const firstModule = new Module(
    services,
    createRoot(
      path.resolve(__dirname, './__fixtures__/transactional-passive-a.js'),
      1
    )
  );
  const secondModule = new Module(
    services,
    createRoot(
      path.resolve(__dirname, './__fixtures__/transactional-passive-b.js'),
      2
    )
  );
  let releaseFirst!: () => void;
  let signalFirstLinked!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstLinked = new Promise<void>((resolve) => {
    signalFirstLinked = resolve;
  });
  const mutableFirst = firstModule as unknown as {
    linkModule: (module: vm.Module) => Promise<void>;
  };
  const linkFirst = mutableFirst.linkModule.bind(firstModule);
  mutableFirst.linkModule = async (module) => {
    await linkFirst(module);
    signalFirstLinked();
    await firstGate;
  };

  const firstRunning = firstModule.evaluate();
  await firstLinked;
  const secondRunning = secondModule.evaluate();
  let secondSettled = false;
  secondRunning
    .finally(() => {
      secondSettled = true;
    })
    .catch(() => {});
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(secondSettled).toBe(false);

  releaseFirst();
  await Promise.all([firstRunning, secondRunning]);
  expect((evaluatedDependency.exports.state as { count: number }).count).toBe(
    3
  );
});

it('retires cached aliases after a failed evaluation touches live exports', async () => {
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const dependencyName = path.resolve(
    __dirname,
    './__fixtures__/transactional-live-alias-dependency.js'
  );
  const aliasName = path.resolve(
    __dirname,
    './__fixtures__/transactional-live-alias.js'
  );
  const rootName = path.resolve(
    __dirname,
    './__fixtures__/transactional-live-alias-root.js'
  );
  const dependency = createEntrypoint(
    services,
    dependencyName,
    ['increment', 'read'],
    dedent`
      const state = { count: 0 };
      exports.increment = () => { state.count += 1; };
      exports.read = () => state.count;
    `
  );
  await new Module(services, dependency).evaluate();
  cache.checkFreshness = () => false;

  const alias = createEntrypoint(
    services,
    aliasName,
    ['increment', 'read'],
    ''
  );
  alias.addDependency({
    only: ['increment', 'read'],
    resolved: dependencyName,
    source: './transactional-live-alias-dependency.js',
  });
  alias.setTransformResult({
    code: dedent`
      import { increment, read } from './transactional-live-alias-dependency.js';
      exports.increment = increment;
      exports.read = read;
    `,
    metadata: null,
  });
  await new Module(services, alias).evaluate();

  const root = createEntrypoint(services, rootName, ['*'], '');
  root.addDependency({
    only: ['increment'],
    resolved: dependencyName,
    source: './transactional-live-alias-dependency.js',
  });
  root.setTransformResult({
    code: dedent`
      import { increment } from './transactional-live-alias-dependency.js';
      increment();
      throw new Error('expected live export failure');
    `,
    metadata: null,
  });

  await expect(new Module(services, root).evaluate()).rejects.toThrow(
    'expected live export failure'
  );
  expect(cache.get('entrypoints', dependencyName)).toBeUndefined();
  expect(cache.get('entrypoints', aliasName)).toBeUndefined();
});

it('does not snapshot objects with a custom prototype', async () => {
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const dependencyName = path.resolve(
    __dirname,
    './__fixtures__/transactional-custom-prototype-dependency.js'
  );
  const rootName = path.resolve(
    __dirname,
    './__fixtures__/transactional-custom-prototype-root.js'
  );
  const dependency = createEntrypoint(
    services,
    dependencyName,
    ['value'],
    'exports.value = {};'
  );
  await new Module(services, dependency).evaluate();
  const evaluatedDependency = cache.get('entrypoints', dependencyName);
  if (!evaluatedDependency || !evaluatedDependency.evaluated) {
    throw new Error('dependency was not evaluated');
  }
  const customPrototype = { constructor: Object, inherited: 42 };
  evaluatedDependency.exports.value = Object.create(customPrototype);
  cache.checkFreshness = () => false;

  const root = createEntrypoint(services, rootName, ['*'], '');
  root.addDependency({
    only: ['value'],
    resolved: dependencyName,
    source: './transactional-custom-prototype-dependency.js',
  });
  root.setTransformResult({
    code: dedent`
      import { value } from './transactional-custom-prototype-dependency.js';
      exports.result = value.inherited;
    `,
    metadata: null,
  });

  await new Module(services, root).evaluate();
  expect(root.exports.result).toBe(42);
  expect(Object.getPrototypeOf(evaluatedDependency.exports.value)).toBe(
    customPrototype
  );
});

it('does not snapshot objects with a lookalike intrinsic prototype', async () => {
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const dependencyName = path.resolve(
    __dirname,
    './__fixtures__/transactional-lookalike-prototype-dependency.js'
  );
  const rootName = path.resolve(
    __dirname,
    './__fixtures__/transactional-lookalike-prototype-root.js'
  );
  const dependency = createEntrypoint(
    services,
    dependencyName,
    ['value'],
    'exports.value = {};'
  );
  await new Module(services, dependency).evaluate();
  const evaluatedDependency = cache.get('entrypoints', dependencyName);
  if (!evaluatedDependency || !evaluatedDependency.evaluated) {
    throw new Error('dependency was not evaluated');
  }
  const customPrototype = Object.create(
    null,
    Object.getOwnPropertyDescriptors(Object.prototype)
  );
  Object.defineProperty(customPrototype, 'toString', {
    ...Object.getOwnPropertyDescriptor(Object.prototype, 'toString'),
    value: () => 'custom',
  });
  evaluatedDependency.exports.value = Object.create(customPrototype);
  cache.checkFreshness = () => false;

  const root = createEntrypoint(services, rootName, ['*'], '');
  root.addDependency({
    only: ['value'],
    resolved: dependencyName,
    source: './transactional-lookalike-prototype-dependency.js',
  });
  root.setTransformResult({
    code: dedent`
      import { value } from './transactional-lookalike-prototype-dependency.js';
      exports.result = String(value);
    `,
    metadata: null,
  });

  await new Module(services, root).evaluate();
  expect(root.exports.result).toBe('custom');
  expect(Object.getPrototypeOf(evaluatedDependency.exports.value)).toBe(
    customPrototype
  );
});

it('retires the epoch when a live export proxy throws during exposure', async () => {
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const dependencyName = path.resolve(
    __dirname,
    './__fixtures__/transactional-proxy-dependency.js'
  );
  const rootName = path.resolve(
    __dirname,
    './__fixtures__/transactional-proxy-root.js'
  );
  const dependency = createEntrypoint(
    services,
    dependencyName,
    ['default'],
    ''
  );
  const evaluatedDependency = dependency.createEvaluated(services);
  let trapCalls = 0;
  evaluatedDependency.exports = new Proxy(
    { value: 42 },
    {
      ownKeys() {
        trapCalls += 1;
        throw new Error('expected proxy failure');
      },
    }
  );
  cache.add('entrypoints', dependencyName, evaluatedDependency);
  cache.checkFreshness = () => false;

  const root = createEntrypoint(services, rootName, ['*'], '');
  root.addDependency({
    only: ['default'],
    resolved: dependencyName,
    source: './transactional-proxy-dependency.js',
  });
  root.setTransformResult({
    code: dedent`
      import value from './transactional-proxy-dependency.js';
      exports.result = value.value;
    `,
    metadata: null,
  });

  await expect(new Module(services, root).evaluate()).rejects.toThrow(
    'expected proxy failure'
  );
  expect(trapCalls).toBe(1);
  expect(cache.get('entrypoints', dependencyName)).toBeUndefined();
  expect(cache.get('entrypoints', rootName)).toBeUndefined();
});

it('supports a structural evaluated entrypoint with a name accessor', async () => {
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const dependencyName = path.resolve(
    __dirname,
    './__fixtures__/transactional-legacy-dependency.js'
  );
  const rootName = path.resolve(
    __dirname,
    './__fixtures__/transactional-legacy-root.js'
  );
  const legacy = {
    dependencies: new Map(),
    evaluated: true as const,
    evaluatedOnly: ['value'],
    exports: { value: 42 },
    generation: 1,
    hasTransformResult: false,
    hasWywMetadata: false,
    ignored: false as const,
    invalidationDependencies: new Map(),
    invalidateOnDependencyChange: new Set<string>(),
    log: logger,
    only: ['value'],
    parents: [],
    preevalResult: null,
    seqId: -1,
    transformResultCode: null,
  } as Omit<IEvaluatedEntrypoint, 'name'> & { name?: string };
  Object.defineProperty(legacy, 'name', {
    configurable: true,
    get: () => dependencyName,
  });
  cache.add('entrypoints', dependencyName, legacy as IEvaluatedEntrypoint);
  cache.checkFreshness = () => false;

  const root = createEntrypoint(services, rootName, ['*'], '');
  root.addDependency({
    only: ['value'],
    resolved: dependencyName,
    source: './transactional-legacy-dependency.js',
  });
  root.setTransformResult({
    code: dedent`
      import { value } from './transactional-legacy-dependency.js';
      exports.result = value;
    `,
    metadata: null,
  });

  await expect(new Module(services, root).evaluate()).resolves.toBeUndefined();
  expect(root.exports.result).toBe(42);
});

it('cancels a late dynamic import when its evaluation transaction fails', async () => {
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const dependencyName = path.resolve(
    __dirname,
    './__fixtures__/transactional-late-import-dependency.js'
  );
  const rootName = path.resolve(
    __dirname,
    './__fixtures__/transactional-late-import-root.js'
  );
  const dependency = createEntrypoint(
    services,
    dependencyName,
    ['increment', 'read'],
    dedent`
      const state = { count: 0 };
      exports.increment = () => { state.count += 1; };
      exports.read = () => state.count;
    `
  );
  await new Module(services, dependency).evaluate();
  const evaluatedDependency = cache.get('entrypoints', dependencyName);
  if (!evaluatedDependency || !evaluatedDependency.evaluated) {
    throw new Error('dependency was not evaluated');
  }
  cache.checkFreshness = () => false;

  let releaseResolver!: () => void;
  let signalResolverStarted!: () => void;
  let reportDynamicResult!: (result: string) => void;
  const resolverGate = new Promise<void>((resolve) => {
    releaseResolver = resolve;
  });
  const resolverStarted = new Promise<void>((resolve) => {
    signalResolverStarted = resolve;
  });
  const dynamicResult = new Promise<string>((resolve) => {
    reportDynamicResult = resolve;
  });
  services.options.pluginOptions.overrideContext = (context) => ({
    ...context,
    reportDynamicResult,
  });
  services.options.pluginOptions.eval = {
    customResolver: async () => {
      signalResolverStarted();
      await resolverGate;
      return null;
    },
    resolver: 'bundler',
  };
  const root = createEntrypoint(services, rootName, ['*'], '');
  root.addDependency({
    only: ['increment'],
    resolved: dependencyName,
    source: './transactional-late-import-dependency.js',
  });
  root.setTransformResult({
    code: dedent`
      void import('./transactional-late-import-dependency.js').then(
        ({ increment }) => {
          increment();
          reportDynamicResult('resolved');
        },
        (error) => reportDynamicResult(error.message)
      );
      throw new Error('expected root failure');
    `,
    metadata: null,
  });

  const running = new Module(services, root).evaluate();
  await resolverStarted;
  await expect(running).rejects.toThrow('expected root failure');
  releaseResolver();

  await expect(dynamicResult).resolves.toBe('evaluation completed');
  expect((evaluatedDependency.exports.read as () => number)()).toBe(0);
});

it('allows an awaited reentrant cache evaluation', async () => {
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const outerName = path.resolve(
    __dirname,
    './__fixtures__/transactional-reentrant-outer.js'
  );
  const innerName = path.resolve(
    __dirname,
    './__fixtures__/transactional-reentrant-inner.js'
  );
  services.options.pluginOptions.eval = {
    customResolver: async () => {
      const inner = createEntrypoint(
        services,
        innerName,
        ['*'],
        'exports.value = 42;'
      );
      await new Module(services, inner).evaluate();
      return { id: innerName };
    },
    resolver: 'custom',
  };
  cache.checkFreshness = () => false;
  const outer = createEntrypoint(
    services,
    outerName,
    ['*'],
    "import { value } from './trigger'; exports.value = value;"
  );

  await new Module(services, outer).evaluate();
  expect(outer.exports.value).toBe(42);
});

const nodeOnlyIt = (process.versions as { bun?: string }).bun ? it.skip : it;

nodeOnlyIt(
  'retires live state when an unprocessed dynamic import follows VM effects',
  async () => {
    const cache = new TransformCacheCollection();
    const services = createServices({ cache });
    const rootName = path.resolve(
      __dirname,
      './__fixtures__/transactional-unprocessed-tla-root.js'
    );
    const dependencyName = path.resolve(
      __dirname,
      './__fixtures__/transactional-unprocessed-tla-dependency.js'
    );
    const dependency = Entrypoint.createRoot(
      services,
      dependencyName,
      ['*'],
      'exports.value = 1;'
    );
    const root = createEntrypoint(services, rootName, ['*'], '');
    root.addDependency({
      only: ['*'],
      resolved: dependencyName,
      source: './transactional-unprocessed-tla-dependency.js',
    });
    root.setTransformResult({
      code: dedent`
        exports.count = (exports.count ?? 0) + 1;
        await import('./transactional-unprocessed-tla-dependency.js');
      `,
      metadata: null,
    });
    cache.checkFreshness = () => false;
    const initialEpoch = cache.getCurrentEpoch();

    let thrown: unknown;
    try {
      await new Module(services, root).evaluate();
    } catch (error) {
      thrown = error;
    }

    expect(isUnprocessedEntrypointError(thrown)).toBe(true);
    if (isUnprocessedEntrypointError(thrown)) {
      expect(thrown.entrypoint).toBe(dependency);
    }
    expect(root.exports.count).toBe(1);
    expect(cache.getCurrentEpoch()).not.toBe(initialEpoch);
    expect(cache.get('entrypoints', rootName)).toBeUndefined();
    expect(cache.get('entrypoints', dependencyName)).toBeUndefined();
  }
);

it('wakes a queued evaluation when its cache epoch retires', async () => {
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const stuckName = path.resolve(
    __dirname,
    './__fixtures__/transactional-queued-stuck.js'
  );
  const queuedName = path.resolve(
    __dirname,
    './__fixtures__/transactional-queued-stale.js'
  );
  cache.checkFreshness = () => false;

  let releaseResolver!: () => void;
  let signalResolverStarted!: () => void;
  const resolverGate = new Promise<void>((resolve) => {
    releaseResolver = resolve;
  });
  const resolverStarted = new Promise<void>((resolve) => {
    signalResolverStarted = resolve;
  });
  services.options.pluginOptions.eval = {
    customResolver: async (_specifier, importer) => {
      if (importer !== stuckName) return null;
      signalResolverStarted();
      await resolverGate;
      return null;
    },
    resolver: 'custom',
  };
  const stuck = createEntrypoint(
    services,
    stuckName,
    ['*'],
    "import './never-resolves'; exports.value = 1;"
  );
  const stuckRunning = new Module(services, stuck).evaluate();
  stuckRunning.catch(() => undefined);
  await resolverStarted;

  const queued = createEntrypoint(
    services,
    queuedName,
    ['*'],
    'exports.value = 2;'
  );
  const queuedEpoch = cache.getCurrentEpoch();
  const queuedRunning = new Module(services, queued).evaluate();
  queuedRunning.catch(() => undefined);
  await Promise.resolve();

  cache.beginSupersedeStormRecovery(new Error('retire old epoch'));
  const expectedAbort = cache.getEpochError(queuedEpoch);
  const outcome = await Promise.race([
    queuedRunning.then(
      () => 'resolved',
      (error: unknown) => error
    ),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve('stuck'), 100);
    }),
  ]);

  releaseResolver();
  await stuckRunning.catch(() => undefined);
  await queuedRunning.catch(() => undefined);
  expect(outcome).toBe(expectedAbort);
});

it('requires .js files', async () => {
  const { mod } = create`
    const answer = require('./sample-script');

    module.exports = 'The answer is ' + answer;
  `;

  await safeEvaluate(mod);

  expect(mod.exports).toBe('The answer is 42');
});

it('requires .cjs files', async () => {
  const { mod } = create`
    const answer = require('./sample-script.cjs');

    module.exports = 'The answer is ' + answer;
  `;
  await safeEvaluate(mod);

  expect(mod.exports).toBe('The answer is 42');
});

it('prefers .js when extensionless import resolves to .cjs and .js exists', async () => {
  const code = dedent`
    module.exports = require('./prefer-js');
  `;
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const entrypoint = createEntrypoint(services, filename, ['*'], code);

  const resolveFilename = jest.fn((id: string) => {
    if (id === './prefer-js') {
      return path.resolve(__dirname, './__fixtures__/prefer-js.cjs');
    }

    return id;
  });

  const moduleImpl = {
    _extensions: DefaultModuleImplementation._extensions,
    _nodeModulePaths: DefaultModuleImplementation._nodeModulePaths.bind(
      DefaultModuleImplementation
    ),
    _resolveFilename: resolveFilename as any,
  };

  const mod = new Module(services, entrypoint, undefined, moduleImpl as any);

  await safeEvaluate(mod);

  expect(mod.exports).toBe('js');
  expect(resolveFilename).toHaveBeenCalledWith(
    './prefer-js',
    expect.anything(),
    false,
    undefined
  );
});

it('does not rewrite bare imports when extensionless import resolves to .cjs and .js exists', async () => {
  const code = dedent`
    module.exports = require('prefer-js');
  `;
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const entrypoint = createEntrypoint(services, filename, ['*'], code);

  const resolveFilename = jest.fn((id: string) => {
    if (id === 'prefer-js') {
      return path.resolve(__dirname, './__fixtures__/prefer-js.cjs');
    }

    return id;
  });

  const moduleImpl = {
    _extensions: DefaultModuleImplementation._extensions,
    _nodeModulePaths: DefaultModuleImplementation._nodeModulePaths.bind(
      DefaultModuleImplementation
    ),
    _resolveFilename: resolveFilename as any,
  };

  const mod = new Module(services, entrypoint, undefined, moduleImpl as any);

  await safeEvaluate(mod);

  expect(mod.exports).toBe('cjs');
  expect(resolveFilename).toHaveBeenCalledWith(
    'prefer-js',
    expect.anything(),
    false,
    undefined
  );
});

it('requires .json files', async () => {
  const { mod } = create`
    const data = require('./sample-data.json');

    module.exports = 'Our saviour, ' + data.name;
  `;
  await safeEvaluate(mod);

  expect(mod.exports).toBe('Our saviour, Luke Skywalker');
});

it('supports "?raw" imports during eval', async () => {
  const { entrypoint, mod } = create`
    module.exports = require('./sample-asset.txt?raw');
  `;

  entrypoint.addDependency({
    only: ['*'],
    resolved: path.resolve(__dirname, './__fixtures__/sample-asset.txt'),
    source: './sample-asset.txt?raw',
  });

  await safeEvaluate(mod);

  // Git checkout on Windows may convert text files to CRLF.
  expect(String(mod.exports).replace(/\r\n/g, '\n')).toBe('Hello from asset\n');
});

it('supports "?url" imports during eval', async () => {
  const { entrypoint, mod } = create`
    module.exports = require('./sample-asset.txt?url');
  `;

  entrypoint.addDependency({
    only: ['*'],
    resolved: path.resolve(__dirname, './__fixtures__/sample-asset.txt'),
    source: './sample-asset.txt?url',
  });

  await safeEvaluate(mod);

  expect(mod.exports).toBe('./sample-asset.txt');
});

it('allows custom query loaders via pluginOptions.importLoaders', async () => {
  const { entrypoint, mod, services } = create`
    module.exports = require('./sample-asset.txt?svgUse');
  `;

  services.options.pluginOptions.importLoaders = {
    svgUse: (ctx) => ({ ok: true, url: ctx.toUrl() }),
  };

  entrypoint.addDependency({
    only: ['*'],
    resolved: path.resolve(__dirname, './__fixtures__/sample-asset.txt'),
    source: './sample-asset.txt?svgUse',
  });

  await safeEvaluate(mod);

  expect(mod.exports).toEqual({ ok: true, url: './sample-asset.txt' });
});

it('returns module from the cache', () => {
  const { entrypoint, mod, services } = create``;

  const id = './sample-data.json';

  expect(safeRequire(mod, id)).toBe(safeRequire(mod, id));

  const res1 = safeRequire(new Module(services, entrypoint), id);
  const res2 = safeRequire(new Module(services, entrypoint), id);

  expect(res1).toBe(res2);
});

it('should use cached version from the codeCache', async () => {
  const { entrypoint, mod } = create`
    import { margin } from './objectExport';

    module.exports = 'Imported value is ' + margin;
  `;

  const resolved = require.resolve('./__fixtures__/objectExport.js');
  entrypoint.addDependency({
    only: ['margin'],
    resolved,
    source: './objectExport',
  });

  entrypoint.createChild(
    resolved,
    ['margin'],
    dedent`
      export const margin = 1;
    `
  );

  await safeEvaluate(mod);

  expect(mod.exports).toBe('Imported value is 1');
});

it('should reread module from disk when it is in codeCache but not in resolveCache', async () => {
  // This may happen when the current importer was not processed, but required
  // module was already required by another module, and its code was cached.
  // In this case, we should not use the cached code, but reread the file.

  const { entrypoint, mod } = create`
    const margin = require('./objectExport').margin;

    module.exports = 'Imported value is ' + margin;
  `;

  const resolved = require.resolve('./__fixtures__/objectExport.js');
  entrypoint.createChild(
    resolved,
    ['margin'],
    dedent`
    module.exports = { margin: 1 };
  `
  );

  await safeEvaluate(mod);

  expect(mod.exports).toBe('Imported value is 5');
});

it('clears modules from the cache', () => {
  const id = './sample-data.json';

  const { entrypoint, mod, services } = create``;
  const result = safeRequire(mod, id);

  expect(safeRequire(new Module(services, entrypoint), id)).toBe(result);

  const dep = new Module(services, entrypoint).resolve(id);
  services.cache.invalidateForFile(dep);

  expect(safeRequire(new Module(services, entrypoint), id)).not.toBe(result);
});

it('exports the path for non JS/JSON files', () => {
  const { mod } = create``;

  expect(mod.require('./sample-asset.png')).toBe(
    path.join(__dirname, '__fixtures__', 'sample-asset.png')
  );
});

it('returns module when requiring mocked builtin node modules', () => {
  const { mod } = create``;

  expect(mod.require('path')).toBe(require('path'));
});

it('returns null when requiring empty builtin node modules', () => {
  const { mod } = create``;

  expect(mod.require('fs')).toBe(null);
});

it('returns refresh runtime stub for Vite virtual module', () => {
  const { mod } = create``;

  const runtime = safeRequire(mod, '/@react-refresh') as {
    createSignatureFunctionForTransform: () => () => void;
  };

  expect(typeof runtime.createSignatureFunctionForTransform).toBe('function');
  expect(typeof runtime.createSignatureFunctionForTransform()).toBe('function');
});

it('returns empty object for other Vite virtual modules', () => {
  const { mod } = create``;

  expect(safeRequire(mod, '/@virtual-dep')).toEqual({});
});

it('throws when requiring unmocked builtin node modules', () => {
  const { mod } = create``;

  expect(() => mod.require('perf_hooks')).toThrow(
    'Unable to import "perf_hooks". Importing Node builtins is not supported in the sandbox.'
  );
});

it('has access to the global object', async () => {
  const { mod } = create`
    new global.Set();
  `;

  await expect(mod.evaluate()).resolves.toBeUndefined();
});

it('has access to Object prototype methods on `exports`', async () => {
  const { mod } = create`
    exports.hasOwnProperty('keyss');
  `;

  await expect(mod.evaluate()).resolves.toBeUndefined();
});

it("doesn't have access to the process object", async () => {
  const { mod } = create`
    module.exports = process.abort();
  `;

  await expect(mod.evaluate()).rejects.toThrow(
    'process.abort is not a function'
  );
});

it('adds a hint when eval fails due to browser-only globals', async () => {
  const code = dedent`
    module.exports = window.location.href;
  `;
  const cache = new TransformCacheCollection();
  const services = createServices({
    cache,
    options: {
      filename,
      pluginOptions: {
        ...options,
        features: {
          ...options.features,
          happyDOM: false,
        },
      },
    },
  });
  const entrypoint = createEntrypoint(services, filename, ['*'], code);
  const mod = new Module(services, entrypoint);

  try {
    await mod.evaluate();
    throw new Error('expected evaluation to fail');
  } catch (e) {
    expect(e).toBeInstanceOf(EvalError);
    expect((e as Error).message).toContain('[wyw-in-js] Evaluation hint:');
    expect((e as Error).message).toContain('importOverrides');
  }
});

it('has access to a overridden context', async () => {
  const { mod } = create`
    module.exports = HighLevelAPI();
  `;

  await safeEvaluate(mod);

  expect(mod.exports).toBe("I'm a high level API");
});

it('has access to NODE_ENV', async () => {
  const { mod } = create`
    module.exports = process.env.NODE_ENV;
  `;

  await safeEvaluate(mod);

  expect(mod.exports).toBe(process.env.NODE_ENV);
});

it('has require.resolve available', async () => {
  const { mod } = create`
    module.exports = require.resolve('./sample-script');
  `;

  await safeEvaluate(mod);

  expect(mod.exports).toBe(
    path.resolve(path.dirname(mod.filename), 'sample-script.js')
  );
});

it('has require.ensure available', async () => {
  const { mod } = create`
    require.ensure(['./sample-script']);
  `;

  await expect(mod.evaluate()).resolves.toBeUndefined();
});

it('changes resolve behaviour on overriding _resolveFilename', async () => {
  const code = dedent`
    module.exports = [
      require.resolve('foo'),
      require.resolve('test'),
    ];
  `;
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const entrypoint = createEntrypoint(services, filename, ['*'], code);

  const resolveFilename = jest.fn((id: string) => (id === 'foo' ? 'bar' : id));
  const moduleImpl = {
    _extensions: DefaultModuleImplementation._extensions,
    _nodeModulePaths: DefaultModuleImplementation._nodeModulePaths.bind(
      DefaultModuleImplementation
    ),
    _resolveFilename: resolveFilename as any,
  };

  const mod = new Module(services, entrypoint, undefined, moduleImpl as any);

  await safeEvaluate(mod);

  expect(mod.exports).toEqual(['bar', 'test']);
  expect(resolveFilename).toHaveBeenCalledTimes(2);
});

it('should resolve from the cache', async () => {
  const code = dedent`
    module.exports = [
      require.resolve('foo'),
      require.resolve('test'),
    ];
  `;
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const entrypoint = createEntrypoint(services, filename, ['*'], code);

  const resolveFilename = jest.fn((...args: unknown[]) =>
    DefaultModuleImplementation._resolveFilename.call(
      DefaultModuleImplementation as any,
      ...args
    )
  );
  const moduleImpl = {
    _extensions: DefaultModuleImplementation._extensions,
    _nodeModulePaths: DefaultModuleImplementation._nodeModulePaths.bind(
      DefaultModuleImplementation
    ),
    _resolveFilename: resolveFilename as any,
  };

  const mod = new Module(services, entrypoint, undefined, moduleImpl as any);

  entrypoint.addDependency({
    only: ['*'],
    resolved: 'resolved foo',
    source: 'foo',
  });
  entrypoint.addDependency({
    only: ['*'],
    resolved: 'resolved test',
    source: 'test',
  });

  await safeEvaluate(mod);

  expect(mod.exports).toEqual(['resolved foo', 'resolved test']);
  expect(resolveFilename).toHaveBeenCalledTimes(0);
});

it('correctly processes export declarations in strict mode', async () => {
  const { mod } = create`
    "use strict";
    exports = module.exports = () => 42
  `;

  await safeEvaluate(mod);

  expect((mod.exports as any)()).toBe(42);
  expect(mod.id).toBe(filename);
  expect(mod.filename).toBe(filename);
});

it('export * compiled by typescript to commonjs works', async () => {
  const { mod } = create`
    const { foo } = require('./ts-compiled-re-exports');

    module.exports = foo;
  `;

  await safeEvaluate(mod);

  expect(mod.exports).toBe('foo');
});

it('does not warn when dependency is resolved during prepare stage', async () => {
  const { entrypoint, mod, services } = create`
    module.exports = require('./sample-script');
  `;

  services.options.root = path.dirname(filename);

  entrypoint.addDependency({
    only: ['*'],
    resolved: require.resolve('./__fixtures__/sample-script.js'),
    source: './sample-script',
  });

  await safeEvaluate(mod);

  expect(mod.exports).toBe(42);
  expect(services.emitWarning as jest.Mock).not.toHaveBeenCalled();
});

it('warns only on eval-time fallback and dedupes by canonical key', () => {
  const { mod, services } = create``;

  services.options.root = path.dirname(filename);

  safeRequire(mod, './sample-script');
  safeRequire(mod, './sample-script');

  expect(services.emitWarning as jest.Mock).toHaveBeenCalledTimes(1);
  expect((services.emitWarning as jest.Mock).mock.calls[0][0]).toContain(
    'config key: ./sample-script.js'
  );
});

it('supports importOverrides.unknown=error for eval-time fallback', () => {
  const { mod, services } = create``;

  services.options.root = path.dirname(filename);
  services.options.pluginOptions.importOverrides = {
    './sample-script.js': {
      unknown: 'error',
    },
  };

  expect(() => safeRequire(mod, './sample-script')).toThrow(
    'Unknown import reached during eval'
  );
});

it('supports glob patterns in importOverrides for eval-time fallback', () => {
  const { mod, services } = create``;

  services.options.root = path.dirname(filename);
  services.options.pluginOptions.importOverrides = {
    './sample-*.js': {
      unknown: 'error',
    },
  };

  expect(() => safeRequire(mod, './sample-script')).toThrow(
    'Unknown import reached during eval'
  );
});

it('supports importOverrides.mock for eval-time fallback', () => {
  const { mod, services } = create``;

  services.options.root = path.dirname(filename);
  services.options.pluginOptions.importOverrides = {
    './sample-script.js': {
      mock: './objectExport.js',
    },
  };

  expect(safeRequire(mod, './sample-script')).toEqual({ margin: 5 });
  expect(services.emitWarning as jest.Mock).not.toHaveBeenCalled();
});

describe('ESM resolver order', () => {
  it('prefers custom resolver over bundler dependencies', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-esm-custom-'));
    const entryFile = path.join(root, 'entry.js');
    const bundlerFile = path.join(root, 'bundler.js');
    const customFile = path.join(root, 'custom.js');

    fs.writeFileSync(bundlerFile, `export default 'bundler';`);
    fs.writeFileSync(customFile, `export default 'custom';`);

    const code = dedent`
      import value from 'dep';
      export const result = value;
    `;

    const customResolver = jest.fn(async (specifier: string) => {
      if (specifier === 'dep') {
        return { id: customFile };
      }

      return null;
    });

    const customLoader = jest.fn(async (id: string) => {
      if (id === customFile) {
        return { code: fs.readFileSync(customFile, 'utf8') };
      }

      return null;
    });

    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename: entryFile,
        pluginOptions: {
          ...options,
          eval: {
            customResolver,
            customLoader,
          },
        },
      },
    });

    const entrypoint = createEntrypoint(services, entryFile, ['*'], code);
    entrypoint.addDependency({
      source: 'dep',
      resolved: bundlerFile,
      only: ['*'],
    });

    const mod = new Module(services, entrypoint);
    await safeEvaluate(mod);

    expect(entrypoint.exports.result).toBe('custom');
    expect(customResolver).toHaveBeenCalledWith('dep', entryFile, 'import');
  });

  it('falls back to bundler before native resolver in bundler mode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-esm-bundler-'));
    const entryFile = path.join(root, 'entry.js');
    const bundlerFile = path.join(root, 'bundler.js');

    fs.writeFileSync(bundlerFile, `export default 'bundler';`);

    const code = dedent`
      import value from 'dep';
      export const result = value;
    `;

    const customResolver = jest.fn(async () => null);

    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename: entryFile,
        pluginOptions: {
          ...options,
          eval: {
            customResolver,
          },
        },
      },
    });

    const entrypoint = createEntrypoint(services, entryFile, ['*'], code);
    entrypoint.addDependency({
      source: 'dep',
      resolved: bundlerFile,
      only: ['*'],
    });

    const mod = new Module(services, entrypoint);
    const fallbackSpy = jest.spyOn(mod, 'resolveWithNativeFallback');

    await safeEvaluate(mod);

    expect(entrypoint.exports.result).toBe('bundler');
    expect(customResolver).toHaveBeenCalledWith('dep', entryFile, 'import');
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('uses native resolver when bundler data is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-esm-native-'));
    const entryFile = path.join(root, 'entry.js');
    const nativeFile = path.join(root, 'node_modules', 'dep', 'index.js');

    fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
    fs.writeFileSync(nativeFile, `export default 'native';`);

    const code = dedent`
      import value from 'dep';
      export const result = value;
    `;

    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename: entryFile,
        pluginOptions: {
          ...options,
          eval: {
            customResolver: async () => null,
          },
        },
      },
    });

    const entrypoint = createEntrypoint(services, entryFile, ['*'], code);
    const mod = new Module(services, entrypoint);
    const fallbackSpy = jest.spyOn(mod, 'resolveWithNativeFallback');

    await safeEvaluate(mod);

    expect(entrypoint.exports.result).toBe('native');
    expect(fallbackSpy).toHaveBeenCalled();
  });

  it('prefers native resolver over bundler dependencies in hybrid mode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-esm-hybrid-'));
    const entryFile = path.join(root, 'entry.js');
    const bundlerFile = path.join(root, 'bundler.js');
    const nativeFile = path.join(root, 'node_modules', 'dep', 'index.js');

    fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
    fs.writeFileSync(bundlerFile, `export default 'bundler';`);
    fs.writeFileSync(nativeFile, `export default 'native';`);

    const code = dedent`
      import value from 'dep';
      export const result = value;
    `;

    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename: entryFile,
        pluginOptions: {
          ...options,
          eval: {
            resolver: 'hybrid',
          },
        },
      },
    });

    const entrypoint = createEntrypoint(services, entryFile, ['*'], code);
    entrypoint.addDependency({
      source: 'dep',
      resolved: bundlerFile,
      only: ['*'],
    });

    const mod = new Module(services, entrypoint);
    await safeEvaluate(mod);

    expect(entrypoint.exports.result).toBe('native');
  });
});

describe('ESM specifiers', () => {
  it('handles query IDs via import loaders', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-esm-query-'));
    const entryFile = path.join(root, 'entry.js');
    const assetFile = path.join(root, 'asset.txt');

    fs.writeFileSync(assetFile, 'raw-content');

    const code = dedent`
      import asset from './asset.txt?raw';
      export const value = asset;
    `;

    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename: entryFile,
        pluginOptions: { ...options },
      },
    });

    const entrypoint = createEntrypoint(services, entryFile, ['*'], code);
    entrypoint.addDependency({
      source: './asset.txt?raw',
      resolved: `${assetFile}?raw`,
      only: ['*'],
    });

    const mod = new Module(services, entrypoint);
    await safeEvaluate(mod);

    expect(entrypoint.exports.value).toBe('raw-content');
  });

  it('handles Vite virtual IDs during linking', async () => {
    const { mod, entrypoint } = create`
      import { createSignatureFunctionForTransform } from '/@react-refresh';

      export const ok = typeof createSignatureFunctionForTransform === 'function';
    `;

    await safeEvaluate(mod);

    expect(entrypoint.exports.ok).toBe(true);
  });
});

describe('ESM evaluation determinism', () => {
  it('does not re-evaluate when called twice', async () => {
    const counter = { value: 0 };
    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename,
        pluginOptions: {
          ...options,
          overrideContext: (context) => ({
            ...context,
            counter,
          }),
        },
      },
    });

    const entrypoint = createEntrypoint(
      services,
      filename,
      ['*'],
      dedent`
        counter.value += 1;
        export const value = counter.value;
      `
    );

    const mod = new Module(services, entrypoint);

    await mod.evaluate();
    expect(entrypoint.exports.value).toBe(1);

    await mod.evaluate();
    expect(entrypoint.exports.value).toBe(1);
    expect(counter.value).toBe(1);
  });
});

describe('globals', () => {
  it.each([{ name: 'Timeout' }, { name: 'Interval' }, { name: 'Immediate' }])(
    `has set$name, clear$name available`,
    async (i) => {
      const { mod } = create`
        const x = set${i.name}(() => {
          console.log('test');
        },0);

        clear${i.name}(x);
      `;

      await expect(mod.evaluate()).resolves.toBeUndefined();
    }
  );

  it('has global objects available without referencing global', async () => {
    const { mod } = create`
      const x = new Set();
    `;

    await expect(mod.evaluate()).resolves.toBeUndefined();
  });
});

describe('definable globals', () => {
  it('has __filename available', async () => {
    const { mod } = create`
      module.exports = __filename;
    `;

    await safeEvaluate(mod);

    expect(mod.exports).toBe(mod.filename);
  });

  it('has __dirname available', async () => {
    const { mod } = create`
      module.exports = __dirname;
    `;

    await safeEvaluate(mod);

    expect(mod.exports).toBe(path.dirname(mod.filename));
  });
});

describe('conditionNames', () => {
  it('passes expanded conditions to _resolveFilename', async () => {
    const code = dedent`
      module.exports = require.resolve('my-pkg');
    `;
    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename,
        pluginOptions: {
          ...options,
          conditionNames: ['custom', '...'],
        },
      },
    });
    const entrypoint = createEntrypoint(services, filename, ['*'], code);

    const resolveFilename = jest.fn(
      (
        _id: string,
        _parent: unknown,
        _isMain?: boolean,
        opts?: { conditions?: Set<string> }
      ) => {
        if (opts?.conditions) {
          return JSON.stringify([...opts.conditions].sort());
        }
        return _id;
      }
    );

    const moduleImpl = {
      _extensions: DefaultModuleImplementation._extensions,
      _nodeModulePaths: DefaultModuleImplementation._nodeModulePaths.bind(
        DefaultModuleImplementation
      ),
      _resolveFilename: resolveFilename as never,
    };

    const mod = new Module(
      services,
      entrypoint,
      undefined,
      moduleImpl as never
    );
    await safeEvaluate(mod);

    expect(JSON.parse(mod.exports as string)).toEqual([
      'custom',
      'default',
      'node',
      'require',
    ]);
  });

  it('"..." expands to CJS defaults (require, node, default)', async () => {
    const code = dedent`
      module.exports = require.resolve('my-pkg');
    `;
    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename,
        pluginOptions: {
          ...options,
          conditionNames: ['...'],
        },
      },
    });
    const entrypoint = createEntrypoint(services, filename, ['*'], code);

    const resolveFilename = jest.fn(
      (
        _id: string,
        _parent: unknown,
        _isMain?: boolean,
        opts?: { conditions?: Set<string> }
      ) => {
        return JSON.stringify(
          opts?.conditions ? [...opts.conditions].sort() : null
        );
      }
    );

    const moduleImpl = {
      _extensions: DefaultModuleImplementation._extensions,
      _nodeModulePaths: DefaultModuleImplementation._nodeModulePaths.bind(
        DefaultModuleImplementation
      ),
      _resolveFilename: resolveFilename as never,
    };

    const mod = new Module(
      services,
      entrypoint,
      undefined,
      moduleImpl as never
    );
    await safeEvaluate(mod);

    expect(JSON.parse(mod.exports as string)).toEqual([
      'default',
      'node',
      'require',
    ]);
  });

  it('without "..." only listed conditions are passed', async () => {
    const code = dedent`
      module.exports = require.resolve('my-pkg');
    `;
    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename,
        pluginOptions: {
          ...options,
          conditionNames: ['custom-only'],
        },
      },
    });
    const entrypoint = createEntrypoint(services, filename, ['*'], code);

    const resolveFilename = jest.fn(
      (
        _id: string,
        _parent: unknown,
        _isMain?: boolean,
        opts?: { conditions?: Set<string> }
      ) => {
        return JSON.stringify(opts?.conditions ? [...opts.conditions] : null);
      }
    );

    const moduleImpl = {
      _extensions: DefaultModuleImplementation._extensions,
      _nodeModulePaths: DefaultModuleImplementation._nodeModulePaths.bind(
        DefaultModuleImplementation
      ),
      _resolveFilename: resolveFilename as never,
    };

    const mod = new Module(
      services,
      entrypoint,
      undefined,
      moduleImpl as never
    );
    await safeEvaluate(mod);

    expect(JSON.parse(mod.exports as string)).toEqual(['custom-only']);
  });

  it('does not pass conditions when conditionNames is not set', async () => {
    const code = dedent`
      module.exports = require.resolve('my-pkg');
    `;
    const cache = new TransformCacheCollection();
    const services = createServices({ cache });
    const entrypoint = createEntrypoint(services, filename, ['*'], code);

    const resolveFilename = jest.fn(
      (
        _id: string,
        _parent: unknown,
        _isMain?: boolean,
        opts?: { conditions?: Set<string> }
      ) => {
        return String(opts);
      }
    );

    const moduleImpl = {
      _extensions: DefaultModuleImplementation._extensions,
      _nodeModulePaths: DefaultModuleImplementation._nodeModulePaths.bind(
        DefaultModuleImplementation
      ),
      _resolveFilename: resolveFilename as never,
    };

    const mod = new Module(
      services,
      entrypoint,
      undefined,
      moduleImpl as never
    );
    await safeEvaluate(mod);

    expect(mod.exports).toBe('undefined');
  });

  it('retries with extensions when conditions cause MODULE_NOT_FOUND', async () => {
    const code = dedent`
      module.exports = require.resolve('my-pkg/src/util');
    `;
    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename,
        pluginOptions: {
          ...options,
          conditionNames: ['custom', '...'],
        },
      },
    });
    const entrypoint = createEntrypoint(services, filename, ['*'], code);

    const resolveFilename = jest.fn((id: string) => {
      // Simulate: bare request fails, but request + .ts succeeds
      if (id === 'my-pkg/src/util') {
        const err = new Error('MODULE_NOT_FOUND') as NodeJS.ErrnoException;
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      if (id === 'my-pkg/src/util.ts') {
        return '/resolved/my-pkg/src/util.ts';
      }
      const err = new Error('MODULE_NOT_FOUND') as NodeJS.ErrnoException;
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    });

    const moduleImpl = {
      _extensions: DefaultModuleImplementation._extensions,
      _nodeModulePaths: DefaultModuleImplementation._nodeModulePaths.bind(
        DefaultModuleImplementation
      ),
      _resolveFilename: resolveFilename as never,
    };

    const mod = new Module(
      services,
      entrypoint,
      undefined,
      moduleImpl as never
    );
    await safeEvaluate(mod);

    expect(mod.exports).toBe('/resolved/my-pkg/src/util.ts');
  });

  it('does not retry explicit extensions when conditions cause MODULE_NOT_FOUND', () => {
    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename,
        pluginOptions: {
          ...options,
          conditionNames: ['custom', '...'],
        },
      },
    });
    const entrypoint = createEntrypoint(
      services,
      filename,
      ['*'],
      'module.exports = 1;'
    );

    const missing = new Error('MODULE_NOT_FOUND') as NodeJS.ErrnoException;
    missing.code = 'MODULE_NOT_FOUND';
    const resolveFilename = jest.fn(() => {
      throw missing;
    });

    const moduleImpl = {
      _extensions: DefaultModuleImplementation._extensions,
      _nodeModulePaths: DefaultModuleImplementation._nodeModulePaths.bind(
        DefaultModuleImplementation
      ),
      _resolveFilename: resolveFilename as never,
    };

    const mod = new Module(
      services,
      entrypoint,
      undefined,
      moduleImpl as never
    );

    expect(() => mod.resolve('./foo.js')).toThrow(
      'Native resolver failed during eval'
    );
    expect(resolveFilename.mock.calls.map(([id]) => id)).toEqual(['./foo.js']);
  });

  it('does not retry scoped package roots when conditions cause MODULE_NOT_FOUND', () => {
    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename,
        pluginOptions: {
          ...options,
          conditionNames: ['custom', '...'],
        },
      },
    });
    const entrypoint = createEntrypoint(
      services,
      filename,
      ['*'],
      'module.exports = 1;'
    );

    const missing = new Error('MODULE_NOT_FOUND') as NodeJS.ErrnoException;
    missing.code = 'MODULE_NOT_FOUND';
    const resolveFilename = jest.fn((id: string) => {
      if (id === '@scope/pkg') {
        throw missing;
      }

      if (id === '@scope/pkg.js') {
        return '/resolved/wrong-package.js';
      }

      throw missing;
    });

    const moduleImpl = {
      _extensions: DefaultModuleImplementation._extensions,
      _nodeModulePaths: DefaultModuleImplementation._nodeModulePaths.bind(
        DefaultModuleImplementation
      ),
      _resolveFilename: resolveFilename as never,
    };

    const mod = new Module(
      services,
      entrypoint,
      undefined,
      moduleImpl as never
    );

    expect(() => mod.resolve('@scope/pkg')).toThrow(
      'Native resolver failed during eval'
    );
    expect(resolveFilename.mock.calls.map(([id]) => id)).toEqual([
      '@scope/pkg',
    ]);
  });
});

describe('DOM', () => {
  it('should have DOM globals available', async () => {
    const { mod } = create`
      module.exports = {
        document: typeof document,
        window: typeof window,
        global: typeof global,
      };
    `;

    await safeEvaluate(mod);

    expect(mod.exports).toEqual({
      document: 'object',
      window: 'object',
      global: 'object',
    });
  });

  it('should have DOM APIs available', async () => {
    const { mod } = create`
      const handler = () => {}

      document.addEventListener('click', handler);
      document.removeEventListener('click', handler);

    window.addEventListener('click', handler);
    window.removeEventListener('click', handler);
  `;

    await expect(mod.evaluate()).resolves.toBeUndefined();
  });

  it('supports DOM manipulations', async () => {
    const { mod } = create`
      const el = document.createElement('div');
      el.setAttribute('id', 'test');

      document.body.appendChild(el);

      module.exports = {
        html: document.body.innerHTML,
        tagName: el.tagName.toLowerCase()
      };
    `;

    await safeEvaluate(mod);

    expect(mod.exports).toEqual({
      html: '<div id="test"></div>',
      tagName: 'div',
    });
  });
});
