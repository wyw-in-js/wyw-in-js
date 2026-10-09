import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import { TransformCacheCollection } from '../cache';
import { Module } from '../module';
import { transform } from '../transform';
import { Entrypoint } from '../transform/Entrypoint';
import { AbortError } from '../transform/actions/AbortError';
import { CacheEpochAbortedError } from '../transform/actions/CacheEpochAbortedError';
import { EntrypointEvictedError } from '../transform/actions/EntrypointEvictedError';
import { asyncActionRunner } from '../transform/actions/actionRunner';
import { baseProcessingHandlers } from '../transform/generators/baseProcessingHandlers';
import { asyncResolveImports } from '../transform/generators/resolveImports';
import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import { withDefaultServices } from '../transform/helpers/withDefaultServices';
import type { IResolveImportsAction, Services } from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';

const processorPath = join(__dirname, '__fixtures__', 'test-css-processor.js');
const source =
  "import { css } from 'test-css'; export const className = css`color:red;`; export const count = 42;";

const resolveImport = async (what: string, importer: string) => {
  if (what === 'test-css') return processorPath;
  return what.startsWith('.') ? resolve(dirname(importer), what) : null;
};

const createServices = (
  filename: string,
  cache = new TransformCacheCollection(),
  eventEmitter = EventEmitter.dummy
) =>
  withDefaultServices({
    cache,
    eventEmitter,
    options: {
      filename,
      root: dirname(filename),
      pluginOptions: loadWywOptions({
        configFile: false,
        eval: { strategy: 'static' },
        tagResolver: (importedSource, imported) =>
          importedSource === 'test-css' && imported === 'css'
            ? processorPath
            : null,
      }),
    },
  });

const processEntrypoint = (entrypoint: Entrypoint, services: Services) =>
  asyncActionRunner(
    entrypoint.createAction('processEntrypoint', undefined, null, {}, services),
    {
      ...baseProcessingHandlers,
      resolveImports(this: IResolveImportsAction) {
        return asyncResolveImports.call(this, resolveImport);
      },
    }
  );

