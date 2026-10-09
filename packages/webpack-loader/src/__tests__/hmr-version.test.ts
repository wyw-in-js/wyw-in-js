import * as actualShared from '@wyw-in-js/shared';

const transformMock = jest.fn();

// Keep the real pure helpers (request parsing, source map normalisation, CSS
// protocol constants) and stub only what the test controls.
const realShared = { ...actualShared };

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  ...realShared,
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

describe('webpack-loader CSS request identity', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('changes requests with CSS content in both hot and cold builds', async () => {
    const { default: webpackLoader } = await import('../index');
    const resourcePath = '/abs/entry.jsx';

    const run = async (
      cssText: string,
      hot: boolean,
      cssSourceMapText = '',
      sourceMap = false
    ) => {
      transformMock.mockResolvedValueOnce({
        code: 'module.exports = 1;',
        sourceMap: null,
        cssText,
        cssSourceMapText,
        dependencies: [],
      });

      let emittedRequest = '';

      await new Promise<void>((resolve, reject) => {
        webpackLoader.call(
          {
            hot,
            addDependency: jest.fn(),
            async: jest.fn(),
            callback: (err: Error | null, code?: string) => {
              if (err) {
                reject(err);
                return;
              }

              const match = String(code).match(/require\(([^)]+)\);/);
              if (!match) {
                reject(new Error('Expected loader to emit a require() call'));
                return;
              }

              emittedRequest = JSON.parse(match[1].trim());
              resolve();
            },
            context: process.cwd(),
            emitWarning: jest.fn(),
            getDependencies: () => [],
            getOptions: () => ({ sourceMap }),
            getResolve: () =>
              jest.fn(
                (
                  _ctx: string,
                  _token: string,
                  cb: (err: any, res: any) => void
                ) => cb(null, null)
              ),
            resourcePath,
            rootContext: process.cwd(),
            utils: {
              contextify: (_ctx: string, request: string) => request,
            },
          } as any,
          'module.exports = 1;',
          null
        );
      });

      return emittedRequest;
    };

    const hotReq1 = await run('.title{color:red}', true);
    const hotReq2 = await run('.title{color:blue}', true);
    const coldReq1 = await run('.title{color:red}', false);
    const coldReq2 = await run('.title{color:blue}', false);

    expect(hotReq1).toContain('outputCssPayload=');
    expect(hotReq1).not.toMatch(/[?&]v=/);
    expect(hotReq1).not.toEqual(hotReq2);
    expect(coldReq1).not.toEqual(coldReq2);
    expect(coldReq1).toEqual(hotReq1);
    expect(coldReq2).toEqual(hotReq2);
    const first = JSON.stringify({
      version: 3,
      sources: ['entry.jsx'],
      sourcesContent: ['first'],
      names: [],
      mappings: 'AAAA',
    });
    const second = first.replace('first', 'second');
    const hotMap1 = await run('.title{color:red}', true, first, true);
    const hotMap2 = await run('.title{color:red}', true, second, true);
    const coldMap1 = await run('.title{color:red}', false, first, true);
    const coldMap2 = await run('.title{color:red}', false, second, true);
    expect(hotMap1).not.toEqual(hotMap2);
    expect(coldMap1).toEqual(hotMap1);
    expect(coldMap2).toEqual(hotMap2);
    expect(await run('.title{color:red}', true, first, false)).toEqual(hotReq1);
    expect(await run('.title{color:red}', false, second, false)).toEqual(
      coldReq1
    );
  });
});
