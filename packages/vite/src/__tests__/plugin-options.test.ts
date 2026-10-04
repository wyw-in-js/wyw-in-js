const transformMock = jest.fn();

const loadWywInJS = () => import('../index?plugin-options-test');

jest.mock('vite', () => require('./viteMock').createViteMock());

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  createFileReporter: () => ({
    emitter: { single: jest.fn() },
    onDone: jest.fn(),
  }),
  getFileIdx: () => '1',
  TransformCacheCollection: class TransformCacheCollection {},
  transform: (...args: unknown[]) => transformMock(...args),
  disposeEvalBroker: jest.fn(),
}));

describe('vite plugin options', () => {
  beforeEach(() => {
    transformMock.mockReset();
    transformMock.mockResolvedValue({
      code: '',
      sourceMap: null,
      cssText: undefined,
      dependencies: [],
    });
  });

  it('passes one stable options object per environment to transform', async () => {
    const { default: wywInJS } = await loadWywInJS();

    const plugin = wywInJS({ displayName: true });
    plugin.configResolved?.({
      root: '/root',
      mode: 'development',
      command: 'serve',
      base: '/',
      envDir: '/root',
      envPrefix: 'VITE_',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);

    const context = { resolve: jest.fn(), warn: jest.fn() } as any;
    await plugin.transform?.call(context, 'export {}', '/root/a.tsx');
    await plugin.transform?.call(context, 'export {}', '/root/b.tsx');
    await plugin.transform?.call(context, 'export {}', '/root/c.tsx', {
      ssr: true,
    });

    const [client, nextClient, ssr] = transformMock.mock.calls.map(
      ([services]) => services.options.pluginOptions
    );

    expect(nextClient).toBe(client);
    expect(ssr).not.toBe(client);
    expect(client.displayName).toBe(true);
    expect(ssr.displayName).toBe(true);
    expect(client.overrideContext).not.toBe(ssr.overrideContext);
    expect(ssr.oxcOptions).toBe(client.oxcOptions);
  });
});