describe('deferred executable preparation for static values', () => {
  let root: string;
  let filename: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wyw-deferred-static-'));
    filename = join(root, 'entry.ts');
    writeFileSync(filename, source);
  });

  afterEach(() => rmSync(root, { force: true, recursive: true }));

  it.each([source, undefined])(
    'materializes real code once when Module reads a processed root (%s)',
    async (loadedCode) => {
      const methods: string[] = [];
      const eventEmitter = new EventEmitter(
        (labels, type) => {
          if (type === 'start' && typeof labels.method === 'string') {
            methods.push(labels.method);
          }
        },
        () => 0,
        () => {}
      );
      const services = createServices(filename, undefined, eventEmitter);
      const entrypoint = Entrypoint.createRoot(
        services,
        filename,
        ['__wywPreval'],
        loadedCode
      );

      await processEntrypoint(entrypoint, services);
      entrypoint.assertTransformed();
      expect(entrypoint.transformed).toBe(true);
      expect(methods).not.toContain('transform:evaluator');
      expect(methods).not.toContain('transform:emitCommonJS');

      await new Module(services, entrypoint).evaluate();
      expect(entrypoint.exports.__wywPreval).toEqual({});
      expect(
        methods.filter((method) => method === 'transform:evaluator')
      ).toHaveLength(1);
      expect(
        methods.filter((method) => method === 'transform:emitCommonJS')
      ).toHaveLength(1);
      expect(entrypoint.transformedCode).toContain('__wywPreval');
      expect(
        methods.filter((method) => method === 'transform:evaluator')
      ).toHaveLength(1);
    }
  );

  it('prepares requested named exports after a deferred root widens only', async () => {
    const services = createServices(filename);
    const first = Entrypoint.createRoot(
      services,
      filename,
      ['__wywPreval'],
      source
    );
    await processEntrypoint(first, services);

    const widened = Entrypoint.createRoot(
      services,
      filename,
      ['className', 'count'],
      source
    );
    expect(widened).not.toBe(first);
    await processEntrypoint(widened, services);
    await new Module(services, widened).evaluate();
    expect(widened.exports.className).toEqual(expect.any(String));
    expect(widened.exports.count).toBe(42);
  });

  it('copies and reuses a deferred artifact with the current owner and services', () => {
    const firstServices = createServices(filename);
    const first = Entrypoint.createRoot(
      firstServices,
      filename,
      ['__wywPreval'],
      source
    );
    const prepareCode = jest.fn(() => 'exports.value = 42;');
    first.setTransformResult({ metadata: null, prepareCode });
    const evaluated = first.createEvaluated();
    firstServices.cache.add('entrypoints', filename, evaluated);
    const nextServices = createServices(filename, firstServices.cache);
    const reused = Entrypoint.createRoot(
      nextServices,
      filename,
      ['__wywPreval'],
      source
    );
    reused.assertTransformed();
    expect(prepareCode).not.toHaveBeenCalled();
    expect(reused.transformedCode).toBe('exports.value = 42;');
    expect(prepareCode).toHaveBeenCalledWith(reused, nextServices);
    expect(reused.transformedCode).toBe('exports.value = 42;');
    expect(prepareCode).toHaveBeenCalledTimes(1);
  });

  it('uses transform action services when its entrypoint came from an earlier run', () => {
    const firstServices = createServices(filename);
    const entrypoint = Entrypoint.createRoot(
      firstServices,
      filename,
      ['__wywPreval'],
      source
    );
    const nextServices = createServices(filename, firstServices.cache);
    const prepareCode = jest.fn(() => 'exports.value = 42;');
    entrypoint.setTransformResult(
      { metadata: null, prepareCode },
      nextServices
    );
    expect(entrypoint.transformedCode).toBe('exports.value = 42;');
    expect(prepareCode).toHaveBeenCalledWith(entrypoint, nextServices);
  });

  it('restores a deferred artifact when result publication fails', () => {
    const services = createServices(filename);
    const entrypoint = Entrypoint.createRoot(
      services,
      filename,
      ['__wywPreval'],
      source
    );
    const prepareCode = jest.fn(() => 'exports.old = true;');
    entrypoint.setTransformResult({ metadata: null, prepareCode });
    const error = new Error('observer failed');
    const rejectingServices = {
      ...services,
      eventEmitter: new EventEmitter(
        () => {},
        () => 0,
        (_id, _time, event) => {
          if (event.type === 'setTransformResult') throw error;
        }
      ),
    };
    expect(() =>
      entrypoint.setTransformResult(
        { code: 'exports.new = true;', metadata: null },
        rejectingServices
      )
    ).toThrow(error);
    expect(entrypoint.transformedCode).toBe('exports.old = true;');
    expect(prepareCode).toHaveBeenCalledWith(entrypoint, services);
  });

  it('does not overwrite a reentrant result while materializing old code', () => {
    const services = createServices(filename);
    const entrypoint = Entrypoint.createRoot(
      services,
      filename,
      ['__wywPreval'],
      source
    );
    entrypoint.setTransformResult({
      metadata: null,
      prepareCode: (current) => {
        current.setTransformResult({
          code: 'exports.new = true;',
          metadata: null,
        });
        return 'exports.old = true;';
      },
    });
    expect(() => entrypoint.transformedCode).toThrow(AbortError);
    expect(entrypoint.transformedCode).toBe('exports.new = true;');
  });

  it('does not materialize an evicted source or an unrelated publication', () => {
    const services = createServices(filename);
    const entrypoint = Entrypoint.createRoot(
      services,
      filename,
      ['__wywPreval'],
      source
    );
    const prepareCode = jest.fn(() => 'exports.old = true;');
    entrypoint.setTransformResult({ metadata: null, prepareCode });
    services.cache.delete('entrypoints', filename);
    expect(() => entrypoint.transformedCode).toThrow(EntrypointEvictedError);
    Entrypoint.createRoot(services, filename, ['__wywPreval'], source);
    expect(() => entrypoint.transformedCode).toThrow(AbortError);
    expect(prepareCode).not.toHaveBeenCalled();
  });

  it('rejects materialization if a callback retires its cache epoch', () => {
    const services = createServices(filename);
    const entrypoint = Entrypoint.createRoot(
      services,
      filename,
      ['__wywPreval'],
      source
    );
    const error = new Error('materialization recovery');
    const prepareCode = jest.fn(() => {
      services.cache.beginSupersedeStormRecovery(error);
      return 'exports.old = true;';
    });
    entrypoint.setTransformResult({ metadata: null, prepareCode });
    expect(() => entrypoint.transformedCode).toThrow(CacheEpochAbortedError);
    expect(() => entrypoint.transformedCode).toThrow(CacheEpochAbortedError);
    expect(prepareCode).toHaveBeenCalledTimes(1);
  });

  it('retains static dependency invalidation while the executable is deferred', async () => {
    const tokenFile = join(root, 'token.ts');
    writeFileSync(tokenFile, "export const color = 'red';");
    const importedSource =
      "import { css } from 'test-css'; import { color } from './token.ts'; export const className = css`color:${color};`;";
    writeFileSync(filename, importedSource);
    const cache = new TransformCacheCollection();
    const services = createServices(filename, cache);
    const run = () =>
      transform(services, readFileSync(filename, 'utf8'), resolveImport);

    const first = await run();
    expect(first.cssText).toContain('color:red');
    const cached = cache.get('entrypoints', filename);
    expect(cached?.invalidationDependencies.has(tokenFile)).toBe(true);
    expect(first.dependencies).toContain(tokenFile);
    writeFileSync(tokenFile, "export const color = 'blue';");
    const next = await run();
    expect(next.cssText).toContain('color:blue');
    expect(next.dependencies).toContain(tokenFile);
  });
});
