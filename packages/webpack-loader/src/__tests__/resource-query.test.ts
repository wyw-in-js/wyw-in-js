import path from 'path';

import * as actualShared from '@wyw-in-js/shared';

const transformMock = jest.fn();

// Keep the real pure helpers (request parsing, source map normalisation, CSS
// protocol constants) and stub only what the test controls.
const realShared = { ...actualShared };

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  ...realShared,
  logger: jest.fn(),
  mergeOxcResolverAlias: (oxcOptions: any, nativeAlias: any) => ({
    ...oxcOptions,
    resolver: {
      ...(oxcOptions?.resolver ?? {}),
      alias: {
        ...nativeAlias,
        ...(oxcOptions?.resolver?.alias ?? {}),
      },
    },
  }),
  toNativeResolverAlias: (alias: any) =>
    Object.fromEntries(
      Object.entries(alias ?? {})
        .filter(([, replacement]) => typeof replacement === 'string')
        .map(([find, replacement]) => [find, [replacement]])
    ),
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  createFileReporter: () => ({
    emitter: { single: jest.fn() },
    onDone: jest.fn(),
  }),
  TransformCacheCollection: class TransformCacheCollection {},
  transform: (...args: unknown[]) => transformMock(...args),
  disposeEvalBroker: jest.fn(),
}));

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

const createCompiler = () => ({
  hooks: {
    done: createHook<[unknown]>(),
    failed: createHook<[Error]>(),
    shutdown: createHook<[]>(),
    watchClose: createHook<[]>(),
  },
});

