/* eslint-disable require-yield */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { CacheKeySaltBusyError, TransformCacheCollection } from '../cache';
import {
  registerEvalTelemetryReporter,
  type EvalTelemetryRecord,
} from '../debug/evalTelemetry';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';
import type {
  IWorkflowAction,
  SyncScenarioForAction,
} from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

// eslint-disable-next-line require-yield
const workflow = function* workflow(): SyncScenarioForAction<IWorkflowAction> {
  return {
    code: 'module.exports = 1;',
    sourceMap: null,
  };
};

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
};

describe('transform asyncResolveKey', () => {
  it('reuses a scoped runner while resolver semantic keys stay isolated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-transform-resolver-scope-'));
    const entry = join(root, 'entry.ts');
    const serverTheme = join(root, 'server-theme.ts');
    const clientTheme = join(root, 'client-theme.ts');
    const source = [
      "import { css } from 'test-css-processor';",
      "import { color } from 'theme';",
      'export const className = css`color: ${color};`;',
    ].join('\n');
    writeFileSync(entry, source);
    writeFileSync(serverTheme, "export const color = 'server';");
    writeFileSync(clientTheme, "export const color = 'client';");

    const evalBrokerScope = {};
    const emitter = new EventEmitter(
      () => {},
      () => 0,
      () => {}
    );
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const run = (asyncResolveKey: string, themeFile: string) =>
      transform(
        {
          asyncResolveKey,
          cache: new TransformCacheCollection(),
          evalBrokerScope,
          eventEmitter: emitter,
          options: {
            filename: entry,
            root,
            pluginOptions: {
              configFile: false,
              eval: { strategy: 'execute' },
              tagResolver: (sourceName, tag) =>
                sourceName === 'test-css-processor' && tag === 'css'
                  ? processorFile
                  : null,
            },
          },
        },
        source,
        async (what: string) => {
          if (what === 'test-css-processor') return processorFile;
          if (what === 'theme') return themeFile;
          return null;
        }
      );

    try {
      const [server, client] = await Promise.all([
        run('server-resolver', serverTheme),
        run('client-resolver', clientTheme),
      ]);

      expect(server.cssText).toContain('server');
      expect(client.cssText).toContain('client');
      expect(
        records.filter(
          (record) =>
            record.type === 'eval-lifecycle' &&
            record.event === 'runner-spawn-attempt'
        )
      ).toHaveLength(1);
    } finally {
      unregister();
      disposeEvalBroker(evalBrokerScope);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('keeps eval cache key stable when asyncResolveKey stays the same', async () => {
    const cache = new TransformCacheCollection();
    const cachedEntrypoint = {
      dependencies: new Map<string, { resolved: string | null }>(),
    };
    const asyncResolveA = async () => null;
    const asyncResolveB = async () => null;

    await transform(
      {
        asyncResolveKey: 'webpack:compiler-a',
        cache,
        options: {
          filename: '/abs/entry-a.tsx',
          root: '/abs',
          pluginOptions: {
            configFile: false,
          },
        },
      },
      'export default 1;',
      asyncResolveA,
      { workflow }
    );

    cache.add('entrypoints', '/abs/shared.ts', cachedEntrypoint);

    await transform(
      {
        asyncResolveKey: 'webpack:compiler-a',
        cache,
        options: {
          filename: '/abs/entry-b.tsx',
          root: '/abs',
          pluginOptions: {
            configFile: false,
          },
        },
      },
      'export default 1;',
      asyncResolveB,
      { workflow }
    );

    expect(cache.get('entrypoints', '/abs/shared.ts')).toBe(cachedEntrypoint);
  });

  it('separates eval cache key when asyncResolveKey changes', async () => {
    const cache = new TransformCacheCollection();
    const cachedEntrypoint = {
      dependencies: new Map<string, { resolved: string | null }>(),
    };

    await transform(
      {
        asyncResolveKey: 'webpack:compiler-a',
        cache,
        options: {
          filename: '/abs/entry-a.tsx',
          root: '/abs',
          pluginOptions: {
            configFile: false,
          },
        },
      },
      'export default 1;',
      async () => null,
      { workflow }
    );

    cache.add('entrypoints', '/abs/shared.ts', cachedEntrypoint);

    await transform(
      {
        asyncResolveKey: 'webpack:compiler-b',
        cache,
        options: {
          filename: '/abs/entry-b.tsx',
          root: '/abs',
          pluginOptions: {
            configFile: false,
          },
        },
      },
      'export default 1;',
      async () => null,
      { workflow }
    );

    expect(cache.get('entrypoints', '/abs/shared.ts')).toBeUndefined();
  });

  it('holds one semantic key until the whole transform attempt settles', async () => {
    const cache = new TransformCacheCollection();
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const order: string[] = [];
    const run = (
      asyncResolveKey: string,
      filename: string,
      customWorkflow: Parameters<typeof transform>[3]['workflow']
    ) =>
      transform(
        {
          asyncResolveKey,
          cache,
          options: {
            filename,
            root: '/abs',
            pluginOptions: { configFile: false },
          },
        },
        'export default 1;',
        async () => null,
        { workflow: customWorkflow } as Parameters<typeof transform>[3]
      );
    const firstWorkflow = async function* firstWorkflow() {
      order.push('a:start');
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push('a:end');
      return { code: 'a', sourceMap: null };
    };
    const secondWorkflow = function* secondWorkflow() {
      order.push('b');
      return { code: 'b', sourceMap: null };
    };

    try {
      const first = run('compiler-a', '/abs/a.ts', firstWorkflow as never);
      await firstStarted.promise;
      const second = run('compiler-b', '/abs/b.ts', secondWorkflow as never);

      await Promise.resolve();
      expect(order).toEqual(['a:start']);

      releaseFirst.resolve();
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ code: 'a' }),
        expect.objectContaining({ code: 'b' }),
      ]);
      expect(order).toEqual(['a:start', 'a:end', 'b']);
    } finally {
      releaseFirst.resolve();
      disposeEvalBroker(cache);
    }
  });

  it('fails closed instead of waiting for a conflicting nested key', async () => {
    const cache = new TransformCacheCollection();
    const acquireKeySalt = jest.spyOn(cache, 'acquireKeySalt');
    const nestedRan = jest.fn();
    const nestedWorkflow = function* nestedWorkflow() {
      nestedRan();
      return { code: 'nested', sourceMap: null };
    };
    const outerWorkflow = async function* outerWorkflow() {
      const retainedValue = {
        dependencies: new Map<string, { resolved: string | null }>(),
      };
      cache.add('entrypoints', '/abs/retained.ts', retainedValue);
      const keySaltBeforeNested = cache.getKeySalt();
      await expect(
        transform(
          {
            asyncResolveKey: 'nested-key',
            cache,
            options: {
              filename: '/abs/nested.ts',
              root: '/abs',
              pluginOptions: { configFile: false },
            },
          },
          'export default 2;',
          async () => null,
          { workflow: nestedWorkflow } as Parameters<typeof transform>[3]
        )
      ).rejects.toBeInstanceOf(CacheKeySaltBusyError);
      expect(cache.getKeySalt()).toBe(keySaltBeforeNested);
      expect(cache.get('entrypoints', '/abs/retained.ts')).toBe(retainedValue);
      return { code: 'outer', sourceMap: null };
    };

    try {
      await expect(
        transform(
          {
            asyncResolveKey: 'outer-key',
            cache,
            options: {
              filename: '/abs/outer.ts',
              root: '/abs',
              pluginOptions: { configFile: false },
            },
          },
          'export default 1;',
          async () => null,
          { workflow: outerWorkflow } as Parameters<typeof transform>[3]
        )
      ).resolves.toMatchObject({ code: 'outer' });
      expect(nestedRan).not.toHaveBeenCalled();
      expect(acquireKeySalt).toHaveBeenCalledTimes(1);
    } finally {
      acquireKeySalt.mockRestore();
      disposeEvalBroker(cache);
    }
  });

  it('propagates a conflicting nested key through dependency loading', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-transform-loader-scope-'));
    const entry = join(root, 'entry.ts');
    const dependency = join(root, 'dependency.ts');
    const cache = new TransformCacheCollection();
    const nestedRan = jest.fn();
    const source = [
      "import { css } from 'test-css-processor';",
      "import { color } from './dependency';",
      'export const className = css`color: ${color};`;',
    ].join('\n');
    writeFileSync(entry, source);
    writeFileSync(dependency, "export const color = 'red';");

    try {
      await expect(
        transform(
          {
            asyncResolveKey: 'outer-key',
            cache,
            loadDependencyCode: async (resolved: string) => {
              if (resolved !== dependency) return undefined;

              const nested = await transform(
                {
                  asyncResolveKey: 'nested-key',
                  cache,
                  options: {
                    filename: dependency,
                    root,
                    pluginOptions: { configFile: false },
                  },
                },
                "export const color = 'blue';",
                async () => null,
                {
                  *workflow() {
                    nestedRan();
                    return { code: 'nested', sourceMap: null };
                  },
                } as Parameters<typeof transform>[3]
              );
              return nested.code;
            },
            loadDependencyCodeKey: 'outer-key',
            options: {
              filename: entry,
              root,
              pluginOptions: {
                configFile: false,
                tagResolver: (sourceName, tag) =>
                  sourceName === 'test-css-processor' && tag === 'css'
                    ? processorFile
                    : null,
              },
            },
          },
          source,
          async (what: string) => {
            if (what === 'test-css-processor') return processorFile;
            if (what === './dependency') return dependency;
            return null;
          }
        )
      ).rejects.toBeInstanceOf(CacheKeySaltBusyError);
      expect(nestedRan).not.toHaveBeenCalled();
    } finally {
      disposeEvalBroker(cache);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('lets a nested transform join the same cache and semantic key', async () => {
    const cache = new TransformCacheCollection();
    const acquireKeySalt = jest.spyOn(cache, 'acquireKeySalt');
    const tryAcquireKeySalt = jest.spyOn(cache, 'tryAcquireKeySalt');
    const nestedValue = {
      dependencies: new Map<string, { resolved: string | null }>(),
    };
    const nestedWorkflow = function* nestedWorkflow() {
      cache.add('entrypoints', '/abs/nested-value.ts', nestedValue);
      return { code: 'nested', sourceMap: null };
    };
    const outerWorkflow = async function* outerWorkflow() {
      await transform(
        {
          asyncResolveKey: 'shared-key',
          cache,
          options: {
            filename: '/abs/nested.ts',
            root: '/abs',
            pluginOptions: { configFile: false },
          },
        },
        'export default 2;',
        async () => null,
        { workflow: nestedWorkflow } as Parameters<typeof transform>[3]
      );
      return { code: 'outer', sourceMap: null };
    };

    try {
      await expect(
        transform(
          {
            asyncResolveKey: 'shared-key',
            cache,
            options: {
              filename: '/abs/outer.ts',
              root: '/abs',
              pluginOptions: { configFile: false },
            },
          },
          'export default 1;',
          async () => null,
          { workflow: outerWorkflow } as Parameters<typeof transform>[3]
        )
      ).resolves.toMatchObject({ code: 'outer' });
      expect(cache.get('entrypoints', '/abs/nested-value.ts')).toBe(
        nestedValue
      );
      expect(acquireKeySalt).toHaveBeenCalledTimes(1);
      expect(tryAcquireKeySalt).toHaveBeenCalledTimes(1);
    } finally {
      acquireKeySalt.mockRestore();
      tryAcquireKeySalt.mockRestore();
      disposeEvalBroker(cache);
    }
  });

  it('lets a same-key nested transform finish before a conflicting waiter', async () => {
    const cache = new TransformCacheCollection();
    const outerStarted = createDeferred();
    const startNested = createDeferred();
    const order: string[] = [];
    const nestedWorkflow = function* nestedWorkflow() {
      order.push('nested');
      return { code: 'nested', sourceMap: null };
    };
    const outerWorkflow = async function* outerWorkflow() {
      order.push('outer:start');
      outerStarted.resolve();
      await startNested.promise;
      await transform(
        {
          asyncResolveKey: 'shared-key',
          cache,
          options: {
            filename: '/abs/nested.ts',
            root: '/abs',
            pluginOptions: { configFile: false },
          },
        },
        'export default 2;',
        async () => null,
        { workflow: nestedWorkflow } as Parameters<typeof transform>[3]
      );
      order.push('outer:end');
      return { code: 'outer', sourceMap: null };
    };
    const waiterWorkflow = function* waiterWorkflow() {
      order.push('waiter');
      return { code: 'waiter', sourceMap: null };
    };

    try {
      const outer = transform(
        {
          asyncResolveKey: 'shared-key',
          cache,
          options: {
            filename: '/abs/outer.ts',
            root: '/abs',
            pluginOptions: { configFile: false },
          },
        },
        'export default 1;',
        async () => null,
        { workflow: outerWorkflow } as Parameters<typeof transform>[3]
      );
      await outerStarted.promise;
      const waiter = transform(
        {
          asyncResolveKey: 'conflicting-key',
          cache,
          options: {
            filename: '/abs/waiter.ts',
            root: '/abs',
            pluginOptions: { configFile: false },
          },
        },
        'export default 3;',
        async () => null,
        { workflow: waiterWorkflow } as Parameters<typeof transform>[3]
      );

      await Promise.resolve();
      expect(order).toEqual(['outer:start']);
      startNested.resolve();

      await expect(Promise.all([outer, waiter])).resolves.toEqual([
        expect.objectContaining({ code: 'outer' }),
        expect.objectContaining({ code: 'waiter' }),
      ]);
      expect(order).toEqual(['outer:start', 'nested', 'outer:end', 'waiter']);
    } finally {
      startNested.resolve();
      disposeEvalBroker(cache);
    }
  });

  it('lets a nested transform use an independent available cache', async () => {
    const outerCache = new TransformCacheCollection();
    const nestedCache = new TransformCacheCollection();
    const nestedRan = jest.fn();
    const nestedWorkflow = function* nestedWorkflow() {
      nestedRan();
      return { code: 'nested', sourceMap: null };
    };
    const outerWorkflow = async function* outerWorkflow() {
      await transform(
        {
          asyncResolveKey: 'nested-key',
          cache: nestedCache,
          options: {
            filename: '/abs/nested.ts',
            root: '/abs',
            pluginOptions: { configFile: false },
          },
        },
        'export default 2;',
        async () => null,
        { workflow: nestedWorkflow } as Parameters<typeof transform>[3]
      );
      return { code: 'outer', sourceMap: null };
    };

    try {
      await expect(
        transform(
          {
            asyncResolveKey: 'outer-key',
            cache: outerCache,
            options: {
              filename: '/abs/outer.ts',
              root: '/abs',
              pluginOptions: { configFile: false },
            },
          },
          'export default 1;',
          async () => null,
          { workflow: outerWorkflow } as Parameters<typeof transform>[3]
        )
      ).resolves.toMatchObject({ code: 'outer' });
      expect(nestedRan).toHaveBeenCalledTimes(1);
    } finally {
      disposeEvalBroker(outerCache);
      disposeEvalBroker(nestedCache);
    }
  });

  it('allows an async descendant to reuse the cache after its parent settles', async () => {
    const cache = new TransformCacheCollection();
    const startDescendant = createDeferred();
    let descendant!: ReturnType<typeof transform>;
    const childWorkflow = function* childWorkflow() {
      return { code: 'child', sourceMap: null };
    };
    const parentWorkflow = async function* parentWorkflow() {
      descendant = startDescendant.promise.then(() =>
        transform(
          {
            asyncResolveKey: 'descendant-key',
            cache,
            options: {
              filename: '/abs/descendant.ts',
              root: '/abs',
              pluginOptions: { configFile: false },
            },
          },
          'export default 2;',
          async () => null,
          { workflow: childWorkflow } as Parameters<typeof transform>[3]
        )
      );
      return { code: 'parent', sourceMap: null };
    };

    try {
      await transform(
        {
          asyncResolveKey: 'parent-key',
          cache,
          options: {
            filename: '/abs/parent.ts',
            root: '/abs',
            pluginOptions: { configFile: false },
          },
        },
        'export default 1;',
        async () => null,
        { workflow: parentWorkflow } as Parameters<typeof transform>[3]
      );

      startDescendant.resolve();
      await expect(descendant).resolves.toMatchObject({ code: 'child' });
    } finally {
      startDescendant.resolve();
      await descendant?.catch(() => undefined);
      disposeEvalBroker(cache);
    }
  });
});
