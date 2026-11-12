import path from 'path';

import { SourceMapConsumer } from 'source-map';

import type { Rules } from '@wyw-in-js/shared';

// eslint-disable-next-line import/no-relative-packages -- not part of the transform public API
import { extractCssFromAst } from '../../../transform/src/transform/generators/extract';

const transformMock = jest.fn();

const loadWywInJS = () => import('../index?css-sourcemap-test');

jest.mock('vite', () => require('./viteMock').createViteMock());

jest.mock('@wyw-in-js/transform', () =>
  require('./transformMock').createTransformMock({
    transform: (...args: unknown[]) => transformMock(...args),
  })
);

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

describe('vite CSS source map', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('points every mapping at the line where its rule starts', async () => {
    const { default: wywInJS } = await loadWywInJS();
    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.tsx');
    const cssFilename = path.posix.join(
      root.split(path.sep).join(path.posix.sep),
      'src',
      'entry.wyw-in-js.css'
    );

    const plugin = wywInJS({ sourceMap: true, keepComments: true });
    plugin.configResolved?.({
      root,
      mode: 'development',
      command: 'serve',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);

    transformMock.mockImplementation(async () => ({
      code: 'export const x = 1;',
      sourceMap: null,
      dependencies: [],
      ...extractCssFromAst(rules, '', {
        filename: entryId,
        keepComments: true,
      }),
    }));

    await plugin.transform?.call(
      { resolve: jest.fn(), warn: jest.fn() } as any,
      'console.log("test")',
      entryId
    );

    const css = String(plugin.load?.call({} as any, cssFilename));

    expect(await generatedLines(css)).toEqual(actualLines(css));
  });
});
