const transformMock = jest.fn();

const loadWywInJS = () => import('../index?resolve-id-query-test');

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  createFileReporter: () => ({
    emitter: { single: jest.fn() },
    onDone: jest.fn(),
  }),
  getFileIdx: () => '1',
  TransformCacheCollection: class TransformCacheCollection {},
  transform: (...args: unknown[]) => transformMock(...args),
}));

const cssFilename = '/project/src/main.wyw-in-js.css';
const cssId = '/src/main.wyw-in-js.css';
const cssText = '.foo{color:red;}';

/** A dev-server plugin that has generated cssText for /project/src/main.js. */
const createPlugin = async () => {
  transformMock.mockResolvedValue({ code: 'export {}', cssText });

  const { default: wywInJS } = await loadWywInJS();
  const plugin = wywInJS();

  plugin.configResolved?.({
    root: '/project',
    command: 'serve',
    createResolver: () => jest.fn().mockResolvedValue(undefined),
  } as any);

  await plugin.transform?.call({} as any, 'export {}', '/project/src/main.js');

  return {
    load: (id: string) => plugin.load?.call({} as any, id),
    resolveId: (id: string) => plugin.resolveId?.call({} as any, id),
  };
};

describe('vite resolveId of a generated CSS id', () => {
  it('keeps the query of the id', async () => {
    const { resolveId } = await createPlugin();

    expect(resolveId(`${cssFilename}?direct`)).toBe(`${cssFilename}?direct`);
  });

  it.each([
    [cssFilename, cssFilename],
    [cssId, cssFilename],
    [`${cssId}?direct`, `${cssFilename}?direct`],
    [`${cssFilename}?direct?direct`, `${cssFilename}?direct?direct`],
    [`${cssId}?direct?direct`, `${cssFilename}?direct?direct`],
  ])('resolves %s to %s', async (id, expected) => {
    const { resolveId } = await createPlugin();

    expect(resolveId(id)).toBe(expected);
  });

  it.each([
    '/project/src/other.css',
    '/project/src/other.css?direct',
    '/src/other.css?direct',
    'react',
  ])('neither resolves nor loads %s', async (id) => {
    const { load, resolveId } = await createPlugin();

    expect(resolveId(id)).toBeUndefined();
    expect(load(id)).toBeUndefined();
  });

  it.each([
    cssFilename,
    cssId,
    `${cssFilename}?direct`,
    `${cssId}?direct`,
    `${cssFilename}?direct?direct`,
    `${cssId}?direct?direct`,
  ])('loads the CSS text for the resolved %s', async (id) => {
    const { load, resolveId } = await createPlugin();

    expect(load(resolveId(id) as string)).toBe(cssText);
  });
});
