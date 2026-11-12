import * as actualTransform from '@wyw-in-js/transform';

const transformMock = jest.fn();

// Keep the real exports of the transform package and stub only what the test
// controls.
const realTransform = { ...actualTransform };

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  ...realTransform,
  disposeEvalBroker: jest.fn(),
  TransformCacheCollection: class TransformCacheCollection {},
  transform: (...args: unknown[]) => transformMock(...args),
}));

const entryPath = '/project/src/entry.tsx';

const diagnostics = [
  {
    category: 'test-warning',
    className: 'test',
    displayName: 'test',
    end: { line: 2, column: 12 },
    filename: entryPath,
    message: 'A processor warning',
    severity: 'warning',
    start: { line: 2, column: 4 },
  },
  {
    category: 'test-error',
    className: 'dependency',
    displayName: 'dependency',
    end: null,
    filename: '/project/src/dependency.ts',
    message: 'A processor error',
    severity: 'error',
    start: null,
  },
];

const getTransformHook = async () => {
  const { default: parcelTransformer } = await import('../index');

  return (parcelTransformer as any)[Symbol.for('parcel-plugin-config')]
    .transform as (args: any) => Promise<unknown[]>;
};

describe('@wyw-in-js/parcel-transformer processor diagnostics', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('forwards processor diagnostics as warnings', async () => {
    const transformHook = await getTransformHook();
    transformMock.mockResolvedValue({
      code: 'export const value = "transformed";',
      cssText: '.a{color:red}',
      dependencies: [],
      diagnostics,
      sourceMap: null,
    });
    const asset = {
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
    };
    const logger = { error: jest.fn(), warn: jest.fn() };

    const assets = await transformHook({
      asset,
      logger,
      options: { projectRoot: '/project' },
      resolve: jest.fn(),
    });

    // A diagnostic of any severity is a warning and does not fail the build.
    expect(asset.setCode).toHaveBeenCalledWith(
      'export const value = "transformed";'
    );
    expect(assets).toEqual([
      asset,
      expect.objectContaining({ content: '.a{color:red}\n', type: 'css' }),
    ]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls.map(([warning]) => warning.message)).toEqual([
      expect.stringContaining(
        '[wyw-in-js] warning [test-warning] A processor warning\n' +
          `  at ${entryPath}:2:5 (test)`
      ),
      expect.stringContaining(
        '[wyw-in-js] error [test-error] A processor error\n' +
          '  at /project/src/dependency.ts (dependency)'
      ),
    ]);
  });
});
