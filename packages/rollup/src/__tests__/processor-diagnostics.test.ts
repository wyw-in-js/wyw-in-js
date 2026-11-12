import * as actualTransform from '@wyw-in-js/transform';

const transformMock = jest.fn();

// Keep the real exports of the transform package and stub only what the test
// controls.
const realTransform = { ...actualTransform };

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  ...realTransform,
  disposeEvalBroker: jest.fn(),
  getFileIdx: () => 'file',
  TransformCacheCollection: function TransformCacheCollection() {
    return { get: () => undefined };
  },
  transform: (...args: unknown[]) => transformMock(...args),
}));

// A query gives this file its own copy of the plugin, bound to the mocks above.
// eslint-disable-next-line import/no-unresolved
const loadWywInJS = () => import('../index?processor-diagnostics');

const diagnostics = [
  {
    category: 'test-warning',
    className: 'test',
    displayName: 'test',
    end: { line: 2, column: 12 },
    filename: '/abs/src/entry.ts',
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

describe('@wyw-in-js/rollup processor diagnostics', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('forwards processor diagnostics as warnings', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const plugin = wywInJS({ serializeTransform: false });
    transformMock.mockResolvedValue({
      code: 'export const a = "a";',
      cssText: '',
      dependencies: [],
      diagnostics,
      sourceMap: null,
    });
    const ctx = {
      error: jest.fn(),
      meta: { rollupVersion: '4.0.0' },
      resolve: jest.fn(async () => null),
      warn: jest.fn(),
    };

    const result = await plugin.transform!.call(
      ctx as any,
      'code',
      '/abs/src/entry.ts'
    );

    // A diagnostic of any severity is a warning and does not fail the build.
    expect(result).toMatchObject({ code: 'export const a = "a";' });
    expect(ctx.error).not.toHaveBeenCalled();
    expect(
      ctx.warn.mock.calls.map(([warning]) =>
        typeof warning === 'string' ? warning : warning.message
      )
    ).toEqual([
      expect.stringContaining(
        '[wyw-in-js] warning [test-warning] A processor warning\n' +
          '  at /abs/src/entry.ts:2:5 (test)'
      ),
      expect.stringContaining(
        '[wyw-in-js] error [test-error] A processor error\n' +
          '  at /abs/src/dependency.ts (dependency)'
      ),
    ]);
  });
});
