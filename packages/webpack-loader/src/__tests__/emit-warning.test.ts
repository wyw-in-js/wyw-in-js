const transformMock = jest.fn();

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  logger: jest.fn(),
  mergeOxcResolverAlias: (oxcOptions: any) => oxcOptions,
  toNativeResolverAlias: jest.fn(() => ({})),
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  createParallelTransforms: () => null,
  createFileReporter: () => ({
    emitter: { single: jest.fn() },
    onDone: jest.fn(),
  }),
  TransformCacheCollection: function TransformCacheCollection() {},
  transform: (...args: unknown[]) => transformMock(...args),
  disposeEvalBroker: jest.fn(),
}));

describe('webpack-loader emitWarning', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('emits Error without stack to prevent webpack ModuleWarning duplication', async () => {
    const { default: webpackLoader } = await import('../index');
    const emitWarning = jest.fn();

    transformMock.mockImplementation(
      async (services: { emitWarning: (msg: string) => void }) => {
        services.emitWarning('[wyw-eval-runner] defsFromColors: 5.312ms');
        return {
          code: 'module.exports = 1;',
          sourceMap: null,
          cssText: null,
          cssSourceMapText: '',
          dependencies: [],
        };
      }
    );

    await new Promise<void>((resolve, reject) => {
      webpackLoader.call(
        {
          hot: false,
          addDependency: jest.fn(),
          async: jest.fn(),
          callback: (err: Error | null) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          },
          context: process.cwd(),
          emitWarning,
          getDependencies: () => [],
          getOptions: () => ({}),
          getResolve: () =>
            jest.fn(
              (
                _ctx: string,
                _token: string,
                cb: (err: unknown, res: unknown) => void
              ) => cb(null, null)
            ),
          resourcePath: '/abs/test.tsx',
          rootContext: process.cwd(),
          utils: {
            contextify: (_ctx: string, request: string) => request,
          },
        } as never,
        'module.exports = 1;',
        null
      );
    });

    expect(emitWarning).toHaveBeenCalledTimes(1);
    const warning = emitWarning.mock.calls[0][0];

    expect(warning).toBeInstanceOf(Error);
    expect(warning.message).toBe('[wyw-eval-runner] defsFromColors: 5.312ms');
    // stack is deleted so ModuleWarning.details stays undefined —
    // webpack won't render the message a second time as "Error: <msg>"
    expect(warning.stack).toBeUndefined();
  });

  it('drops stale loader callbacks and routes cached services to the current compilation', async () => {
    const { default: webpackLoader } = await import('../index');
    const createHook = () => {
      const handlers: Array<() => void> = [];
      return {
        call: () => handlers.forEach((handler) => handler()),
        tap: (_name: string, handler: () => void) => handlers.push(handler),
      };
    };
    const compiler = {
      hooks: {
        done: createHook(),
        failed: createHook(),
        shutdown: createHook(),
        watchClose: createHook(),
      },
    };
    const cachedEmitWarnings: Array<(message: string) => void> = [];

    transformMock.mockImplementation(
      async (services: { emitWarning: (message: string) => void }) => {
        cachedEmitWarnings.push(services.emitWarning);
        return {
          code: 'module.exports = 1;',
          sourceMap: null,
          cssText: null,
          cssSourceMapText: '',
          dependencies: [],
        };
      }
    );

    const runLoader = (emitWarning: jest.Mock) =>
      new Promise<void>((resolve, reject) => {
        webpackLoader.call(
          {
            _compiler: compiler,
            hot: false,
            addDependency: jest.fn(),
            async: jest.fn(),
            callback: (err: Error | null) => (err ? reject(err) : resolve()),
            context: process.cwd(),
            emitWarning,
            getDependencies: () => [],
            getOptions: () => ({}),
            getResolve: () =>
              jest.fn(
                (
                  _ctx: string,
                  _token: string,
                  cb: (err: unknown, res: unknown) => void
                ) => cb(null, null)
              ),
            resourcePath: '/abs/test.tsx',
            rootContext: process.cwd(),
            utils: {
              contextify: (_ctx: string, request: string) => request,
            },
          } as never,
          'module.exports = 1;',
          null
        );
      });

    const firstEmitWarning = jest.fn();
    await runLoader(firstEmitWarning);
    compiler.hooks.done.call();

    cachedEmitWarnings[0]('stale');
    expect(firstEmitWarning).not.toHaveBeenCalled();

    const secondEmitWarning = jest.fn();
    await runLoader(secondEmitWarning);
    cachedEmitWarnings[0]('current');

    expect(firstEmitWarning).not.toHaveBeenCalled();
    expect(secondEmitWarning).toHaveBeenCalledTimes(1);
    expect(secondEmitWarning.mock.calls[0][0].message).toBe('current');
  });
});