describe('webpack-loader asyncResolve', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('adds dependency without ?query/#hash', async () => {
    const { default: webpackLoader } = await import('../index');
    const addDependency = jest.fn();
    const resolveResult = `${path.resolve('assets/icon.svg')}?svgUse`;

    transformMock.mockImplementation(async (_services, _code, asyncResolve) => {
      await asyncResolve('./icon.svg?svgUse', '/abs/entry.tsx');
      return {
        code: _code,
        sourceMap: null,
        cssText: undefined,
        dependencies: [],
      };
    });

    const resolveModule = jest.fn((_ctx, _token, cb) =>
      cb(null, resolveResult)
    );

    await new Promise<void>((resolve, reject) => {
      webpackLoader.call(
        {
          addDependency,
          async: jest.fn(),
          callback: (err: Error | null) => (err ? reject(err) : resolve()),
          emitWarning: jest.fn(),
          getOptions: () => ({}),
          getResolve: () => resolveModule,
          resourcePath: '/abs/entry.tsx',
        } as any,
        'module.exports = 1;',
        null
      );
    });

    expect(addDependency).toHaveBeenCalledWith(path.resolve('assets/icon.svg'));
  });

  it('uses root resolver for deep entrypoints via stack', async () => {
    const { default: webpackLoader } = await import('../index');
    const addDependency = jest.fn();
    const resolved = path.resolve('assets/deep.css');

    transformMock.mockImplementation(async (_services, _code, asyncResolve) => {
      await asyncResolve('./deep.css', '/abs/dependency.ts', [
        '/abs/dependency.ts',
        '/abs/entry.tsx',
      ]);
      return {
        code: _code,
        sourceMap: null,
        cssText: undefined,
        dependencies: [],
      };
    });

    const resolveModule = jest.fn((_ctx, _token, cb) => cb(null, resolved));

    await new Promise<void>((resolve, reject) => {
      webpackLoader.call(
        {
          addDependency,
          async: jest.fn(),
          callback: (err: Error | null) => (err ? reject(err) : resolve()),
          emitWarning: jest.fn(),
          getOptions: () => ({}),
          getResolve: () => resolveModule,
          resourcePath: '/abs/entry.tsx',
        } as any,
        'module.exports = 1;',
        null
      );
    });

    expect(addDependency).toHaveBeenCalledWith(resolved);
  });

  it('reuses compiler-scoped asyncResolve and cache across files', async () => {
    const { default: webpackLoader } = await import('../index');
    const compiler = createCompiler();

    transformMock.mockResolvedValue({
      code: 'module.exports = 1;',
      sourceMap: null,
      cssText: undefined,
      dependencies: [],
    });

    await new Promise<void>((resolve, reject) => {
      webpackLoader.call(
        {
          _compiler: compiler,
          addDependency: jest.fn(),
          async: jest.fn(),
          callback: (err: Error | null) => (err ? reject(err) : resolve()),
          emitWarning: jest.fn(),
          getOptions: () => ({}),
          getResolve: () => jest.fn((_ctx, _token, cb) => cb(null, '/abs/a')),
          resourcePath: '/abs/entry-a.tsx',
        } as any,
        'module.exports = 1;',
        null
      );
    });

    await new Promise<void>((resolve, reject) => {
      webpackLoader.call(
        {
          _compiler: compiler,
          addDependency: jest.fn(),
          async: jest.fn(),
          callback: (err: Error | null) => (err ? reject(err) : resolve()),
          emitWarning: jest.fn(),
          getOptions: () => ({}),
          getResolve: () => jest.fn((_ctx, _token, cb) => cb(null, '/abs/b')),
          resourcePath: '/abs/entry-b.tsx',
        } as any,
        'module.exports = 1;',
        null
      );
    });

    expect(transformMock).toHaveBeenCalledTimes(2);
    expect(transformMock.mock.calls[0][2]).toBe(transformMock.mock.calls[1][2]);
    expect(transformMock.mock.calls[0][0].cache).toBe(
      transformMock.mock.calls[1][0].cache
    );
    expect(transformMock.mock.calls[0][0].asyncResolveKey).toBe(
      transformMock.mock.calls[1][0].asyncResolveKey
    );
  });

  it('passes static webpack aliases to native resolver options', async () => {
    const { default: webpackLoader } = await import('../index');
    const compiler = {
      ...createCompiler(),
      options: {
        resolve: {
          alias: {
            '@': '/project/src',
            disabled: false,
            existing: '/project/ignored',
          },
        },
      },
    };

    transformMock.mockResolvedValue({
      code: 'module.exports = 1;',
      sourceMap: null,
      cssText: undefined,
      dependencies: [],
    });

    await new Promise<void>((resolve, reject) => {
      webpackLoader.call(
        {
          _compiler: compiler,
          addDependency: jest.fn(),
          async: jest.fn(),
          callback: (err: Error | null) => (err ? reject(err) : resolve()),
          emitWarning: jest.fn(),
          getOptions: () => ({
            oxcOptions: {
              resolver: {
                alias: {
                  existing: ['/custom-existing'],
                },
                conditionNames: ['...'],
              },
            },
          }),
          getResolve: () => jest.fn((_ctx, _token, cb) => cb(null, '/abs/a')),
          resourcePath: '/abs/entry.tsx',
        } as any,
        'module.exports = 1;',
        null
      );
    });

    expect(
      transformMock.mock.calls[0][0].options.pluginOptions.oxcOptions
    ).toEqual({
      resolver: {
        alias: {
          '@': ['/project/src'],
          existing: ['/custom-existing'],
        },
        conditionNames: ['...'],
      },
    });
  });

  it('keeps the stacked root resolver alive until compiler completion', async () => {
    const { default: webpackLoader } = await import('../index');
    const compiler = createCompiler();
    const resolved = path.resolve('assets/deep.css');
    const addDependencyA = jest.fn();
    const addDependencyB = jest.fn();
    const resolveModuleA = jest.fn((_ctx, _token, cb) => cb(null, resolved));
    const resolveModuleB = jest.fn((_ctx, _token, cb) => cb(null, resolved));

    transformMock.mockImplementation(async (services, _code, asyncResolve) => {
      if (services.options.filename === '/abs/entry-a.tsx') {
        return {
          code: _code,
          sourceMap: null,
          cssText: undefined,
          dependencies: [],
        };
      }

      await asyncResolve('./deep.css', '/abs/dependency.ts', [
        '/abs/dependency.ts',
        '/abs/entry-a.tsx',
      ]);

      return {
        code: _code,
        sourceMap: null,
        cssText: undefined,
        dependencies: [],
      };
    });

    await new Promise<void>((resolve, reject) => {
      webpackLoader.call(
        {
          _compiler: compiler,
          addDependency: addDependencyA,
          async: jest.fn(),
          callback: (err: Error | null) => (err ? reject(err) : resolve()),
          emitWarning: jest.fn(),
          getOptions: () => ({}),
          getResolve: () => resolveModuleA,
          resourcePath: '/abs/entry-a.tsx',
        } as any,
        'module.exports = 1;',
        null
      );
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(resolveModuleA).not.toHaveBeenCalled();

    await new Promise<void>((resolve, reject) => {
      webpackLoader.call(
        {
          _compiler: compiler,
          addDependency: addDependencyB,
          async: jest.fn(),
          callback: (err: Error | null) => (err ? reject(err) : resolve()),
          emitWarning: jest.fn(),
          getOptions: () => ({}),
          getResolve: () => resolveModuleB,
          resourcePath: '/abs/entry-b.tsx',
        } as any,
        'module.exports = 1;',
        null
      );
    });

    expect(resolveModuleA).toHaveBeenCalledTimes(1);
    expect(resolveModuleB).not.toHaveBeenCalled();
    expect(addDependencyA).toHaveBeenCalledWith(resolved);
  });

  it('clears compiler-scoped resolvers when compilation finishes', async () => {
    const { default: webpackLoader } = await import('../index');
    const compiler = createCompiler();
    const resolved = path.resolve('assets/deep.css');
    const resolveModuleA = jest.fn((_ctx, _token, cb) => cb(null, resolved));

    transformMock.mockImplementation(async (services, _code, asyncResolve) => {
      if (services.options.filename === '/abs/entry-a.tsx') {
        return {
          code: _code,
          sourceMap: null,
          cssText: undefined,
          dependencies: [],
        };
      }

      await asyncResolve('./deep.css', '/abs/dependency.ts', [
        '/abs/dependency.ts',
        '/abs/entry-a.tsx',
      ]);

      return {
        code: _code,
        sourceMap: null,
        cssText: undefined,
        dependencies: [],
      };
    });

    await new Promise<void>((resolve, reject) => {
      webpackLoader.call(
        {
          _compiler: compiler,
          addDependency: jest.fn(),
          async: jest.fn(),
          callback: (err: Error | null) => (err ? reject(err) : resolve()),
          emitWarning: jest.fn(),
          getOptions: () => ({}),
          getResolve: () => resolveModuleA,
          resourcePath: '/abs/entry-a.tsx',
        } as any,
        'module.exports = 1;',
        null
      );
    });

    compiler.hooks.done.call({});

    await expect(
      new Promise<void>((resolve, reject) => {
        webpackLoader.call(
          {
            _compiler: compiler,
            addDependency: jest.fn(),
            async: jest.fn(),
            callback: (err: Error | null) => (err ? reject(err) : resolve()),
            emitWarning: jest.fn(),
            getOptions: () => ({}),
            getResolve: () => jest.fn((_ctx, _token, cb) => cb(null, resolved)),
            resourcePath: '/abs/entry-b.tsx',
          } as any,
          'module.exports = 1;',
          null
        );
      })
    ).rejects.toThrow('No resolver found');
  });
});
