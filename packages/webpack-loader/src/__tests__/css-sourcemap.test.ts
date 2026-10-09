import { SourceMapConsumer } from 'source-map';

import * as actualShared from '@wyw-in-js/shared';
import type { Rules } from '@wyw-in-js/shared';

// eslint-disable-next-line import/no-relative-packages -- not part of the transform public API
import { extractCssFromAst } from '../../../transform/src/transform/generators/extract';
import {
  decodeOutputCssPayload,
  encodeOutputCssPayload,
  getCacheInstance,
  toCacheKey,
} from '../cache';
import outputCssLoader from '../outputCssLoader';

const transformMock = jest.fn();

// Keep the real pure helpers (request parsing, source map normalisation, CSS
// protocol constants) and stub only what the test controls.
const realShared = { ...actualShared };

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  ...realShared,
  logger: jest.fn(),
  mergeOxcResolverAlias: (oxcOptions: any) => oxcOptions,
  toNativeResolverAlias: () => ({}),
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  createParallelTransforms: () => null,
  createFileReporter: () => ({
    emitter: { single: jest.fn() },
    onDone: jest.fn(),
  }),
  TransformCacheCollection: class TransformCacheCollection {},
  transform: (...args: unknown[]) => transformMock(...args),
  disposeEvalBroker: jest.fn(),
}));

const createHook = <TArgs extends unknown[]>() => {
  const handlers: Array<(...args: TArgs) => void> = [];

  return {
    call: (...args: TArgs) => {
      handlers.forEach((handler) => handler(...args));
    },
    tap: (_name: string, handler: (...args: TArgs) => void) => {
      handlers.push(handler);
    },
  };
};

const createCompiler = () => ({
  hooks: {
    done: createHook<[unknown]>(),
    failed: createHook<[Error]>(),
    shutdown: createHook<[]>(),
    watchClose: createHook<[]>(),
  },
  options: {},
});

const rules: Rules = {
  '.first': {
    className: 'first',
    displayName: 'First',
    cssText: '/* two\nlines */color:red;',
    start: { line: 3, column: 14 },
  },
  '.second': {
    className: 'second',
    displayName: 'Second',
    cssText: 'color:blue;',
    start: { line: 7, column: 15 },
  },
};

const marker = 'sourceMappingURL=data:application/json;base64,';

const generatedLines = async (css: string) => {
  const start = css.indexOf(marker) + marker.length;
  const end = css.indexOf('*/', start);
  const consumer = await new SourceMapConsumer(
    JSON.parse(Buffer.from(css.slice(start, end), 'base64').toString())
  );
  const lines: Record<string, number> = {};
  try {
    consumer.eachMapping((mapping) => {
      if (mapping.name === null) {
        throw new Error(`Mapping at line ${mapping.generatedLine} has no name`);
      }
      lines[mapping.name] = mapping.generatedLine;
    });
  } finally {
    consumer.destroy();
  }
  return lines;
};

const selectorEnd = new Set([')', ':', ',', '{', ' ']);

const startsWithSelector = (line: string, prefix: string, selector: string) =>
  line.startsWith(prefix + selector) &&
  selectorEnd.has(line.charAt(prefix.length + selector.length));

const lineNumber = (css: string, prefix: string, selector: string) => {
  const index = css
    .split('\n')
    .findIndex((line) => startsWithSelector(line, prefix, selector));
  if (index === -1) {
    throw new Error(`No line starts with ${prefix}${selector}`);
  }
  return index + 1;
};

const actualLines = (css: string) =>
  Object.fromEntries(
    Object.keys(rules).map((selector) => [
      selector,
      lineNumber(css, '', selector),
    ])
  );

describe('webpack-loader CSS source map', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('points every mapping at the line where its rule starts', async () => {
    const { default: webpackLoader } = await import('../index');
    const resourcePath = '/abs/entry.tsx';
    const compiler = createCompiler();

    transformMock.mockImplementation(async (_services, code) => ({
      code,
      sourceMap: null,
      dependencies: [],
      ...extractCssFromAst(rules, '', {
        filename: resourcePath,
        keepComments: true,
      }),
    }));

    let emittedCode = '';
    await new Promise<void>((resolve, reject) => {
      webpackLoader.call(
        {
          _compiler: compiler,
          addDependency: jest.fn(),
          async: jest.fn(),
          callback: (err: Error | null, code: string) => {
            emittedCode = code;
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          },
          context: process.cwd(),
          emitWarning: jest.fn(),
          getDependencies: () => [],
          getOptions: () => ({ sourceMap: true, keepComments: true }),
          getResolve: () =>
            jest.fn(
              (
                _ctx: string,
                _token: string,
                cb: (err: any, res: any) => void
              ) => cb(null, null)
            ),
          loaderIndex: 0,
          loaders: [{ ident: 'default' }],
          request: `/abs/webpack-loader.js??default!${resourcePath}`,
          resourcePath,
          rootContext: process.cwd(),
          utils: {
            contextify: (_ctx: string, request: string) => request,
          },
        } as any,
        'export const x = 1;',
        null
      );
    });

    const cache = await getCacheInstance(undefined, compiler);
    const css = String(await cache.get(toCacheKey(resourcePath)));

    expect(await generatedLines(css)).toEqual(actualLines(css));

    const request = JSON.parse(emittedCode.match(/require\(([^)]+)\);/)![1]);
    const params = new URLSearchParams(
      request.split('!=!')[1].split('!')[0].split('?')[1]
    );
    const outputCssPayload = params.get('outputCssPayload')!;
    const payload = decodeOutputCssPayload(outputCssPayload);
    expect(payload.cssText).not.toContain('sourceMappingURL');
    const callback = jest.fn();
    await outputCssLoader.call({
      _module: { type: 'javascript/auto' },
      async: jest.fn(),
      getOptions: () => ({ outputCssPayload }),
      callback,
    } as ThisParameterType<typeof outputCssLoader>);
    const [error, emittedCss, map] = callback.mock.calls[0];
    expect(error).toBeNull();
    expect(emittedCss).toBe(payload.cssText);
    await SourceMapConsumer.with(map, null, (consumer) => {
      for (const [selector, rule] of Object.entries(rules)) {
        expect(
          consumer.originalPositionFor({
            line: lineNumber(emittedCss, '', selector),
            column: 0,
          })
        ).toEqual({
          source: resourcePath,
          line: rule.start!.line,
          column: rule.start!.column,
          name: selector,
        });
      }
    });
  });

  it.each(['asset', 'asset/resource', 'asset/inline', 'asset/source'])(
    'retains an inline map for raw %s output',
    async (type) => {
      const extracted = extractCssFromAst(rules, '', {
        filename: '/abs/entry.tsx',
        keepComments: true,
      });
      const callback = jest.fn();
      await outputCssLoader.call({
        _module: { type },
        async: jest.fn(),
        getOptions: () => ({
          outputCssPayload: encodeOutputCssPayload(extracted),
        }),
        callback,
      } as ThisParameterType<typeof outputCssLoader>);

      const [error, emittedCss, map] = callback.mock.calls[0];
      expect(error).toBeNull();
      expect(emittedCss).toContain(marker);
      expect(await generatedLines(emittedCss)).toEqual(actualLines(emittedCss));
      expect(map).toEqual(JSON.parse(extracted.cssSourceMapText));
    }
  );
});
