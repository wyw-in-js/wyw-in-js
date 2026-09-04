const transformMock = jest.fn();
const cacheGetMock = jest.fn();
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
  disposeEvalBroker: jest.fn(),
}));

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe('@wyw-in-js/rollup serializeTransform', () => {
  beforeEach(() => {
    transformMock.mockReset();
    cacheGetMock.mockReset();
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

  const createContext = () =>
    ({
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
    expect(entryServices.asyncResolveKey).toMatch(/^rollup:\d+$/);
    expect(dependencyServices.asyncResolveKey).toBe(
      entryServices.asyncResolveKey
    );
    expect(entryServices.loadDependencyCodeKey).toBe(
      entryServices.asyncResolveKey
    );
    expect(dependencyServices.loadDependencyCodeKey).toBe(
      entryServices.loadDependencyCodeKey
    );
  });

  it('keeps one semantic resolver scope across contexts in a Rollup graph', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ serializeTransform: false });
    const resolve = jest.fn(async (what: string) => ({
      id: what,
      external: false,
    }));

    await plugin.transform!.call(
      { ...createContext(), resolve },
      'export {}',
      '/abs/a.ts'
    );
    await plugin.transform!.call(
      { ...createContext(), resolve },
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
  });

  it('isolates semantic resolver scopes between Rollup graphs', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ serializeTransform: false });

    await plugin.transform!.call(createContext(), 'export {}', '/abs/a.ts');
    await plugin.transform!.call(createContext(), 'export {}', '/abs/b.ts');

    const [firstServices, secondServices] = transformMock.mock.calls.map(
      ([services]) => services
    );
    expect(firstServices.asyncResolveKey).not.toBe(
      secondServices.asyncResolveKey
    );
    expect(firstServices.loadDependencyCodeKey).not.toBe(
      secondServices.loadDependencyCodeKey
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
