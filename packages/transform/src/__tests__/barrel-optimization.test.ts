import fs from 'fs';
import os from 'os';
import path from 'path';

import { TransformCacheCollection } from '../cache';
import { Entrypoint } from '../transform/Entrypoint';
import {
  asyncActionRunner,
  syncActionRunner,
} from '../transform/actions/actionRunner';
import { isCacheEpochAbortedError } from '../transform/actions/CacheEpochAbortedError';
import { baseProcessingHandlers } from '../transform/generators/baseProcessingHandlers';
import {
  processEntrypoint,
  processEntrypointAsync,
} from '../transform/generators/processEntrypoint';
import {
  asyncResolveImports,
  syncResolveImports,
} from '../transform/generators/resolveImports';
import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import { withDefaultServices } from '../transform/helpers/withDefaultServices';
import type {
  IGetExportsAction,
  IResolveImportsAction,
  Services,
} from '../transform/types';
import { EventEmitter, type EntrypointEvent } from '../utils/EventEmitter';

const extensions = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
];

const resolveWithExtensions = (candidate: string): string | null => {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  for (const ext of extensions) {
    const withExt = `${candidate}${ext}`;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }

  return null;
};

const createResolver =
  (root: string) =>
  (what: string, importer: string): string => {
    if (path.isAbsolute(what)) {
      const resolved = resolveWithExtensions(what);
      if (resolved) {
        return resolved;
      }
    }

    if (what.startsWith('.')) {
      const resolved = resolveWithExtensions(
        path.resolve(path.dirname(importer), what)
      );
      if (resolved) {
        return resolved;
      }
    }

    throw new Error(
      `Unexpected resolve ${JSON.stringify(what)} from ${importer} in ${root}`
    );
  };

const createRecorder = () => {
  const singles: Record<string, unknown>[] = [];
  const entrypointEvents: Array<{
    event: EntrypointEvent;
    idx: number;
  }> = [];

  const eventEmitter = new EventEmitter(
    (labels, type) => {
      if (type === 'single') {
        singles.push(labels);
      }
    },
    () => 0,
    (idx, _timestamp, event) => {
      entrypointEvents.push({ idx, event });
    }
  );

  return {
    entrypointEvents,
    eventEmitter,
    singles,
  };
};

const createServices = (
  root: string,
  filename: string,
  cache: TransformCacheCollection,
  eventEmitter: EventEmitter
) =>
  withDefaultServices({
    cache,
    eventEmitter,
    options: {
      filename,
      root,
      pluginOptions: loadWywOptions({
        babelOptions: {
          babelrc: false,
          configFile: false,
          presets: ['@babel/preset-typescript'],
        },
        configFile: false,
      }),
    },
  });

const runEntrypoint = (
  root: string,
  filename: string,
  cache: TransformCacheCollection,
  eventEmitter: EventEmitter,
  resolve = createResolver(root),
  onGetExports?: (services: Services) => void
) => {
  for (let attempt = 0; ; attempt += 1) {
    const services = createServices(root, filename, cache, eventEmitter);
    try {
      const entrypoint = Entrypoint.createRoot(
        services,
        filename,
        ['*'],
        undefined
      );
      if (entrypoint.ignored) {
        throw new Error(`Unexpected ignored entrypoint ${filename}`);
      }

      const handlers = {
        ...baseProcessingHandlers,
        getExports(this: IGetExportsAction) {
          onGetExports?.(this.services);
          return baseProcessingHandlers.getExports.call(this);
        },
        processEntrypoint,
        resolveImports(this: IResolveImportsAction) {
          return syncResolveImports.call(this, resolve);
        },
      };

      syncActionRunner(
        entrypoint.createAction('processEntrypoint', undefined, null),
        handlers
      );

      return entrypoint;
    } catch (error) {
      if (!isCacheEpochAbortedError(error) || attempt === 3) {
        throw error;
      }
    }
  }
};

