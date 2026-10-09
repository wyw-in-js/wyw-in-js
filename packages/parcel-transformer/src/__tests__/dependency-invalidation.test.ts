import path from 'path';

const transformMock = jest.fn();
const asyncResolveFallbackMock = jest.fn();

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  asyncResolveFallback: (...args: unknown[]) =>
    asyncResolveFallbackMock(...args),
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  disposeEvalBroker: jest.fn(),
  TransformCacheCollection: class TransformCacheCollection {},
  transform: (...args: unknown[]) => transformMock(...args),
}));

const projectRoot = path.resolve('/project');
const entryPath = path.join(projectRoot, 'src', 'entry.tsx');

const createAsset = () => ({
  addDependency: jest.fn(),
  env: { id: 'browser-env' },
  filePath: entryPath,
  getCode: jest.fn(async () => 'export const value = 1;'),
  getMap: jest.fn(async () => null),
  id: 'entry',
  invalidateOnFileChange: jest.fn(),
  isSource: true,
  setCode: jest.fn(),
  setMap: jest.fn(),
});

const getTransformHook = async () => {
  const { default: parcelTransformer } = await import('../index');

  return (parcelTransformer as any)[Symbol.for('parcel-plugin-config')]
    .transform as (args: any) => Promise<unknown[]>;
};

const runTransform = async (
  result: Record<string, unknown>,
  resolve: jest.Mock
) => {
  const transformHook = await getTransformHook();
  transformMock.mockImplementation(async (_services, code) => ({
    code,
    cssText: '.a{color:red}',
    sourceMap: null,
    ...result,
  }));

  const asset = createAsset();
  const logger = { warn: jest.fn() };
  await transformHook({
    asset,
    logger,
    options: { projectRoot },
    resolve,
  });

  return {
    invalidatedPaths: asset.invalidateOnFileChange.mock.calls.map(
      ([filePath]) => filePath as string
    ),
    warnings: logger.warn.mock.calls.map(
      ([diagnostic]) => diagnostic as { message: string; origin: string }
    ),
  };
};

describe('@wyw-in-js/parcel-transformer dependency invalidation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    asyncResolveFallbackMock.mockReset();
    transformMock.mockReset();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('invalidates on the resolved file paths of transform dependencies', async () => {
    const themePath = path.join(projectRoot, 'src', 'theme.ts');
    const tokensPath = path.join(
      projectRoot,
      'node_modules',
      'tokens',
      'index.js'
    );
    const resolve = jest.fn(async () => {
      throw new Error('resolved dependencies must not be resolved again');
    });

    const { invalidatedPaths, warnings } = await runTransform(
      {
        dependencies: ['./theme', 'tokens'],
        dependencyResolutions: [
          { resolved: themePath, source: './theme' },
          { resolved: tokensPath, source: 'tokens' },
        ],
      },
      resolve
    );

    expect(invalidatedPaths).toEqual([themePath, tokensPath]);
    expect(resolve).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it('keeps dependencies that are already file paths', async () => {
    // Statically evaluated values report resolved files, while evaluated
    // ones report import specifiers; one result can mix both.
    const palettePath = path.join(projectRoot, 'src', 'palette.ts');
    const themePath = path.join(projectRoot, 'src', 'theme.ts');
    const resolve = jest.fn(async () => {
      throw new Error('file paths must not be resolved as specifiers');
    });

    const { invalidatedPaths, warnings } = await runTransform(
      {
        dependencies: [palettePath, './theme'],
        dependencyResolutions: [{ resolved: themePath, source: './theme' }],
      },
      resolve
    );

    expect(invalidatedPaths).toEqual([palettePath, themePath]);
    expect(resolve).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it('resolves dependencies without a recorded resolution through Parcel', async () => {
    const themePath = path.join(projectRoot, 'src', 'theme.ts');
    const runtimePath = path.join(projectRoot, 'src', 'runtime-helper.ts');
    const resolve = jest.fn(async (from: string, to: string) => {
      if (from === entryPath && to === './runtime-helper') {
        return runtimePath;
      }

      throw new Error(`Unexpected resolution of ${to} from ${from}`);
    });

    const { invalidatedPaths, warnings } = await runTransform(
      {
        dependencies: ['./theme', './runtime-helper'],
        dependencyResolutions: [{ resolved: themePath, source: './theme' }],
      },
      resolve
    );

    expect(invalidatedPaths).toEqual([themePath, runtimePath]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(asyncResolveFallbackMock).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it('skips dependencies that cannot be resolved to a file path with a warning', async () => {
    const themePath = path.join(projectRoot, 'src', 'theme.ts');
    const resolve = jest.fn(async () => {
      throw new Error('Parcel cannot resolve it');
    });
    asyncResolveFallbackMock.mockImplementation(async () => {
      throw new Error('Node cannot resolve it');
    });

    const { invalidatedPaths, warnings } = await runTransform(
      {
        dependencies: ['./theme', './missing'],
        dependencyResolutions: [{ resolved: themePath, source: './theme' }],
      },
      resolve
    );

    expect(invalidatedPaths).toEqual([themePath]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].origin).toBe('@wyw-in-js/parcel-transformer');
    expect(warnings[0].message).toContain('./missing');
    expect(warnings[0].message).toContain(entryPath);
  });

  it('never passes a non-absolute path to invalidateOnFileChange', async () => {
    const resolve = jest.fn(async () => 'tokens');
    asyncResolveFallbackMock.mockImplementation(async () => 'tokens');

    const { invalidatedPaths, warnings } = await runTransform(
      {
        dependencies: ['tokens'],
        dependencyResolutions: [{ resolved: 'tokens', source: 'tokens' }],
      },
      resolve
    );

    expect(invalidatedPaths).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('tokens');
  });
});
