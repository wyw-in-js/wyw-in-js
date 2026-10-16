const disposeEvalBrokerMock = jest.fn();

const loadWywInJS = () => import('../index?build-watch-dispose-test');

jest.mock('vite', () => require('./viteMock').createViteMock());

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  createFileReporter: () => ({
    emitter: { single: jest.fn() },
    onDone: jest.fn(),
  }),
  disposeEvalBroker: (...args: unknown[]) => disposeEvalBrokerMock(...args),
  getFileIdx: () => '1',
  TransformCacheCollection: class TransformCacheCollection {},
  transform: jest.fn(),
}));

describe('vite build --watch eval runner', () => {
  it('is disposed after every build, not only the first one', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const plugin = wywInJS();
    plugin.configResolved?.({
      root: process.cwd(),
      mode: 'production',
      command: 'build',
      base: '/',
      build: { watch: {} },
      createResolver: () => jest.fn(),
    } as any);
    const ctx = {} as any;

    (plugin.buildStart as any).call(ctx, {});
    await (plugin.buildEnd as any).call(ctx);
    const disposedAfterFirstBuild = disposeEvalBrokerMock.mock.calls.length;

    (plugin.buildStart as any).call(ctx, {});
    await (plugin.buildEnd as any).call(ctx);

    expect(disposedAfterFirstBuild).toBeGreaterThan(0);
    expect(disposeEvalBrokerMock).toHaveBeenCalledTimes(
      disposedAfterFirstBuild * 2
    );
  });
});

describe('vite dev server eval runners', () => {
  it('are disposed when a middleware-mode server closes', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const plugin = wywInJS();
    plugin.configResolved?.({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
      build: {},
      createResolver: () => jest.fn(),
      logger: { warn: jest.fn() },
    } as any);
    // Middleware mode: Vite passes no httpServer, so no 'close' event fires.
    (plugin.configureServer as any)({
      httpServer: null,
      middlewares: { use: jest.fn() },
    });
    disposeEvalBrokerMock.mockClear();

    // ViteDevServer#close runs buildEnd through the plugin container.
    await (plugin.buildEnd as any).call({});

    expect(disposeEvalBrokerMock).toHaveBeenCalled();
  });
});
