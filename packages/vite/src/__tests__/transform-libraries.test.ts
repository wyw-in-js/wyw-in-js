const transformMock = jest.fn();
const filterMock = jest.fn();

const loadWywInJS = () => import('../index?transform-libraries-test');

const createLogger = () => {
  const log = (() => undefined) as unknown as ((...args: unknown[]) => void) & {
    extend: (...args: unknown[]) => unknown;
  };

  log.extend = () => log;
  return log;
};

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  asyncResolverFactory: jest.fn(() => jest.fn()),
  logger: createLogger(),
  mergeOxcResolverAlias: (oxcOptions: any) => oxcOptions,
  syncResolve: jest.fn(),
  toNativeResolverAlias: jest.fn(() => ({})),
}));

jest.mock('vite', () =>
  require('./viteMock').createViteMock({
    createFilter: (...args: unknown[]) => filterMock(...args),
  })
);

jest.mock('@wyw-in-js/transform', () =>
  require('./transformMock').createTransformMock({
    transform: (...args: unknown[]) => transformMock(...args),
  })
);

describe('vite transformLibraries', () => {
  beforeEach(() => {
    transformMock.mockReset();
    filterMock.mockReset();
    filterMock.mockReturnValue(() => true);

    transformMock.mockResolvedValue({
      code: 'export {}',
      sourceMap: null,
      cssText: undefined,
      dependencies: [],
    });
  });

  it('skips node_modules by default even when filter matches', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const plugin = wywInJS();
    plugin.configResolved?.({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);

    await plugin.transform?.call(
      { resolve: jest.fn(), warn: jest.fn() } as any,
      'export {}',
      '/node_modules/test-lib/index.js'
    );

    expect(transformMock).not.toHaveBeenCalled();
  });

  it('allows transforming node_modules when transformLibraries is true', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const plugin = wywInJS({ transformLibraries: true });
    plugin.configResolved?.({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);

    await plugin.transform?.call(
      { resolve: jest.fn(), warn: jest.fn() } as any,
      'export {}',
      '/node_modules/test-lib/index.js'
    );

    expect(transformMock).toHaveBeenCalledTimes(1);
  });

  it('still respects include/exclude filter', async () => {
    filterMock.mockReturnValue(() => false);

    const { default: wywInJS } = await loadWywInJS();
    const plugin = wywInJS({ transformLibraries: true });
    plugin.configResolved?.({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);

    await plugin.transform?.call(
      { resolve: jest.fn(), warn: jest.fn() } as any,
      'export {}',
      '/node_modules/test-lib/index.js'
    );

    expect(transformMock).not.toHaveBeenCalled();
  });
});