const runEntrypointAsync = async (
  root: string,
  filename: string,
  cache: TransformCacheCollection,
  eventEmitter: EventEmitter,
  resolve: (what: string, importer: string) => Promise<string | null>
) => {
  const services = createServices(root, filename, cache, eventEmitter);
  const entrypoint = Entrypoint.createRoot(
    services,
    filename,
    ['*'],
    undefined
  );
  if (entrypoint.ignored) {
    throw new Error(`Unexpected ignored entrypoint ${filename}`);
  }

  const handlers = {
    ...baseProcessingHandlers,
    processEntrypoint: processEntrypointAsync,
    resolveImports(this: IResolveImportsAction) {
      return asyncResolveImports.call(this, resolve);
    },
  };

  await asyncActionRunner(
    entrypoint.createAction('processEntrypoint', undefined, null),
    handlers
  );

  return entrypoint;
};

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
};

const getDependencyEventsForFile = (
  recorder: ReturnType<typeof createRecorder>,
  filename: string
) =>
  recorder.singles.filter(
    (event) => event.type === 'dependency' && event.file === filename
  );

const getBarrelRewriteEventsForSource = (
  recorder: ReturnType<typeof createRecorder>,
  source: string
) =>
  recorder.singles.filter(
    (event) => event.kind === 'barrelRewrite' && event.source === source
  );

