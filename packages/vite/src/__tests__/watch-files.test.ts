import path from 'path';

const transformMock = jest.fn();

const loadWywInJS = () => import('../index?watch-files-test');

jest.mock('vite', () => require('./viteMock').createViteMock());

jest.mock('@wyw-in-js/transform', () =>
  require('./transformMock').createTransformMock({
    TransformCacheCollection: class TransformCacheCollection {
      invalidateForFile = jest.fn();
    },
    transform: (...args: unknown[]) => transformMock(...args),
  })
);

const root = process.cwd();
const entryId = path.join(root, 'src', 'entry.tsx');
const themeFile = path.join(root, 'src', 'theme.ts');
const paletteFile = path.join(root, 'src', 'palette.ts');
const runtimeFile = path.join(root, 'src', 'runtime.ts');

const transformResult = {
  code: 'export const x = 1;',
  cssText: '.a{color:red;}',
  dependencies: [
    './theme',
    'tokens',
    './runtime',
    './virtual',
    paletteFile,
    path.join(root, 'node_modules', 'lib', 'index.js'),
  ],
  dependencyResolutions: [
    { source: './theme', resolved: themeFile },
    {
      source: 'tokens',
      resolved: path.join(root, 'node_modules', 'tokens', 'index.js'),
    },
  ],
  sourceMap: null,
};

const resolveIds: Record<string, string> = {
  './theme': themeFile,
  './runtime': `${runtimeFile}?v=1`,
  './virtual': '\0virtual',
  tokens: path.join(root, 'node_modules', 'tokens', 'index.js'),
};

const createContext = () => ({
  addWatchFile: jest.fn(),
  resolve: jest.fn(async (what: string) =>
    resolveIds[what] ? { id: resolveIds[what] } : null
  ),
  warn: jest.fn(),
});

const createPlugin = async (command: 'build' | 'serve') => {
  const { default: wywInJS } = await loadWywInJS();
  const plugin = wywInJS();
  plugin.configResolved?.({
    root,
    mode: command === 'build' ? 'production' : 'development',
    command,
    base: '/',
    build: { watch: command === 'build' ? {} : null },
    createResolver: () => jest.fn().mockResolvedValue(undefined),
  } as any);

  return plugin;
};

describe('vite watch files', () => {
  beforeEach(() => {
    transformMock.mockReset();
    transformMock.mockResolvedValue(transformResult);
  });

  it('registers evaluated dependencies outside node_modules in build', async () => {
    const plugin = await createPlugin('build');
    const ctx = createContext();

    await plugin.transform?.call(ctx as any, 'code', entryId);

    expect(ctx.addWatchFile.mock.calls).toEqual([
      [themeFile],
      [runtimeFile],
      [paletteFile],
    ]);
  });

  it('registers dependencies of a transform without CSS in build', async () => {
    transformMock.mockResolvedValue({ ...transformResult, cssText: '' });
    const plugin = await createPlugin('build');
    const ctx = createContext();

    await plugin.transform?.call(ctx as any, 'code', entryId);

    expect(ctx.addWatchFile.mock.calls).toEqual([
      [themeFile],
      [runtimeFile],
      [paletteFile],
    ]);
  });

  it('leaves the module graph to HMR in serve', async () => {
    const plugin = await createPlugin('serve');
    const entryModule = { file: entryId, id: entryId };
    plugin.configureServer?.({
      moduleGraph: {
        getModuleById: (id: string) => (id === entryId ? entryModule : null),
      },
    } as any);
    const ctx = createContext();

    await plugin.transform?.call(ctx as any, 'code', entryId);

    expect(ctx.addWatchFile).not.toHaveBeenCalled();
    expect(
      (plugin.handleHotUpdate as any)({ file: themeFile, modules: [] })
    ).toEqual([entryModule]);
  });
});
