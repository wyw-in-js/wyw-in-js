const transformMock = jest.fn();

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  logger: jest.fn(),
  mergeOxcResolverAlias: (oxcOptions: any) => oxcOptions,
  toNativeResolverAlias: jest.fn(() => ({})),
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  createFileReporter: () => ({
    emitter: { single: jest.fn() },
    onDone: jest.fn(),
  }),
  TransformCacheCollection: function TransformCacheCollection() {},
  transform: (...args: unknown[]) => transformMock(...args),
  disposeEvalBroker: jest.fn(),
}));

class TestCache {
  cache = new Map<string, string>();

  dependenciesCache = new Map<string, string[]>();

  get(key: string) {
    return Promise.resolve(this.cache.get(key) ?? '');
  }

  getDependencies(key: string) {
    return Promise.resolve(this.dependenciesCache.get(key) ?? []);
  }

  set(key: string, value: string) {
    this.cache.set(key, value);
    return Promise.resolve();
  }

  setDependencies(key: string, value: string[]) {
    this.dependenciesCache.set(key, value);
    return Promise.resolve();
  }
}

const createHook = <TArgs extends unknown[]>() => {
  const handlers: Array<(...args: TArgs) => void> = [];

  return {
    call: (...args: TArgs) => {
      handlers.forEach((handler) => handler(...args));
    },
    tap: (_name: string, handler: (...args: TArgs) => void) => {
      handlers.push(handler);
    },
  };
};

const createCompiler = (cache: false | { type: 'filesystem' } = false) => ({
  getCache: jest.fn(),
  hooks: {
    done: createHook<[unknown]>(),
    failed: createHook<[Error]>(),
    shutdown: createHook<[]>(),
    watchClose: createHook<[]>(),
  },
  options: { cache },
});

const getOutputLoaderOptions = (request: string) => {
  const outputLoaderRequest = request.split('!=!', 2)[1].split('!', 1)[0];
  const queryIndex = outputLoaderRequest.indexOf('?');
  const params = new URLSearchParams(
    queryIndex === -1 ? '' : outputLoaderRequest.slice(queryIndex + 1)
  );

  return {
    cacheProvider: params.get('cacheProvider') || undefined,
    cacheProviderToken: params.get('cacheProviderToken') || undefined,
    outputCssPayload: params.get('outputCssPayload') || undefined,
  };
};

const runWebpackLoader = async ({
  cacheProvider,
  compiler,
  dependencies = [],
  loaderIdent = 'default',
  resourcePath,
}: {
  cacheProvider?: TestCache;
  compiler: ReturnType<typeof createCompiler>;
  dependencies?: string[];
  loaderIdent?: string;
  resourcePath: string;
}) => {
  const { default: webpackLoader } = await import('../index');
  let emittedRequest = '';

  await new Promise<void>((resolve, reject) => {
    webpackLoader.call(
      {
        _compiler: compiler,
        addDependency: jest.fn(),
        async: jest.fn(),
        callback: (err: Error | null, code?: string) => {
          if (err) {
            reject(err);
            return;
          }

          const match = String(code).match(/require\(([^)]+)\);/);
          if (!match) {
            reject(new Error('Expected loader to emit a require() call'));
            return;
          }

          emittedRequest = JSON.parse(match[1].trim());
          resolve();
        },
        context: process.cwd(),
        emitWarning: jest.fn(),
        getDependencies: () => dependencies,
        getOptions: () => (cacheProvider ? { cacheProvider } : {}),
        getResolve: () =>
          jest.fn(
            (_ctx: string, _token: string, cb: (err: any, res: any) => void) =>
              cb(null, null)
          ),
        loaderIndex: 0,
        loaders: [{ ident: loaderIdent }],
        request: `/abs/webpack-loader.js??${loaderIdent}!${resourcePath}`,
        resourcePath,
        rootContext: process.cwd(),
        utils: {
          contextify: (_ctx: string, request: string) => request,
        },
      } as any,
      'module.exports = 1;',
      null
    );
  });

  return emittedRequest;
};

