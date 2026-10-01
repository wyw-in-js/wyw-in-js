const transformMock = jest.fn();
const disposeEvalBrokerMock = jest.fn();

interface MockCache {
  retained: Set<string>;
}

const cacheInstances: MockCache[] = [];

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  asyncResolveFallback: jest.fn(),
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  disposeEvalBroker: (...args: unknown[]) => disposeEvalBrokerMock(...args),
  TransformCacheCollection: class TransformCacheCollection {
    readonly retained = new Set<string>();

    constructor() {
      cacheInstances.push(this);
    }
  },
  transform: (...args: unknown[]) => transformMock(...args),
}));

interface TransformServices {
  asyncResolveKey?: string;
  cache: MockCache;
  evalBrokerScope: object;
}

const createAsset = (id: string) => ({
  addDependency: jest.fn(),
  env: { id: 'browser-env' },
  filePath: `/project/${id}.tsx`,
  getCode: jest.fn(async () => `export const value = '${id}';`),
  getMap: jest.fn(async () => null),
  id,
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

describe('@wyw-in-js/parcel-transformer resolver scope', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    cacheInstances.length = 0;
    disposeEvalBrokerMock.mockReset();
    transformMock.mockReset();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('isolates concurrent asset caches without discarding either lifecycle', async () => {
    const transformHook = await getTransformHook();
    let notifyBothEntered: () => void = () => {};
    const bothEntered = new Promise<void>((resolve) => {
      notifyBothEntered = resolve;
    });
    let activeTransforms = 0;
    let maxActiveTransforms = 0;
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond: () => void = () => {};
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    transformMock.mockImplementation(async (services, code) => {
      const { cache } = services as TransformServices;
      cache.retained.add(code as string);
      activeTransforms += 1;
      maxActiveTransforms = Math.max(maxActiveTransforms, activeTransforms);
      if (activeTransforms === 2) {
        notifyBothEntered();
      }

      await ((code as string).includes('first') ? firstGate : secondGate);
      activeTransforms -= 1;

      return {
        code,
        cssText: '',
        dependencies: [],
        sourceMap: null,
      };
    });

    const options = {
      instanceId: 'parcel-run-a',
      projectRoot: '/project',
    };
    const logger = { warn: jest.fn() };
    const firstTransform = transformHook({
      asset: createAsset('first'),
      logger,
      options,
      resolve: jest.fn(async () => '/project/dependency.ts'),
    });
    const secondTransform = transformHook({
      asset: createAsset('second'),
      logger,
      options,
      resolve: jest.fn(async () => '/project/dependency.ts'),
    });

    await bothEntered;

    const firstServices = transformMock.mock.calls[0][0] as TransformServices;
    const secondServices = transformMock.mock.calls[1][0] as TransformServices;
    const firstResolver = transformMock.mock.calls[0][2];
    const secondResolver = transformMock.mock.calls[1][2];
    expect(maxActiveTransforms).toBe(2);
    expect(cacheInstances).toHaveLength(2);
    expect(firstServices.cache).not.toBe(secondServices.cache);
    expect(firstServices.evalBrokerScope).toBe(secondServices.evalBrokerScope);
    expect(firstServices.asyncResolveKey).toBeUndefined();
    expect(secondServices.asyncResolveKey).toBeUndefined();
    expect(firstResolver).not.toBe(secondResolver);
    expect(firstServices.cache.retained).toEqual(
      new Set(["export const value = 'first';"])
    );
    expect(secondServices.cache.retained).toEqual(
      new Set(["export const value = 'second';"])
    );

    releaseFirst();
    await firstTransform;
    expect(disposeEvalBrokerMock).not.toHaveBeenCalled();

    releaseSecond();
    await secondTransform;
    expect(disposeEvalBrokerMock).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1_000);
    expect(disposeEvalBrokerMock).toHaveBeenCalledTimes(1);
    expect(disposeEvalBrokerMock).toHaveBeenCalledWith(
      firstServices.evalBrokerScope
    );
  });

  it('reuses the broker scope across sequential transforms before idle disposal', async () => {
    const transformHook = await getTransformHook();
    transformMock.mockImplementation(async (_services, code) => ({
      code,
      cssText: '',
      dependencies: [],
      sourceMap: null,
    }));
    const options = {
      instanceId: 'parcel-run-a',
      projectRoot: '/project',
    };
    const logger = { warn: jest.fn() };

    await transformHook({
      asset: createAsset('first'),
      logger,
      options,
      resolve: jest.fn(async () => '/project/dependency.ts'),
    });
    const firstServices = transformMock.mock.calls[0][0] as TransformServices;
    expect(disposeEvalBrokerMock).not.toHaveBeenCalled();

    await transformHook({
      asset: createAsset('second'),
      logger,
      options,
      resolve: jest.fn(async () => '/project/dependency.ts'),
    });
    const secondServices = transformMock.mock.calls[1][0] as TransformServices;
    expect(secondServices.evalBrokerScope).toBe(firstServices.evalBrokerScope);
    expect(disposeEvalBrokerMock).not.toHaveBeenCalled();

    jest.advanceTimersByTime(999);
    expect(disposeEvalBrokerMock).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(disposeEvalBrokerMock).toHaveBeenCalledTimes(1);
  });

  it('disposes the shared broker when a transform fails', async () => {
    const transformHook = await getTransformHook();
    const failure = new Error('transform failed');
    transformMock.mockRejectedValueOnce(failure);

    await expect(
      transformHook({
        asset: createAsset('failure'),
        logger: { warn: jest.fn() },
        options: {
          instanceId: 'parcel-run-a',
          projectRoot: '/project',
        },
        resolve: jest.fn(async () => '/project/dependency.ts'),
      })
    ).rejects.toBe(failure);

    expect(disposeEvalBrokerMock).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1_000);
    expect(disposeEvalBrokerMock).toHaveBeenCalledTimes(1);
  });
});
