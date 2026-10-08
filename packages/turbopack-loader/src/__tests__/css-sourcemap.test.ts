import fs from 'fs';
import os from 'os';
import path from 'path';

import { SourceMapConsumer } from 'source-map';

import * as actualShared from '@wyw-in-js/shared';
import type { Rules } from '@wyw-in-js/shared';

// eslint-disable-next-line import/no-relative-packages -- not part of the transform public API
import { extractCssFromAst } from '../../../transform/src/transform/generators/extract';

const transformMock = jest.fn();

// Keep the real pure helpers (request parsing, source map normalisation, CSS
// protocol constants) and stub only what the test controls.
const realShared = { ...actualShared };

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  ...realShared,
  logger: jest.fn(),
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  TransformCacheCollection: class TransformCacheCollection {},
  transform: (...args: unknown[]) => transformMock(...args),
}));

const rules: Rules = {
  '.first': {
    className: 'first',
    displayName: 'First',
    cssText: '/* two\nlines */color:red;',
    start: { line: 3, column: 14 },
  },
  '.list': {
    className: 'list',
    displayName: 'List',
    cssText: '&:before,&:after{/* two\nlines */content:"a\\\nb";}',
    start: { line: 5, column: 13 },
  },
  '.atom': {
    atom: true,
    className: 'atom',
    displayName: 'Atom',
    cssText: '.atom,\n.atom:hover{color:green;}',
    start: { line: 6, column: 13 },
  },
  '.second': {
    className: 'second',
    displayName: 'Second',
    cssText: 'color:blue;',
    start: { line: 7, column: 15 },
  },
};

const marker = 'sourceMappingURL=data:application/json;base64,';

const readInlineMap = (css: string) => {
  const start = css.indexOf(marker);
  if (start === -1) {
    throw new Error('No inline source map');
  }
  const end = css.indexOf('*/', start);
  return Buffer.from(
    css.slice(start + marker.length, end),
    'base64'
  ).toString();
};

const generatedLines = async (sourceMapText: string) => {
  const consumer = await new SourceMapConsumer(JSON.parse(sourceMapText));
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
      lineNumber(css, ':global(', selector),
    ])
  );

const tmpDirs: string[] = [];

afterEach(() => {
  tmpDirs.splice(0).forEach((dir) => {
    fs.rmSync(dir, { force: true, recursive: true });
  });
});

const runLoader = async (options: Record<string, unknown>) => {
  const { default: turbopackLoader } = await import('../index');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-turbo-'));
  tmpDirs.push(tmpDir);
  const resourcePath = path.join(tmpDir, 'entry.tsx');
  const configFile = path.join(tmpDir, 'wyw.config.js');
  fs.writeFileSync(resourcePath, 'export const x = 1;\n');
  fs.writeFileSync(configFile, 'module.exports = {};\n');

  transformMock.mockImplementation(async (_services, code) => ({
    code,
    sourceMap: null,
    dependencies: [],
    ...extractCssFromAst(rules, '', {
      filename: resourcePath,
      keepComments: true,
    }),
  }));

  const emitted = await new Promise<{ code?: string; map?: string }>(
    (resolve, reject) => {
      turbopackLoader.call(
        {
          addDependency: jest.fn(),
          async: jest.fn(),
          callback: (err: Error | null, code?: string, map?: string) =>
            err ? reject(err) : resolve({ code, map }),
          emitWarning: jest.fn(),
          getOptions: () => ({
            configFile,
            sourceMap: true,
            keepComments: true,
            ...options,
          }),
          getResolve: () => async () => false,
          resourcePath,
        } as any,
        fs.readFileSync(resourcePath, 'utf8'),
        null
      );
    }
  );

  return { emitted, tmpDir };
};

describe('turbopack-loader CSS source map', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('inlines a map that points at the wrapped rules in sidecar mode', async () => {
    const { tmpDir } = await runLoader({});

    const css = fs.readFileSync(
      path.join(tmpDir, 'entry.wyw-in-js.module.css'),
      'utf8'
    );

    expect(await generatedLines(readInlineMap(css))).toEqual(actualLines(css));
  });

  it('emits neither map when sourceMap is off', async () => {
    const sidecar = await runLoader({ sourceMap: false });
    const css = fs.readFileSync(
      path.join(sidecar.tmpDir, 'entry.wyw-in-js.module.css'),
      'utf8'
    );
    expect(css).not.toContain(marker);

    const query = await runLoader({ sourceMap: false, outputCss: true });
    expect(query.emitted.map).toBeUndefined();
  });

  it('returns a map that points at the wrapped rules in query mode', async () => {
    const { emitted } = await runLoader({ outputCss: true });

    const css = String(emitted.code);

    expect(css).not.toContain(marker);
    expect(await generatedLines(String(emitted.map))).toEqual(actualLines(css));
  });
});