const runOutputCssLoader = async ({
  addDependency = jest.fn(),
  compiler,
  options,
  resourcePath,
}: {
  addDependency?: ReturnType<typeof jest.fn>;
  compiler: ReturnType<typeof createCompiler>;
  options: ReturnType<typeof getOutputLoaderOptions>;
  resourcePath: string;
}) => {
  const { default: outputCssLoader } = await import('../outputCssLoader');

  return new Promise<string>((resolve, reject) => {
    outputCssLoader.call({
      _compiler: compiler,
      addDependency,
      async: jest.fn(),
      callback: (err: Error | null, css?: string) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(css ?? '');
      },
      getOptions: () => options,
      resourcePath,
    } as any);
  });
};

describe('webpack-loader cacheProvider', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('keeps an exact payload after compiler-scoped state is disposed', async () => {
    const cacheProvider = new TestCache();
    const compiler = createCompiler();
    const resourcePath = '/abs/entry.jsx';
    const getSpy = jest.spyOn(cacheProvider, 'get');

    transformMock.mockResolvedValue({
      code: 'module.exports = 1;',
      sourceMap: null,
      cssText: '.title{color:red}',
      cssSourceMapText: '',
      dependencies: [],
    });

    const request = await runWebpackLoader({
      cacheProvider,
      compiler,
      resourcePath,
    });
    const options = getOutputLoaderOptions(request);
    const css = await runOutputCssLoader({
      compiler,
      options,
      resourcePath,
    });

    expect(options.cacheProviderToken).toMatch(/^[a-f0-9]{64}$/);
    expect(options.outputCssPayload).toBeTruthy();
    expect(request).not.toContain('&v=');
    expect(getSpy).not.toHaveBeenCalled();
    expect(css).toContain('.title{color:red}');

    compiler.hooks.shutdown.call();
    await expect(
      runOutputCssLoader({ compiler, options, resourcePath })
    ).resolves.toContain('.title{color:red}');
  });

  it('keeps object providers isolated for the same resource', async () => {
    const firstCacheProvider = new TestCache();
    const secondCacheProvider = new TestCache();
    const compiler = createCompiler();
    const resourcePath = '/abs/entry.jsx';

    transformMock
      .mockResolvedValueOnce({
        code: 'module.exports = 1;',
        sourceMap: null,
        cssText: '.title{color:red}',
        cssSourceMapText: '',
        dependencies: [],
      })
      .mockResolvedValueOnce({
        code: 'module.exports = 2;',
        sourceMap: null,
        cssText: '.title{color:blue}',
        cssSourceMapText: '',
        dependencies: [],
      });

    const firstRequest = await runWebpackLoader({
      cacheProvider: firstCacheProvider,
      compiler,
      loaderIdent: 'first',
      resourcePath,
    });
    const secondRequest = await runWebpackLoader({
      cacheProvider: secondCacheProvider,
      compiler,
      loaderIdent: 'second',
      resourcePath,
    });
    const firstOptions = getOutputLoaderOptions(firstRequest);
    const secondOptions = getOutputLoaderOptions(secondRequest);

    expect(firstOptions.cacheProviderToken).not.toBe(
      secondOptions.cacheProviderToken
    );
    await expect(
      runOutputCssLoader({
        compiler,
        options: firstOptions,
        resourcePath,
      })
    ).resolves.toContain('.title{color:red}');
    await expect(
      runOutputCssLoader({
        compiler,
        options: secondOptions,
        resourcePath,
      })
    ).resolves.toContain('.title{color:blue}');
  });

  it('uses an exact payload when two provider objects reuse an ident', async () => {
    const compiler = createCompiler();
    const resourcePath = '/abs/entry.jsx';

    transformMock
      .mockResolvedValueOnce({
        code: 'module.exports = 1;',
        sourceMap: null,
        cssText: '.title{color:red}',
        cssSourceMapText: '',
        dependencies: [],
      })
      .mockResolvedValueOnce({
        code: 'module.exports = 2;',
        sourceMap: null,
        cssText: '.title{color:blue}',
        cssSourceMapText: '',
        dependencies: [],
      });

    const firstRequest = await runWebpackLoader({
      cacheProvider: new TestCache(),
      compiler,
      loaderIdent: 'reused',
      resourcePath,
    });
    const secondRequest = await runWebpackLoader({
      cacheProvider: new TestCache(),
      compiler,
      loaderIdent: 'reused',
      resourcePath,
    });
    const firstOptions = getOutputLoaderOptions(firstRequest);
    const secondOptions = getOutputLoaderOptions(secondRequest);

    expect(firstOptions.cacheProviderToken).toBeTruthy();
    expect(secondOptions.cacheProviderToken).toBeUndefined();
    expect(secondOptions.outputCssPayload).toBeTruthy();
    await expect(
      runOutputCssLoader({
        compiler,
        options: firstOptions,
        resourcePath,
      })
    ).resolves.toContain('.title{color:red}');
    await expect(
      runOutputCssLoader({
        compiler,
        options: secondOptions,
        resourcePath,
      })
    ).resolves.toContain('.title{color:blue}');
  });

  it('emits CSS when outputCssLoader sees a Windows path variant', async () => {
    const compiler = createCompiler();
    const writerPath = 'D:\\work\\app\\commonStyle.ts';
    const readerPath = 'D:/work/app/commonStyle.ts';

    transformMock.mockResolvedValue({
      code: 'module.exports = 1;',
      sourceMap: null,
      cssText: '.title{color:blue}',
      cssSourceMapText: '',
      dependencies: [],
    });

    const request = await runWebpackLoader({
      compiler,
      resourcePath: writerPath,
    });
    const css = await runOutputCssLoader({
      compiler,
      options: getOutputLoaderOptions(request),
      resourcePath: readerPath,
    });

    expect(request).toContain(writerPath);
    expect(getOutputLoaderOptions(request).cacheProviderToken).toBeUndefined();
    expect(css).toContain('.title{color:blue}');
  });

  it('falls back to a self-contained payload after a process restart', async () => {
    const dependency = '/abs/theme.ts';
    const firstCompiler = createCompiler({ type: 'filesystem' });
    const secondCompiler = createCompiler({ type: 'filesystem' });
    const resourcePath = '/abs/entry.jsx';

    transformMock.mockResolvedValue({
      code: 'module.exports = 1;',
      sourceMap: null,
      cssText: '.title{color:green}',
      cssSourceMapText: '',
      dependencies: [],
    });

    const request = await runWebpackLoader({
      compiler: firstCompiler,
      dependencies: [dependency],
      resourcePath,
    });
    const options = getOutputLoaderOptions(request);
    const addDependency = jest.fn();
    const css = await runOutputCssLoader({
      addDependency,
      compiler: secondCompiler,
      options,
      resourcePath,
    });

    expect(options.outputCssPayload).toBeTruthy();
    expect(options.outputCssPayload).not.toContain(dependency);
    expect(addDependency).not.toHaveBeenCalled();
    expect(css).toContain('.title{color:green}');
  });

  it.each([false, { type: 'filesystem' }] as const)(
    'prefers the exact payload over newer runtime state with cache %p',
    async (cache) => {
      const cacheProvider = new TestCache();
      const compiler = createCompiler(cache);
      const resourcePath = '/abs/entry.jsx';

      transformMock.mockResolvedValue({
        code: 'module.exports = 1;',
        sourceMap: null,
        cssText: '.title{color:green}',
        cssSourceMapText: '',
        dependencies: [],
      });

      const request = await runWebpackLoader({
        cacheProvider,
        compiler,
        resourcePath,
      });
      await cacheProvider.set(resourcePath, '.title{color:wrong}');

      await expect(
        runOutputCssLoader({
          compiler,
          options: getOutputLoaderOptions(request),
          resourcePath,
        })
      ).resolves.toContain('.title{color:green}');
    }
  );
});
