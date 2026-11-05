import fs from 'fs';
import os from 'os';
import path from 'path';

import { createParallelTransforms } from '@wyw-in-js/transform';

const transformMock = jest.fn();

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  createParallelTransforms,
  createFileReporter: () => ({
    emitter: { single: jest.fn() },
    onDone: jest.fn(),
  }),
  slugify: () => 'slug',
  TransformCacheCollection: class TransformCacheCollection {},
  transform: (...args: unknown[]) => transformMock(...args),
  disposeEvalBroker: jest.fn(),
}));

const createBuilder = () => {
  const handlers: Array<{ callback: any; options: any }> = [];

  const builder = {
    onEnd: jest.fn(),
    onResolve: jest.fn(),
    onLoad: jest.fn((options: any, callback: any) => {
      handlers.push({ callback, options });
    }),
  } as any;

  return { builder, handlers };
};

const getMainOnLoad = (handlers: Array<{ callback: any; options: any }>) => {
  const call = handlers.find(({ options }) => !('namespace' in options));
  if (!call) {
    throw new Error('Expected main onLoad registration.');
  }
  return call.callback;
};

describe('bun transformLibraries', () => {
  beforeEach(() => {
    transformMock.mockReset();
    transformMock.mockResolvedValue({
      code: 'export {}',
      cssText: '',
      cssSourceMapText: '',
      sourceMap: null,
    });
  });

  it('skips node_modules by default', async () => {
    const { default: wywInJS } = await import('../index');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-bun-124-'));
    const file = path.join(root, 'node_modules', 'test-lib', 'index.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export const x = 1;', 'utf8');

    const { builder, handlers } = createBuilder();
    wywInJS().setup(builder);

    const onLoad = getMainOnLoad(handlers);
    const result = await onLoad({ path: file });

    expect(result).toBeUndefined();
    expect(transformMock).not.toHaveBeenCalled();
  });

  it('allows transforming node_modules when transformLibraries is true', async () => {
    const { default: wywInJS } = await import('../index');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-bun-124-'));
    const file = path.join(root, 'node_modules', 'test-lib', 'index.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export const x = 1;', 'utf8');

    const { builder, handlers } = createBuilder();
    wywInJS({ transformLibraries: true }).setup(builder);

    const onLoad = getMainOnLoad(handlers);
    const result = await onLoad({ path: file });

    expect(transformMock).toHaveBeenCalledTimes(1);
    expect(result).not.toBeUndefined();
  });
});
