const transformMock = jest.fn();
const cacheGetMock = jest.fn();
const disposeEvalBrokerMock = jest.fn();
const slugifyMock = jest.fn();

let activeTransforms = 0;
let maxActiveTransforms = 0;

const createLogger = () => {
  const log = (() => {}) as any;
  log.extend = () => log;
  return log;
};

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  asyncResolverFactory:
    (onResolve: any, mapper: any) =>
    (resolveFn: any) =>
    (what: any, importer: any, stack: any) =>
      Promise.resolve(resolveFn(...mapper(what, importer, stack))).then(
        (resolved) => onResolve(resolved, what, importer, stack)
      ),
  logger: createLogger(),
  slugify: (...args: unknown[]) => slugifyMock(...args),
  syncResolve: () => null,
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  getFileIdx: () => 'file',
  TransformCacheCollection: function TransformCacheCollection() {
    return {
      get: (...args: unknown[]) => cacheGetMock(...args),
    };
  },
  transform: (...args: unknown[]) => transformMock(...args),
  disposeEvalBroker: (...args: unknown[]) => disposeEvalBrokerMock(...args),
}));

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

describe('@wyw-in-js/rollup serializeTransform', () => {
  beforeEach(() => {
    transformMock.mockReset();
    cacheGetMock.mockReset();
    disposeEvalBrokerMock.mockReset();
    slugifyMock.mockReset();
    cacheGetMock.mockReturnValue(undefined);
    slugifyMock.mockReturnValue('slug');
    activeTransforms = 0;
    maxActiveTransforms = 0;

    transformMock.mockImplementation(async () => {
      activeTransforms += 1;
      maxActiveTransforms = Math.max(maxActiveTransforms, activeTransforms);
      await sleep(25);
      activeTransforms -= 1;
      return {
        code: 'export const x = 1;',
        cssText: '.a{color:red}',
        sourceMap: null,
      };
    });
  });

  const createContext = (
    cacheValues = new Map<string, unknown>(),
    meta: object = { rollupVersion: '4.0.0' }
  ) =>
    ({
      cache: {
        delete: (key: string) => cacheValues.delete(key),
        get: (key: string) => cacheValues.get(key),
        has: (key: string) => cacheValues.has(key),
        set: (key: string, value: unknown) => cacheValues.set(key, value),
      },
      load: jest.fn(async () => undefined),
      meta,
      resolve: jest.fn(async (what: string) => ({ id: what, external: false })),
      warn: jest.fn(),
    }) as any;

  it('serializes concurrent transform() calls by default', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS();
    const ctx = createContext();

    await Promise.all([
      plugin.transform!.call(ctx, 'export {}', '/abs/a.ts'),
      plugin.transform!.call(ctx, 'export {}', '/abs/b.ts'),
    ]);

    expect(maxActiveTransforms).toBe(1);
  });

  it('allows opting out', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ serializeTransform: false });
    const ctx = createContext();

    await Promise.all([
      plugin.transform!.call(ctx, 'export {}', '/abs/a.ts'),
      plugin.transform!.call(ctx, 'export {}', '/abs/b.ts'),
    ]);

    expect(maxActiveTransforms).toBe(2);
  });

  it('binds Rollup plugin context when calling this.resolve', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ serializeTransform: false });

    let resolvedByAsyncResolver: unknown;
    transformMock.mockImplementationOnce(
      async (_services, _code, asyncResolve) => {
        resolvedByAsyncResolver = await asyncResolve(
          '@/components/Centered/Centered.ts',
          '/abs/a.ts',
          []
        );

        return {
          code: _code,
          cssText: '',
          sourceMap: null,
        };
      }
    );

    const resolveMock = jest.fn(function rollupResolve() {
      // Rollup's resolve() may rely on internal state stored on `this`.
      // If WyW calls it as an unbound function, it will throw.
      // eslint-disable-next-line no-void
      void (this as any)._resolveSkipCalls;

      return Promise.resolve({
        id: '/resolved.ts',
        external: false,
      });
    });

    await plugin.transform!.call(
      { resolve: resolveMock, warn: jest.fn(), _resolveSkipCalls: 0 } as any,
      'console.log("test")',
      '/abs/a.ts'
    );

    expect(resolvedByAsyncResolver).toBe('/resolved.ts');
  });

  it('loads resolved dependency code through Rollup for transform dependencies', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ serializeTransform: false });

    let loadedByService: unknown;
    transformMock.mockImplementationOnce(
      async (services, _code, asyncResolve) => {
        const resolved = await asyncResolve('./dep', '/abs/entry.ts', []);
        loadedByService = await services.loadDependencyCode?.(
          resolved,
          '/abs/entry.ts',
          './dep'
        );

        return {
          code: _code,
          cssText: '',
          sourceMap: null,
        };
      }
    );

    const loadMock = jest.fn(async ({ id }: { id: string }) => ({
      id,
      code: 'export const color = "red";',
    }));

    await plugin.transform!.call(
      {
        resolve: jest.fn(async () => ({
          id: '/abs/dep.ts',
          external: false,
        })),
        load: loadMock,
        warn: jest.fn(),
      } as any,
      'console.log("test")',
      '/abs/entry.ts'
    );

    expect(loadMock).toHaveBeenCalledWith({ id: '/abs/dep.ts' });
    expect(loadedByService).toBe('export const color = "red";');
  });

  it('does not reuse Rollup-loaded dependency code after WyW cached the dependency transform', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ serializeTransform: false });

    cacheGetMock.mockReturnValueOnce({
      initialCode: 'export const color = "red";',
    });

    let loadedByService: unknown = 'not-called';
    transformMock.mockImplementationOnce(
      async (services, _code, asyncResolve) => {
        const resolved = await asyncResolve('./dep', '/abs/entry.ts', []);
        loadedByService = await services.loadDependencyCode?.(
          resolved,
          '/abs/entry.ts',
          './dep'
        );

        return {
          code: _code,
          cssText: '',
          sourceMap: null,
        };
      }
    );

    const loadMock = jest.fn(async ({ id }: { id: string }) => ({
      id,
      code: 'export const color = "blue";',
    }));

    await plugin.transform!.call(
      {
        resolve: jest.fn(async () => ({
          id: '/abs/dep.ts',
          external: false,
        })),
        load: loadMock,
        warn: jest.fn(),
      } as any,
      'console.log("test")',
      '/abs/entry.ts'
    );

    expect(loadMock).toHaveBeenCalledWith({ id: '/abs/dep.ts' });
    expect(cacheGetMock).toHaveBeenCalledWith('entrypoints', '/abs/dep.ts');
    expect(loadedByService).toBeUndefined();
  });

  it('returns undefined when Rollup load does not provide dependency code', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ serializeTransform: false });

    let loadedByService: unknown = 'not-called';
    transformMock.mockImplementationOnce(
      async (services, _code, asyncResolve) => {
        const resolved = await asyncResolve('./dep', '/abs/entry.ts', []);
        loadedByService = await services.loadDependencyCode?.(
          resolved,
          '/abs/entry.ts',
          './dep'
        );

        return {
          code: _code,
          cssText: '',
          sourceMap: null,
        };
      }
    );

    const loadMock = jest.fn(async ({ id }: { id: string }) => ({ id }));

    await plugin.transform!.call(
      {
        resolve: jest.fn(async () => ({
          id: '/abs/dep.ts',
          external: false,
        })),
        load: loadMock,
        warn: jest.fn(),
      } as any,
      'console.log("test")',
      '/abs/entry.ts'
    );

    expect(loadMock).toHaveBeenCalledWith({ id: '/abs/dep.ts' });
    expect(loadedByService).toBeUndefined();
  });

  it('omits dependency loading when the Rollup context has no load API', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ serializeTransform: false });
    let receivedServices: any;

    transformMock.mockImplementationOnce(async (services, code) => {
      receivedServices = services;
      return { code, cssText: '', sourceMap: null };
    });

    await plugin.transform!.call(
      {
        meta: { rollupVersion: '1.32.1' },
        resolve: jest.fn(async () => null),
        warn: jest.fn(),
      } as any,
      'console.log("test")',
      '/abs/entry.ts'
    );

    expect(receivedServices.loadDependencyCode).toBeUndefined();
    expect(receivedServices.loadDependencyCodeKey).toBeUndefined();
  });

  it('bypasses serialization for Rollup dependency loads triggered by the parent transform', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS();
    const calls: string[] = [];
    const ctx: any = {
      resolve: jest.fn(async () => ({
        id: '/abs/dep.ts',
        external: false,
      })),
      warn: jest.fn(),
    };

    ctx.load = jest.fn(async ({ id }: { id: string }) => {
      await plugin.transform!.call(ctx, 'export const color = "red";', id);
      return {
        id,
        code: 'export const color = "red";',
      };
    });

    transformMock.mockImplementationOnce(
      async (services, _code, asyncResolve) => {
        calls.push('entry:start');
        const resolved = await asyncResolve('./dep', '/abs/entry.ts', []);
        await services.loadDependencyCode?.(resolved, '/abs/entry.ts', './dep');
        calls.push('entry:end');

        return {
          code: _code,
          cssText: '',
          sourceMap: null,
        };
      }
    );
    transformMock.mockImplementationOnce(async (_services, _code) => {
      calls.push('dependency');

      return {
        code: _code,
        cssText: '',
        sourceMap: null,
      };
    });

    await plugin.transform!.call(ctx, 'console.log("test")', '/abs/entry.ts');

    expect(calls).toEqual(['entry:start', 'dependency', 'entry:end']);
    const [entryServices, dependencyServices] = transformMock.mock.calls.map(
      ([services]) => services
    );
    expect(entryServices.asyncResolveKey).toMatch(/^rollup:\d+:resolver$/);
    expect(dependencyServices.asyncResolveKey).toBe(
      entryServices.asyncResolveKey
    );
    expect(entryServices.loadDependencyCodeKey).toMatch(/^rollup:\d+:loader$/);
    expect(dependencyServices.loadDependencyCodeKey).toBe(
      entryServices.loadDependencyCodeKey
    );
  });

  it('promotes a prequeued dependency without releasing unrelated transforms', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS();
    const calls: string[] = [];
    const entryStarted = deferred();
    const startDependencyLoad = deferred();
    const dependencyFinished = deferred();
    const entryLoaded = deferred();
    const finishEntry = deferred();
    const ctx = createContext();
    let dependencyTransform!: Promise<unknown>;

    ctx.load = jest.fn(async ({ id }: { id: string }) => {
      await dependencyTransform;
      return { id, code: 'export const color = "red";' };
    });

    transformMock.mockImplementation(async (services, code) => {
      if (code === 'entry') {
        calls.push('entry:start');
        entryStarted.resolve();
        await startDependencyLoad.promise;
        await services.loadDependencyCode?.(
          '/abs/dep.ts',
          '/abs/entry.ts',
          './dep'
        );
        calls.push('entry:loaded');
        entryLoaded.resolve();
        await finishEntry.promise;
        calls.push('entry:end');
      } else if (code === 'dependency') {
        calls.push('dependency');
        dependencyFinished.resolve();
      } else {
        calls.push('unrelated');
      }

      return { code, cssText: '', sourceMap: null };
    });

    const entryTransform = plugin.transform!.call(
      ctx,
      'entry',
      '/abs/entry.ts'
    );
    await entryStarted.promise;

    dependencyTransform = Promise.resolve(
      plugin.transform!.call(ctx, 'dependency', '/abs/dep.ts')
    );
    const unrelatedTransform = plugin.transform!.call(
      ctx,
      'unrelated',
      '/abs/unrelated.ts'
    );
    startDependencyLoad.resolve();

    await expect(
      Promise.race([
        dependencyFinished.promise.then(() => 'promoted'),
        sleep(250).then(() => 'timed-out'),
      ])
    ).resolves.toBe('promoted');
    await entryLoaded.promise;
    expect(calls).toEqual(['entry:start', 'dependency', 'entry:loaded']);

    finishEntry.resolve();
    await Promise.all([
      entryTransform,
      dependencyTransform,
      unrelatedTransform,
    ]);
    expect(calls).toEqual([
      'entry:start',
      'dependency',
      'entry:loaded',
      'entry:end',
      'unrelated',
    ]);
  });

  it('keeps one semantic service scope within a Rollup graph', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ serializeTransform: false });
    const graphContext = createContext();
    // Rollup shallow-copies its base PluginContext for every transform hook.
    const firstTransformContext = { ...graphContext };
    const secondTransformContext = { ...graphContext };

    await plugin.buildStart!.call(graphContext);
    await plugin.transform!.call(
      firstTransformContext,
      'export {}',
      '/abs/a.ts'
    );
    await plugin.transform!.call(
      secondTransformContext,
      'export {}',
      '/abs/b.ts'
    );

    const [firstServices, secondServices] = transformMock.mock.calls.map(
      ([services]) => services
    );
    expect(firstServices.asyncResolveKey).toBe(secondServices.asyncResolveKey);
    expect(firstServices.loadDependencyCodeKey).toBe(
      secondServices.loadDependencyCodeKey
    );
    expect(firstServices.cache).toBe(secondServices.cache);
  });

  it('isolates caches, service identities, and queues between Rollup graphs', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS();
    const sharedMeta = { rollupVersion: '4.0.0' };
    const firstContext = createContext(new Map(), sharedMeta);
    const secondContext = createContext(new Map(), sharedMeta);

    await Promise.all([
      plugin.buildStart!.call(firstContext),
      plugin.buildStart!.call(secondContext),
    ]);
    await Promise.all([
      plugin.transform!.call(firstContext, 'export {}', '/abs/a.ts'),
      plugin.transform!.call(secondContext, 'export {}', '/abs/b.ts'),
    ]);

    const [firstServices, secondServices] = transformMock.mock.calls.map(
      ([services]) => services
    );
    expect(maxActiveTransforms).toBe(2);
    expect(firstServices.cache).not.toBe(secondServices.cache);
    expect(firstServices.asyncResolveKey).not.toBe(
      secondServices.asyncResolveKey
    );
    expect(firstServices.loadDependencyCodeKey).not.toBe(
      secondServices.loadDependencyCodeKey
    );
  });

  it('retires graph state at closeBundle before the context is reused', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ serializeTransform: false });
    const ctx = createContext();

    await plugin.buildStart!.call(ctx);
    await plugin.transform!.call(ctx, 'export {}', '/abs/a.ts');
    const firstServices = transformMock.mock.calls[0][0];

    await plugin.closeBundle!.call(ctx);
    await plugin.transform!.call(ctx, 'export {}', '/abs/b.ts');
    const secondServices = transformMock.mock.calls[1][0];

    expect(disposeEvalBrokerMock).toHaveBeenCalledWith(firstServices.cache);
    expect(secondServices.cache).not.toBe(firstServices.cache);
    expect(secondServices.asyncResolveKey).not.toBe(
      firstServices.asyncResolveKey
    );
    expect(secondServices.loadDependencyCodeKey).not.toBe(
      firstServices.loadDependencyCodeKey
    );
  });

  it.each([
    ['1.20.0', false],
    ['1.32.1', false],
    ['2.0.0', true],
    ['3.0.0', true],
    ['4.0.0', true],
  ])(
    'keeps Rollup %s automatic transform caching compatible with plugin cache keys',
    async (rollupVersion, remainsVisible) => {
      const { default: wywInJS } = await import('../index');
      const plugin = wywInJS({ serializeTransform: false });
      const options = { plugins: [plugin] } as any;
      const optionsContext = { meta: { rollupVersion } } as any;

      await plugin.options!.call(optionsContext, options);
      const contextCacheKey = plugin.cacheKey;
      expect(contextCacheKey).toMatch(/^wyw-in-js:\d+$/);

      await plugin.buildStart!.call(
        createContext(new Map(), { rollupVersion })
      );
      expect(plugin.cacheKey).toBe(
        remainsVisible ? contextCacheKey : undefined
      );

      // A subsequent build must expose the same key before Rollup creates its
      // next plugin context so the persisted plugin cache can be handed off.
      await plugin.options!.call(optionsContext, options);
      expect(plugin.cacheKey).toBe(contextCacheKey);
    }
  );

  it('keeps duplicate Rollup 1.x plugin caches isolated across graph hand-off', async () => {
    const { default: wywInJS } = await import('../index');
    const firstPlugin = wywInJS({ serializeTransform: false });
    const secondPlugin = wywInJS({ serializeTransform: false });
    const rollupVersion = '1.32.1';
    const options = { plugins: [firstPlugin, secondPlugin] } as any;
    const optionsContext = { meta: { rollupVersion } } as any;

    await firstPlugin.options!.call(optionsContext, options);
    await secondPlugin.options!.call(optionsContext, options);
    const firstCacheKey = firstPlugin.cacheKey;
    const secondCacheKey = secondPlugin.cacheKey;
    expect(firstCacheKey).not.toBe(secondCacheKey);

    await Promise.all([
      firstPlugin.buildStart!.call(createContext(new Map(), { rollupVersion })),
      secondPlugin.buildStart!.call(
        createContext(new Map(), { rollupVersion })
      ),
    ]);
    expect(firstPlugin.cacheKey).toBeUndefined();
    expect(secondPlugin.cacheKey).toBeUndefined();

    const nextFirstPlugin = wywInJS({ serializeTransform: false });
    const nextSecondPlugin = wywInJS({ serializeTransform: false });
    const nextOptions = {
      plugins: [nextFirstPlugin, nextSecondPlugin],
    } as any;
    await nextFirstPlugin.options!.call(optionsContext, nextOptions);
    await nextSecondPlugin.options!.call(optionsContext, nextOptions);
    expect(nextFirstPlugin.cacheKey).toBe(firstCacheKey);
    expect(nextSecondPlugin.cacheKey).toBe(secondCacheKey);
  });

  it.each([
    ['nested', (plugins: any[]) => [[plugins[0]], [plugins[1]]]],
    [
      'promised',
      (plugins: any[]) => [Promise.resolve(plugins[0]), [plugins[1]]],
    ],
  ])(
    'isolates duplicate plugin cache keys in %s Rollup plugin options',
    async (_case, arrangePlugins) => {
      const { default: wywInJS } = await import('../index');
      const firstPlugin = wywInJS({ serializeTransform: false });
      const secondPlugin = wywInJS({ serializeTransform: false });
      const plugins = arrangePlugins([firstPlugin, secondPlugin]);
      const inputOptions = { plugins } as any;
      const optionsContext = { meta: { rollupVersion: '4.0.0' } } as any;

      await firstPlugin.options!.call(optionsContext, inputOptions);
      await secondPlugin.options!.call(optionsContext, inputOptions);

      expect(firstPlugin.cacheKey).toBe('wyw-in-js:0');
      expect(secondPlugin.cacheKey).toBe('wyw-in-js:1');
    }
  );

  it('hands cached CSS to a fresh plugin instance in the same occurrence slot', async () => {
    const { default: wywInJS } = await import('../index');
    const rollupCache = new Map<string, unknown>();
    const optionsContext = { meta: { rollupVersion: '4.0.0' } } as any;
    const firstPlugin = wywInJS({ serializeTransform: false });
    const firstOptions = { plugins: [firstPlugin] } as any;
    const firstContext = createContext(rollupCache);

    await firstPlugin.options!.call(optionsContext, firstOptions);
    const firstCacheKey = firstPlugin.cacheKey;
    await firstPlugin.buildStart!.call(firstContext);
    await firstPlugin.transform!.call(firstContext, 'export {}', '/abs/a.ts');
    await firstPlugin.buildEnd!.call(firstContext);
    await firstPlugin.closeBundle!.call(firstContext);

    const nextPlugin = wywInJS({ serializeTransform: false });
    const nextOptions = { plugins: [nextPlugin] } as any;
    const nextContext = createContext(rollupCache);
    await nextPlugin.options!.call(optionsContext, nextOptions);
    await nextPlugin.buildStart!.call(nextContext);

    expect(nextPlugin.cacheKey).toBe(firstCacheKey);
    expect(nextPlugin.resolveId!.call(nextContext, '/abs/a_slug.css')).toBe(
      '/abs/a_slug.css'
    );
    expect(nextPlugin.load!.call(nextContext, '/abs/a_slug.css')).toBe(
      '.a{color:red}'
    );
  });

  it('retains generated CSS through Rollup cache across watch graphs', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ serializeTransform: false });
    const rollupCache = new Map<string, unknown>();
    const firstContext = createContext(rollupCache);

    await plugin.buildStart!.call(firstContext);
    await plugin.transform!.call(firstContext, 'export {}', '/abs/a.ts');
    expect(rollupCache.size).toBe(0);
    await plugin.buildEnd!.call(firstContext);
    expect(rollupCache.size).toBe(1);
    await plugin.closeBundle!.call(firstContext);

    const nextContext = createContext(rollupCache);
    await plugin.buildStart!.call(nextContext);
    expect(plugin.resolveId!.call(nextContext, '/abs/a_slug.css')).toBe(
      '/abs/a_slug.css'
    );
    expect(plugin.load!.call(nextContext, '/abs/a_slug.css')).toBe(
      '.a{color:red}'
    );
  });

  it('does not publish CSS from a failed build over the last good graph', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ serializeTransform: false });
    const ctx = createContext();

    await plugin.buildStart!.call(ctx);
    await plugin.transform!.call(ctx, 'export {}', '/abs/a.ts');
    await plugin.buildEnd!.call(ctx);
    expect(plugin.load!.call(ctx, '/abs/a_slug.css')).toBe('.a{color:red}');

    transformMock.mockResolvedValueOnce({
      code: 'export const x = 2;',
      cssText: '.a{color:blue}',
      sourceMap: null,
    });
    await plugin.buildStart!.call(ctx);
    await plugin.transform!.call(ctx, 'export const x = 2;', '/abs/a.ts');
    expect(plugin.load!.call(ctx, '/abs/a_slug.css')).toBe('.a{color:blue}');

    await plugin.buildEnd!.call(ctx, new Error('failed build'));
    expect(plugin.load!.call(ctx, '/abs/a_slug.css')).toBe('.a{color:red}');
  });

  it('falls back when Rollup disables cache for duplicate plugin names', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ serializeTransform: false });
    const graphContext = createContext();
    const unavailableCache = () => ({
      delete: () => {
        throw new Error('duplicate plugin name');
      },
      get: () => {
        throw new Error('duplicate plugin name');
      },
      has: () => {
        throw new Error('duplicate plugin name');
      },
      set: () => {
        throw new Error('duplicate plugin name');
      },
    });
    const transformContext = {
      ...graphContext,
      cache: unavailableCache(),
    };
    const nextHookContext = {
      ...graphContext,
      cache: unavailableCache(),
    };

    await plugin.buildStart!.call(graphContext);
    await plugin.transform!.call(transformContext, 'export {}', '/abs/a.ts');
    await plugin.buildEnd!.call(nextHookContext);
    await plugin.closeBundle!.call(nextHookContext);
    await plugin.buildStart!.call(nextHookContext);

    expect(plugin.resolveId!.call(nextHookContext, '/abs/a_slug.css')).toBe(
      '/abs/a_slug.css'
    );
    expect(plugin.load!.call(nextHookContext, '/abs/a_slug.css')).toBe(
      '.a{color:red}'
    );
  });

  it('supports stable CSS filenames for CSS bundlers with watch caches', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({
      cssFilename: ({ id }) => `${id.replace(/\.[jt]sx?$/, '')}.css`,
    });
    const ctx = createContext();

    transformMock
      .mockResolvedValueOnce({
        code: 'export const x = 1;',
        cssText: '.a{color:red}',
        sourceMap: null,
      })
      .mockResolvedValueOnce({
        code: 'export const x = 1;',
        cssText: '.a{color:blue}',
        sourceMap: null,
      });

    const first = await plugin.transform!.call(ctx, 'export {}', '/abs/a.ts');
    const second = await plugin.transform!.call(ctx, 'export {}', '/abs/a.ts');

    expect(first?.code).toContain('import "/abs/a.css";');
    expect(second?.code).toContain('import "/abs/a.css";');
    expect(plugin.load?.call(ctx, '/abs/a.css')).toBe('.a{color:blue}');
  });
});
