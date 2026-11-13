import { EventEmitter } from 'events';
import path from 'path';

const transformMock = jest.fn();

const createReloadTarget = () => ({
  moduleGraph: { getModuleById: jest.fn() },
  reloadModule: jest.fn(),
});

const loadWywInJS = () => import('../index?hmr-test');

jest.mock('vite', () =>
  require('./viteMock').createViteMock({
    optimizeDeps: jest.fn(),
  })
);

jest.mock('@wyw-in-js/transform', () =>
  require('./transformMock').createTransformMock({
    transform: (...args: unknown[]) => transformMock(...args),
  })
);

describe('vite HMR', () => {
  beforeEach(() => {
    transformMock.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('defers reloadModule for generated CSS until after transform()', async () => {
    const { default: wywInJS } = await loadWywInJS();
    transformMock.mockResolvedValue({
      code: 'export const x = 1;',
      sourceMap: null,
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
    });

    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.tsx');
    const expectedCssFilename = path
      .normalize(`${entryId.replace(/\.[jt]sx?$/, '')}.wyw-in-js.css`)
      .replace(/\\/g, path.posix.sep);

    const environment = createReloadTarget();
    environment.moduleGraph.getModuleById.mockImplementation((id: string) => ({
      id,
    }));

    const plugin = wywInJS();
    plugin.configResolved?.({
      root,
      mode: 'development',
      command: 'serve',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);
    plugin.configureServer?.({
      moduleGraph: { getModuleById: jest.fn() },
    } as any);

    await plugin.transform?.call(
      { resolve: jest.fn(), environment } as any,
      'console.log("test")',
      entryId
    );

    expect(environment.reloadModule).not.toHaveBeenCalled();

    jest.runOnlyPendingTimers();

    expect(environment.moduleGraph.getModuleById).toHaveBeenCalledWith(
      expectedCssFilename
    );
    expect(environment.reloadModule).toHaveBeenCalledTimes(1);
  });

  it('does not reload CSS when generated CSS is unchanged', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.tsx');

    const environment = createReloadTarget();
    environment.moduleGraph.getModuleById.mockImplementation((id: string) => ({
      id,
    }));

    const plugin = wywInJS();
    plugin.configResolved?.({
      root,
      mode: 'development',
      command: 'serve',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);
    plugin.configureServer?.({
      moduleGraph: { getModuleById: jest.fn() },
    } as any);

    transformMock.mockResolvedValue({
      code: 'export const x = 1;',
      sourceMap: null,
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn(), environment } as any,
      'console.log("test")',
      entryId
    );
    jest.runOnlyPendingTimers();
    expect(environment.reloadModule).toHaveBeenCalledTimes(1);

    environment.reloadModule.mockClear();
    environment.moduleGraph.getModuleById.mockClear();

    transformMock.mockResolvedValue({
      code: 'export const x = 2;',
      sourceMap: null,
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn(), environment } as any,
      'console.log("test2")',
      entryId
    );
    jest.runOnlyPendingTimers();

    expect(environment.reloadModule).not.toHaveBeenCalled();
  });

  it('falls back to devServer moduleGraph when transform context has no environment', async () => {
    const { default: wywInJS } = await loadWywInJS();
    transformMock.mockResolvedValue({
      code: 'export const x = 1;',
      sourceMap: null,
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
    });

    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.tsx');
    const expectedCssFilename = path
      .normalize(`${entryId.replace(/\.[jt]sx?$/, '')}.wyw-in-js.css`)
      .replace(/\\/g, path.posix.sep);

    const getModuleById = jest
      .fn()
      .mockImplementation((id: string) => ({ id }));
    const reloadModule = jest.fn();

    const plugin = wywInJS();
    plugin.configResolved?.({
      root,
      mode: 'development',
      command: 'serve',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);
    plugin.configureServer?.({
      moduleGraph: { getModuleById },
      reloadModule,
    } as any);

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );

    expect(reloadModule).not.toHaveBeenCalled();

    jest.runOnlyPendingTimers();

    expect(getModuleById).toHaveBeenCalledWith(expectedCssFilename);
    expect(reloadModule).toHaveBeenCalledTimes(1);
  });
  it('emits metadata sidecars during build when transform() returns metadata', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.tsx');
    const emitFile = jest.fn();

    transformMock.mockResolvedValue({
      code: 'export const x = 1;',
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
      metadata: {
        dependencies: [],
        processors: [
          {
            artifacts: [['meta', { className: 'entry_a' }]],
            className: 'entry_a',
            displayName: 'entry',
            start: { column: 0, line: 1 },
          },
        ],
        replacements: [],
        rules: {
          '.entry_a': {
            className: 'entry_a',
            cssText: 'color:red;',
            displayName: 'entry',
            start: { column: 0, line: 1 },
          },
        },
      },
      sourceMap: null,
    });

    const plugin = wywInJS({ outputMetadata: true });
    plugin.configResolved?.({
      root,
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: { cssCodeSplit: true, rollupOptions: {} },
    } as any);

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );

    plugin.generateBundle?.call({ emitFile } as any, {} as any, {} as any);

    expect(emitFile).toHaveBeenCalledWith({
      fileName: 'src/entry.wyw-in-js.json',
      source: expect.stringContaining('"source": "src/entry.tsx"'),
      type: 'asset',
    });
    expect(emitFile).toHaveBeenCalledWith({
      fileName: 'src/entry.wyw-in-js.json',
      source: expect.stringContaining('"cssFile": "src/entry.wyw-in-js.css"'),
      type: 'asset',
    });
  });

  it('reports structured diagnostics returned by transform()', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.tsx');
    const warn = jest.fn();

    transformMock.mockResolvedValue({
      code: 'export const x = 1;',
      cssText: '',
      cssSourceMapText: null,
      dependencies: [],
      diagnostics: [
        {
          category: 'dx-style/raw-color',
          className: 'entry_a',
          displayName: 'entry',
          filename: entryId,
          message: 'Use a design token instead of a raw color.',
          severity: 'warning',
          start: { column: 4, line: 2 },
        },
      ],
      sourceMap: null,
    });

    const plugin = wywInJS();
    plugin.configResolved?.({
      root,
      mode: 'development',
      command: 'serve',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);

    await plugin.transform?.call(
      { resolve: jest.fn(), warn } as any,
      'console.log("test")',
      entryId
    );

    expect(warn).toHaveBeenCalledWith({
      id: entryId,
      loc: {
        column: 4,
        file: entryId,
        line: 2,
      },
      message:
        '[wyw-in-js] warning [dx-style/raw-color] Use a design token instead of a raw color.',
      pluginCode: 'dx-style/raw-color',
    });
  });

  it('clears stale metadata sidecars when a file stops producing metadata', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.tsx');
    const emitFile = jest.fn();

    const plugin = wywInJS({ outputMetadata: true });
    plugin.configResolved?.({
      root,
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: { cssCodeSplit: true, rollupOptions: {} },
    } as any);

    transformMock.mockResolvedValueOnce({
      code: 'export const x = 1;',
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
      metadata: {
        dependencies: [],
        processors: [],
        replacements: [],
        rules: {},
      },
      sourceMap: null,
    });

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );

    transformMock.mockResolvedValueOnce({
      code: 'export const x = 2;',
      cssText: undefined,
      cssSourceMapText: null,
      dependencies: [],
      sourceMap: null,
    });

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );

    plugin.generateBundle?.call({ emitFile } as any, {} as any, {} as any);

    expect(emitFile).not.toHaveBeenCalled();
  });

  it('clears stale metadata sidecars between rebuilds when a file disappears from the graph', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.tsx');
    const emitFile = jest.fn();

    const plugin = wywInJS({ outputMetadata: true });
    plugin.configResolved?.({
      root,
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: { cssCodeSplit: true, rollupOptions: {} },
    } as any);

    plugin.buildStart?.call({} as any);

    transformMock.mockResolvedValueOnce({
      code: 'export const x = 1;',
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
      metadata: {
        dependencies: [],
        processors: [],
        replacements: [],
        rules: {},
      },
      sourceMap: null,
    });

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );

    plugin.generateBundle?.call({ emitFile } as any, {} as any, {} as any);

    expect(emitFile).toHaveBeenCalledTimes(1);

    emitFile.mockClear();

    plugin.buildStart?.call({} as any);
    plugin.generateBundle?.call({ emitFile } as any, {} as any, {} as any);

    expect(emitFile).not.toHaveBeenCalled();
  });

  it('uses safe metadata asset paths for sources outside Vite root', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const root = path.join(path.sep, 'repo', 'app');
    const entryId = path.join(
      path.sep,
      'repo',
      'packages',
      'ui',
      'src',
      'entry.tsx'
    );
    const emitFile = jest.fn();

    transformMock.mockResolvedValue({
      code: 'export const x = 1;',
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
      metadata: {
        dependencies: [],
        processors: [],
        replacements: [],
        rules: {},
      },
      sourceMap: null,
    });

    const plugin = wywInJS({ outputMetadata: true });
    plugin.configResolved?.({
      root,
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: { cssCodeSplit: true, rollupOptions: {} },
    } as any);

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );

    plugin.generateBundle?.call({ emitFile } as any, {} as any, {} as any);

    expect(emitFile).toHaveBeenCalledWith({
      fileName:
        '_wyw-in-js/external/__up__/packages/ui/src/entry.wyw-in-js.json',
      source: expect.stringContaining(
        '"source": "../packages/ui/src/entry.tsx"'
      ),
      type: 'asset',
    });
    expect(emitFile).toHaveBeenCalledWith({
      fileName:
        '_wyw-in-js/external/__up__/packages/ui/src/entry.wyw-in-js.json',
      source: expect.stringContaining(
        '"cssFile": "../packages/ui/src/entry.wyw-in-js.css"'
      ),
      type: 'asset',
    });
  });

  it('normalizes metadata filenames for supported module extensions', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.mts');
    const emitFile = jest.fn();

    transformMock.mockResolvedValue({
      code: 'export const x = 1;',
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
      metadata: {
        dependencies: [],
        processors: [],
        replacements: [],
        rules: {},
      },
      sourceMap: null,
    });

    const plugin = wywInJS({ outputMetadata: true });
    plugin.configResolved?.({
      root,
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: { cssCodeSplit: true, rollupOptions: {} },
    } as any);

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );

    plugin.generateBundle?.call({ emitFile } as any, {} as any, {} as any);

    expect(emitFile).toHaveBeenCalledWith({
      fileName: 'src/entry.wyw-in-js.json',
      source: expect.stringContaining('"source": "src/entry.mts"'),
      type: 'asset',
    });
    expect(emitFile).toHaveBeenCalledWith({
      fileName: 'src/entry.wyw-in-js.json',
      source: expect.stringContaining('"cssFile": "src/entry.wyw-in-js.css"'),
      type: 'asset',
    });
  });

  it('disposes eval brokers when the dev server closes', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const { disposeEvalBroker } = await import('@wyw-in-js/transform');
    const disposeEvalBrokerMock = disposeEvalBroker as jest.Mock;
    const httpServer = new EventEmitter();

    disposeEvalBrokerMock.mockReset();

    const plugin = wywInJS();
    plugin.configResolved?.({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);

    const configureResult = plugin.configureServer?.({
      moduleGraph: { getModuleById: jest.fn() },
      middlewares: { use: jest.fn() },
      httpServer,
    } as any);

    expect(configureResult).toBeUndefined();

    httpServer.emit('close');

    expect(disposeEvalBrokerMock).toHaveBeenCalledTimes(2);
  });
});
