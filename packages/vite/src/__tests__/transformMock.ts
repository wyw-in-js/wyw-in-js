/**
 * Every test file of this package runs in one `bun test` process, and the
 * first `jest.mock('@wyw-in-js/transform', ...)` factory of the process fixes
 * the set of export names the mocked module has; later factories only replace
 * the values of those names. Each file therefore builds its mock here, so that
 * every factory exports the same names and only the values differ.
 *
 * When the plugin starts to use another export of `@wyw-in-js/transform`, add
 * it here rather than to a single test file.
 */
const createDefaults = () => ({
  createFileReporter: () => ({
    emitter: { single: jest.fn() },
    onDone: jest.fn(),
  }),
  createTransformManifest: (metadata: unknown, context: unknown) => ({
    ...(metadata as object),
    ...(context as object),
    version: 1,
  }),
  disposeEvalBroker: jest.fn(),
  getFileIdx: () => '1',
  stringifyTransformManifest: (manifest: unknown) =>
    JSON.stringify(manifest, null, 2),
  TransformCacheCollection: class TransformCacheCollection {},
  transform: jest.fn(),
});

export type TransformMockOverrides = Partial<ReturnType<typeof createDefaults>>;

export const createTransformMock = (overrides: TransformMockOverrides = {}) => {
  const defaults = createDefaults();
  const unknownNames = Object.keys(overrides).filter(
    (name) => !Object.prototype.hasOwnProperty.call(defaults, name)
  );
  if (unknownNames.length > 0) {
    throw new Error(
      `createTransformMock does not export ${unknownNames.join(
        ', '
      )}: add it to the defaults so that every test file mocks the same names`
    );
  }

  return {
    __esModule: true,
    ...defaults,
    ...overrides,
  };
};
