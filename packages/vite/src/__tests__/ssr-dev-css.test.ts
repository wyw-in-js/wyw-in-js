const transformMock = jest.fn();

const loadWywInJS = () => import('../index?ssr-dev-css-test');

jest.mock('vite', () => require('./viteMock').createViteMock());

jest.mock('@wyw-in-js/transform', () =>
  require('./transformMock').createTransformMock({
    transform: (...args: unknown[]) => transformMock(...args),
  })
);

describe('vite SSR dev CSS', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('injects a stylesheet link when ssrDevCss is enabled (serve)', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const plugin = wywInJS({ ssrDevCss: true });

    plugin.configResolved?.({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);

    const result = plugin.transformIndexHtml?.('<html></html>') as any;

    expect(result).toMatchObject({
      tags: [
        {
          tag: 'link',
          attrs: { rel: 'stylesheet' },
        },
      ],
    });
    expect(result.tags[0].attrs.href).toContain('/_wyw-in-js/ssr.css');
  });

  it('does not inject in build mode', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const plugin = wywInJS({ ssrDevCss: true });

    plugin.configResolved?.({
      root: process.cwd(),
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);

    expect(plugin.transformIndexHtml?.('<html></html>')).toBeUndefined();
  });

  it('serves aggregated CSS via middleware', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const plugin = wywInJS({ ssrDevCss: true });

    plugin.configResolved?.({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);

    let middleware: ((req: any, res: any, next: () => void) => void) | null =
      null;
    plugin.configureServer?.({
      middlewares: {
        use: (fn: any) => {
          middleware = fn;
        },
      },
    } as any);

    transformMock
      .mockResolvedValueOnce({
        code: 'export const x = 1;',
        sourceMap: null,
        cssText: '.b{color:red;}',
        cssSourceMapText: null,
        dependencies: [],
      })
      .mockResolvedValueOnce({
        code: 'export const y = 2;',
        sourceMap: null,
        cssText: '.a{color:blue;}',
        cssSourceMapText: null,
        dependencies: [],
      });

    const resolve = jest.fn();
    await plugin.transform?.call(
      { resolve, warn: jest.fn() } as any,
      'console.log("b")',
      '/root/src/b.tsx'
    );
    await plugin.transform?.call(
      { resolve, warn: jest.fn() } as any,
      'console.log("a")',
      '/root/src/a.tsx'
    );

    expect(middleware).toBeTruthy();

    const res: any = {
      statusCode: 0,
      headers: {},
      setHeader: (name: string, value: string) => {
        res.headers[name.toLowerCase()] = value;
      },
      end: (body = '') => {
        res.body = body;
      },
    };

    middleware!({ url: '/_wyw-in-js/ssr.css?v=1', headers: {} }, res, () => {
      throw new Error('next() should not be called for matching path');
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(res.body).toContain('.a{color:blue;}');
    expect(res.body).toContain('.b{color:red;}');
    expect(res.body.indexOf('.a{color:blue;}')).toBeLessThan(
      res.body.indexOf('.b{color:red;}')
    );
  });
});
