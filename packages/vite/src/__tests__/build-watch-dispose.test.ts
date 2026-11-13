const disposeEvalBrokerMock = jest.fn();

const loadWywInJS = () => import('../index?build-watch-dispose-test');

jest.mock('vite', () => require('./viteMock').createViteMock());

jest.mock('@wyw-in-js/transform', () =>
  require('./transformMock').createTransformMock({
    disposeEvalBroker: (...args: unknown[]) => disposeEvalBrokerMock(...args),
  })
);

describe('vite build --watch eval runner', () => {
  it('is disposed after every build, not only the first one', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const plugin = wywInJS();
    plugin.configResolved?.({
      root: process.cwd(),
      mode: 'production',
      command: 'build',
      base: '/',
      build: { watch: {} },
      createResolver: () => jest.fn(),
    } as any);
    const ctx = {} as any;

    (plugin.buildStart as any).call(ctx, {});
    await (plugin.buildEnd as any).call(ctx);
    const disposedAfterFirstBuild = disposeEvalBrokerMock.mock.calls.length;

    (plugin.buildStart as any).call(ctx, {});
    await (plugin.buildEnd as any).call(ctx);

    expect(disposedAfterFirstBuild).toBeGreaterThan(0);
    expect(disposeEvalBrokerMock).toHaveBeenCalledTimes(
      disposedAfterFirstBuild * 2
    );
  });
});