describe('barrel optimization', () => {
  it('rewrites pure barrel imports to leaf modules and reuses the manifest cache', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-barrel-opt-'));

    try {
      const barrelFile = path.join(root, 'barrel.ts');
      const redFile = path.join(root, 'red.ts');
      const blueFile = path.join(root, 'blue.ts');
      const consumerA = path.join(root, 'consumer-a.ts');
      const consumerB = path.join(root, 'consumer-b.ts');

      fs.writeFileSync(
        barrelFile,
        `export { red } from './red';\nexport { blue } from './blue';\n`
      );
      fs.writeFileSync(redFile, `export const red = 'red';\n`);
      fs.writeFileSync(blueFile, `export const blue = 'blue';\n`);
      fs.writeFileSync(
        consumerA,
        `import { red } from './barrel';\nexport const value = red;\n`
      );
      fs.writeFileSync(
        consumerB,
        `import { blue } from './barrel';\nexport const value = blue;\n`
      );

      const cache = new TransformCacheCollection();
      const recorder = createRecorder();

      const first = runEntrypoint(
        root,
        consumerA,
        cache,
        recorder.eventEmitter
      );
      const second = runEntrypoint(
        root,
        consumerB,
        cache,
        recorder.eventEmitter
      );

      expect(first.transformedCode).toContain(redFile);
      expect(first.transformedCode).not.toContain(barrelFile);
      expect(second.transformedCode).toContain(blueFile);
      expect(second.transformedCode).not.toContain(barrelFile);
      expect(first.getDependency('./barrel')).toBeUndefined();
      expect(first.getInvalidationDependency('./barrel')).toMatchObject({
        resolved: barrelFile,
      });
      expect(first.invalidateOnDependencyChange.has(barrelFile)).toBe(true);
      expect(second.getDependency('./barrel')).toBeUndefined();
      expect(second.getInvalidationDependency('./barrel')).toMatchObject({
        resolved: barrelFile,
      });
      expect(second.invalidateOnDependencyChange.has(barrelFile)).toBe(true);

      expect(
        recorder.singles
          .filter(
            (event) =>
              event.kind === 'barrelManifest' && event.file === barrelFile
          )
          .map((event) => event.status)
      ).toEqual(['built', 'hit']);

      const barrelEntrypointIds = recorder.entrypointEvents
        .filter(
          ({ event }) =>
            event.type === 'created' && event.filename === barrelFile
        )
        .map(({ idx }) => idx);

      expect(
        recorder.entrypointEvents.filter(
          ({ event, idx }) =>
            event.type === 'superseded' && barrelEntrypointIds.includes(idx)
        )
      ).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites import-export passthrough modules to the leaf modules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-barrel-imports-'));

    try {
      const barrelFile = path.join(root, 'barrel.ts');
      const redFile = path.join(root, 'red.ts');
      const consumerFile = path.join(root, 'consumer.ts');

      fs.writeFileSync(
        barrelFile,
        `import { red } from './red';\nexport { red };\n`
      );
      fs.writeFileSync(redFile, `export const red = 'red';\n`);
      fs.writeFileSync(
        consumerFile,
        `import { red } from './barrel';\nexport const value = red;\n`
      );

      const entrypoint = runEntrypoint(
        root,
        consumerFile,
        new TransformCacheCollection(),
        createRecorder().eventEmitter
      );

      expect(entrypoint.transformedCode).toContain(redFile);
      expect(entrypoint.transformedCode).not.toContain(barrelFile);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites export-star barrel chains to the final leaf modules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-barrel-star-'));

    try {
      const baseFile = path.join(root, 'base.ts');
      const midFile = path.join(root, 'mid.ts');
      const consumerFile = path.join(root, 'consumer.ts');

      fs.writeFileSync(
        baseFile,
        `export default 42;\nexport const alpha = 'alpha';\n`
      );
      fs.writeFileSync(
        midFile,
        `export * from './base';\nexport { default as thing } from './base';\n`
      );
      fs.writeFileSync(
        consumerFile,
        `export * from './mid';\nexport { thing } from './mid';\n`
      );

      const cache = new TransformCacheCollection();
      const recorder = createRecorder();
      const getExportsServices: Services[] = [];
      const entrypoint = runEntrypoint(
        root,
        consumerFile,
        cache,
        recorder.eventEmitter,
        createResolver(root),
        (services) => getExportsServices.push(services)
      );

      expect(entrypoint.transformedCode).toContain(baseFile);
      expect(entrypoint.transformedCode).not.toContain(midFile);
      expect(getExportsServices.length).toBeGreaterThan(0);
      expect(
        getExportsServices.every(
          (services) =>
            services.cache !== cache &&
            services.eventEmitter === EventEmitter.dummy
        )
      ).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the original barrel path for impure barrels', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-barrel-impure-'));

    try {
      const barrelFile = path.join(root, 'barrel.ts');
      const redFile = path.join(root, 'red.ts');
      const consumerFile = path.join(root, 'consumer.ts');
      const cache = new TransformCacheCollection();
      const recorder = createRecorder();

      fs.writeFileSync(
        barrelFile,
        `console.log('side effect');\nexport { red } from './red';\n`
      );
      fs.writeFileSync(redFile, `export const red = 'red';\n`);
      fs.writeFileSync(
        consumerFile,
        `import { red } from './barrel';\nexport const value = red;\n`
      );

      const entrypoint = runEntrypoint(
        root,
        consumerFile,
        cache,
        recorder.eventEmitter
      );

      expect(entrypoint.transformedCode).toContain(`require("./barrel")`);
      expect(entrypoint.transformedCode).not.toContain(`require("${redFile}")`);
      expect(
        recorder.entrypointEvents.filter(
          ({ event }) =>
            event.type === 'created' && event.filename === barrelFile
        )
      ).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites passthrough imports from mixed barrels and keeps local exports on the original path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-barrel-mixed-'));

    try {
      const barrelFile = path.join(root, 'barrel.ts');
      const redFile = path.join(root, 'red.ts');
      const consumerFile = path.join(root, 'consumer.ts');
      const recorder = createRecorder();

      fs.writeFileSync(
        barrelFile,
        `import { red } from './red';\nexport { red };\nexport const local = 'local';\n`
      );
      fs.writeFileSync(redFile, `export const red = 'red';\n`);
      fs.writeFileSync(
        consumerFile,
        `import { red, local } from './barrel';\nexport const value = [red, local];\n`
      );

      const entrypoint = runEntrypoint(
        root,
        consumerFile,
        new TransformCacheCollection(),
        recorder.eventEmitter
      );

      expect(entrypoint.transformedCode).toContain(redFile);
      expect(entrypoint.transformedCode).toContain(`require("./barrel")`);
      expect(entrypoint.getDependency('./barrel')).toMatchObject({
        resolved: barrelFile,
      });
      expect(entrypoint.getInvalidationDependency('./barrel')).toBeUndefined();
      expect(
        getDependencyEventsForFile(recorder, consumerFile).map(
          (event) => event.phase
        )
      ).toEqual(['initial', 'rewritten']);
      expect(
        getDependencyEventsForFile(recorder, consumerFile).at(-1)?.imports
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: barrelFile,
          }),
          expect.objectContaining({
            from: redFile,
          }),
        ])
      );
      expect(
        getBarrelRewriteEventsForSource(recorder, './barrel').map(
          (event) => event.mode
        )
      ).toEqual(['partial']);
      expect(
        recorder.singles.find(
          (event) =>
            event.kind === 'barrelManifest' &&
            event.file === barrelFile &&
            event.status === 'built'
        )
      ).toMatchObject({
        complete: false,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats passthrough-only imports from mixed barrels as fully rewritten', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wyw-barrel-mixed-fully-')
    );

    try {
      const barrelFile = path.join(root, 'barrel.ts');
      const redFile = path.join(root, 'red.ts');
      const consumerFile = path.join(root, 'consumer.ts');
      const recorder = createRecorder();

      fs.writeFileSync(
        barrelFile,
        `import { red } from './red';\nexport { red };\nexport const local = 'local';\n`
      );
      fs.writeFileSync(redFile, `export const red = 'red';\n`);
      fs.writeFileSync(
        consumerFile,
        `import { red } from './barrel';\nexport const value = red;\n`
      );

      const entrypoint = runEntrypoint(
        root,
        consumerFile,
        new TransformCacheCollection(),
        recorder.eventEmitter
      );

      expect(entrypoint.transformedCode).toContain(redFile);
      expect(entrypoint.transformedCode).not.toContain(`require("./barrel")`);
      expect(entrypoint.getDependency('./barrel')).toBeUndefined();
      expect(entrypoint.getInvalidationDependency('./barrel')).toMatchObject({
        resolved: barrelFile,
      });
      expect(
        getDependencyEventsForFile(recorder, consumerFile).map(
          (event) => event.phase
        )
      ).toEqual(['initial', 'rewritten']);
      expect(
        getDependencyEventsForFile(recorder, consumerFile).at(-1)?.imports
      ).toEqual([
        expect.objectContaining({
          from: redFile,
        }),
      ]);
      expect(
        getBarrelRewriteEventsForSource(recorder, './barrel').map(
          (event) => event.mode
        )
      ).toEqual(['full']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not re-resolve generated leaf imports after mixed-barrel rewrite', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wyw-barrel-mixed-preresolved-')
    );

    try {
      const barrelFile = path.join(root, 'barrel.ts');
      const redFile = path.join(root, 'red.ts');
      const consumerFile = path.join(root, 'consumer.ts');
      const baseResolver = createResolver(root);
      const resolveCalls: Array<{ importer: string; what: string }> = [];

      fs.writeFileSync(
        barrelFile,
        `import { red } from './red';\nexport { red };\nexport const local = 'local';\n`
      );
      fs.writeFileSync(redFile, `export const red = 'red';\n`);
      fs.writeFileSync(
        consumerFile,
        `import { red } from './barrel';\nexport const value = red;\n`
      );

      runEntrypoint(
        root,
        consumerFile,
        new TransformCacheCollection(),
        createRecorder().eventEmitter,
        (what, importer) => {
          resolveCalls.push({ importer, what });
          return baseResolver(what, importer);
        }
      );

      expect(
        resolveCalls.filter(
          (call) => call.importer === consumerFile && call.what === redFile
        )
      ).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the original barrel path for side-effect-only imports', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-barrel-sidefx-'));

    try {
      const barrelFile = path.join(root, 'barrel.ts');
      const redFile = path.join(root, 'red.ts');
      const setupFile = path.join(root, 'setup.ts');
      const consumerFile = path.join(root, 'consumer.ts');
      const recorder = createRecorder();

      fs.writeFileSync(
        barrelFile,
        `import './setup';\nexport { red } from './red';\n`
      );
      fs.writeFileSync(redFile, `export const red = 'red';\n`);
      fs.writeFileSync(setupFile, `globalThis.__wywSetupRan = true;\n`);
      fs.writeFileSync(
        consumerFile,
        `import { red } from './barrel';\nexport const value = red;\n`
      );

      const entrypoint = runEntrypoint(
        root,
        consumerFile,
        new TransformCacheCollection(),
        recorder.eventEmitter
      );

      expect(entrypoint.transformedCode).toContain(`require("./barrel")`);
      expect(entrypoint.transformedCode).not.toContain(`require("${redFile}")`);
      expect(
        recorder.entrypointEvents.filter(
          ({ event }) =>
            event.type === 'created' && event.filename === barrelFile
        )
      ).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps export-star on the original path when exports use string-literal names', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-barrel-star-lit-'));

    try {
      const barrelFile = path.join(root, 'barrel.ts');
      const leafFile = path.join(root, 'leaf.ts');
      const consumerFile = path.join(root, 'consumer.ts');
      const recorder = createRecorder();

      fs.writeFileSync(
        leafFile,
        `const foo = 'foo';\nexport { foo as "foo-bar" };\n`
      );
      fs.writeFileSync(barrelFile, `export * from './leaf';\n`);
      fs.writeFileSync(consumerFile, `export * from './barrel';\n`);

      const entrypoint = runEntrypoint(
        root,
        consumerFile,
        new TransformCacheCollection(),
        recorder.eventEmitter
      );

      expect(entrypoint.transformedCode).toContain(`require("./barrel")`);
      expect(entrypoint.transformedCode).not.toContain(leafFile);
      expect(
        recorder.entrypointEvents.filter(
          ({ event }) =>
            event.type === 'created' && event.filename === barrelFile
        )
      ).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps export-star on the original path for mixed barrels with local exports', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wyw-barrel-mixed-star-')
    );

    try {
      const barrelFile = path.join(root, 'barrel.ts');
      const redFile = path.join(root, 'red.ts');
      const consumerFile = path.join(root, 'consumer.ts');

      fs.writeFileSync(
        barrelFile,
        `import { red } from './red';\nexport { red };\nexport const local = 'local';\n`
      );
      fs.writeFileSync(redFile, `export const red = 'red';\n`);
      fs.writeFileSync(consumerFile, `export * from './barrel';\n`);

      const entrypoint = runEntrypoint(
        root,
        consumerFile,
        new TransformCacheCollection(),
        createRecorder().eventEmitter
      );

      expect(entrypoint.transformedCode).toContain(`require("./barrel")`);
      expect(entrypoint.transformedCode).not.toContain(redFile);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates cached barrel manifests when a leaf behind export-star changes', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wyw-barrel-leaf-cache-')
    );

    try {
      const leafFile = path.join(root, 'leaf.ts');
      const barrelFile = path.join(root, 'barrel.ts');
      const consumerFile = path.join(root, 'consumer.ts');
      const cache = new TransformCacheCollection();

      fs.writeFileSync(leafFile, `export const foo = 'foo';\n`);
      fs.writeFileSync(barrelFile, `export * from './leaf';\n`);
      fs.writeFileSync(consumerFile, `export * from './barrel';\n`);

      const first = runEntrypoint(
        root,
        consumerFile,
        cache,
        createRecorder().eventEmitter
      );

      expect(first.transformedCode).toContain(
        `Object.defineProperty(exports, "foo"`
      );

      fs.writeFileSync(leafFile, `export const bar = 'bar';\n`);

      const second = runEntrypoint(
        root,
        consumerFile,
        cache,
        createRecorder().eventEmitter
      );

      expect(second.transformedCode).toContain(
        `Object.defineProperty(exports, "bar"`
      );
      expect(second.transformedCode).not.toContain(
        `Object.defineProperty(exports, "foo"`
      );
      expect(second.transformedCode).not.toContain(barrelFile);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates cached direct-export analysis when an impure export-star source changes', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wyw-exports-cache-leaf-')
    );

    try {
      const leafFile = path.join(root, 'leaf.ts');
      const impureFile = path.join(root, 'impure.ts');
      const barrelFile = path.join(root, 'barrel.ts');
      const consumerFile = path.join(root, 'consumer.ts');
      const cache = new TransformCacheCollection();

      fs.writeFileSync(leafFile, `export const foo = 'foo';\n`);
      fs.writeFileSync(
        impureFile,
        `console.log('side effect');\nexport * from './leaf';\n`
      );
      fs.writeFileSync(barrelFile, `export * from './impure';\n`);
      fs.writeFileSync(consumerFile, `export * from './barrel';\n`);

      const first = runEntrypoint(
        root,
        consumerFile,
        cache,
        createRecorder().eventEmitter
      );

      expect(first.transformedCode).toContain(
        `Object.defineProperty(exports, "foo"`
      );
      expect(first.transformedCode).toContain(impureFile);

      fs.writeFileSync(leafFile, `export const bar = 'bar';\n`);

      const second = runEntrypoint(
        root,
        consumerFile,
        cache,
        createRecorder().eventEmitter
      );

      expect(second.transformedCode).toContain(
        `Object.defineProperty(exports, "bar"`
      );
      expect(second.transformedCode).not.toContain(
        `Object.defineProperty(exports, "foo"`
      );
      expect(second.transformedCode).toContain(impureFile);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates cached output when a rewritten barrel changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-barrel-cache-'));

    try {
      const barrelFile = path.join(root, 'barrel.ts');
      const fooAFile = path.join(root, 'foo-a.ts');
      const fooBFile = path.join(root, 'foo-b.ts');
      const consumerFile = path.join(root, 'consumer.ts');
      const cache = new TransformCacheCollection();

      fs.writeFileSync(barrelFile, `export { foo } from './foo-a';\n`);
      fs.writeFileSync(fooAFile, `export const foo = 'a';\n`);
      fs.writeFileSync(fooBFile, `export const foo = 'b';\n`);
      fs.writeFileSync(
        consumerFile,
        `import { foo } from './barrel';\nexport const value = foo;\n`
      );

      const first = runEntrypoint(
        root,
        consumerFile,
        cache,
        createRecorder().eventEmitter
      );
      expect(first.transformedCode).toContain(fooAFile);
      expect(first.transformedCode).not.toContain(fooBFile);

      fs.writeFileSync(barrelFile, `export { foo } from './foo-b';\n`);

      const second = runEntrypoint(
        root,
        consumerFile,
        cache,
        createRecorder().eventEmitter
      );
      expect(second.transformedCode).toContain(fooBFile);
      expect(second.transformedCode).not.toContain(fooAFile);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not publish stale barrel analysis after its root lifecycle is reset', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-barrel-race-'));

    try {
      const barrelFile = path.join(root, 'barrel.ts');
      const consumerFile = path.join(root, 'consumer.ts');
      const leafAFile = path.join(root, 'leaf-a.ts');
      const leafBFile = path.join(root, 'leaf-b.ts');
      const consumerCode =
        `import { value } from './barrel';\n` +
        `export const result = value;\n`;
      fs.writeFileSync(barrelFile, `export { value } from './leaf-a';\n`);
      fs.writeFileSync(leafAFile, `export const value = 'a';\n`);
      fs.writeFileSync(leafBFile, `export const value = 'b';\n`);
      fs.writeFileSync(consumerFile, consumerCode);

      const cache = new TransformCacheCollection();
      const recoveryToken = cache.createGraphTraversalToken();
      const started = createDeferred();
      const unblock = createDeferred();
      const resolve = createResolver(root);
      let didBlock = false;
      const gatedResolve = async (what: string, importer: string) => {
        const resolved = resolve(what, importer);
        if (!didBlock && importer === barrelFile && what === './leaf-a') {
          didBlock = true;
          started.resolve();
          await unblock.promise;
        }

        return resolved;
      };

      const staleTransform = runEntrypointAsync(
        root,
        consumerFile,
        cache,
        createRecorder().eventEmitter,
        gatedResolve
      );
      let staleError: unknown;
      const staleOutcome = staleTransform.then(
        () => undefined,
        (error) => {
          staleError = error;
        }
      );
      await started.promise;

      fs.writeFileSync(barrelFile, `export { value } from './leaf-b';\n`);
      const recovery = cache.startUnknownGraphRecovery(
        consumerFile,
        new Set([barrelFile]),
        consumerCode,
        recoveryToken
      );
      recovery.complete();
      unblock.resolve();

      await staleOutcome;
      expect(staleError).toBe(recovery.abortError);
      expect(cache.get('barrelManifests', barrelFile)).toBeUndefined();
      expect(cache.get('exports', barrelFile)).toBeUndefined();

      const fresh = await runEntrypointAsync(
        root,
        consumerFile,
        cache,
        createRecorder().eventEmitter,
        async (what, importer) => resolve(what, importer)
      );
      expect(fresh.transformedCode).toContain(leafBFile);
      expect(fresh.transformedCode).not.toContain(leafAFile);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
