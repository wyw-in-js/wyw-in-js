import * as actualTransform from '@wyw-in-js/transform';

const transformMock = jest.fn();

// Keep the real exports of the transform package and stub only what the test
// controls.
const realTransform = { ...actualTransform };

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  ...realTransform,
  TransformCacheCollection: class TransformCacheCollection {},
  transform: (...args: unknown[]) => transformMock(...args),
}));

const resourcePath = '/abs/src/entry.tsx';

const diagnostics = [
  {
    category: 'test-warning',
    className: 'test',
    displayName: 'test',
    end: { line: 2, column: 12 },
    filename: resourcePath,
    message: 'A processor warning',
    severity: 'warning',
    start: { line: 2, column: 4 },
  },
  {
    category: 'test-error',
    className: 'dependency',
    displayName: 'dependency',
    end: null,
    filename: '/abs/src/dependency.ts',
    message: 'A processor error',
    severity: 'error',
    start: null,
  },
];

describe('turbopack-loader processor diagnostics', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('forwards processor diagnostics as warnings', async () => {
    const { default: turbopackLoader } = await import('../index');
    transformMock.mockResolvedValue({
      code: 'export const x = "transformed";',
      cssText: '',
      dependencies: [],
      diagnostics,
      sourceMap: null,
    });
    const emitError = jest.fn();
    const emitWarning = jest.fn();

    const code = await new Promise<string | undefined>((resolve, reject) => {
      turbopackLoader.call(
        {
          addDependency: jest.fn(),
          async: jest.fn(),
          callback: (err: Error | null, result?: string) =>
            err ? reject(err) : resolve(result),
          emitError,
          emitWarning,
          getOptions: () => ({}),
          getResolve: () => async () => false,
          resourcePath,
        } as any,
        'export const x = 1;',
        null
      );
    });

    // A diagnostic of any severity is a warning and does not fail the build.
    expect(code).toBe('export const x = "transformed";');
    expect(emitError).not.toHaveBeenCalled();
    expect(emitWarning.mock.calls.map(([warning]) => warning.message)).toEqual([
      expect.stringContaining(
        '[wyw-in-js] warning [test-warning] A processor warning\n' +
          `  at ${resourcePath}:2:5 (test)`
      ),
      expect.stringContaining(
        '[wyw-in-js] error [test-error] A processor error\n' +
          '  at /abs/src/dependency.ts (dependency)'
      ),
    ]);
  });
});
