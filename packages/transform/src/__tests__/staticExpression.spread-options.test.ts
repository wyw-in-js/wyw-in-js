import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import {
  collectStaticExpressionReferences,
  isSafeStaticExpression,
  parseStaticExpressionSource,
} from '../transform/generators/resolveStaticOxcValues/staticExpression';
import type { StaticExpressionOptions } from '../transform/generators/resolveStaticOxcValues/types';
import { EventEmitter } from '../utils/EventEmitter';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

const parse = (source: string) => {
  const expression = parseStaticExpressionSource(source, 'theme.ts');
  if (!expression) {
    throw new Error(`Cannot parse ${source}`);
  }

  return expression;
};

describe('static expression grammar for object spread', () => {
  const cases: [string, string, StaticExpressionOptions][] = [
    [
      'a static helper call',
      "{ ...makeTheme('dark'), accent: 'red' }",
      { staticHelperLocals: new Set(['makeTheme']) },
    ],
    ['a metadata call', '{ ...meta() }', { allowMetadataCalls: true }],
  ];

  it.each(cases)(
    'admits a spread of %s when options allow it',
    (_, source, options) => {
      const expression = parse(source);

      expect(isSafeStaticExpression(expression, options)).toBe(true);
      expect(
        collectStaticExpressionReferences(expression, new Set(), options)
      ).toBe(true);
    }
  );

  it.each(cases)('rejects a spread of %s without options', (_, source) => {
    const expression = parse(source);

    expect(isSafeStaticExpression(expression)).toBe(false);
    expect(collectStaticExpressionReferences(expression, new Set())).toBe(
      false
    );
  });

  it('resolves an exported object spread of a staticBindings helper without evaluation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-spread-'));
    const helpersFile = join(root, 'helpers.ts');
    const themeFile = join(root, 'theme.ts');
    const entryFile = join(root, 'entry.ts');

    writeFileSync(
      helpersFile,
      `export const makeTheme = (mode) => ({ color: mode });\n`
    );
    writeFileSync(
      themeFile,
      dedent`
        import { makeTheme } from './helpers';

        export const theme = { ...makeTheme('dark'), accent: 'red' };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { theme } from './theme';

        export const className = css\`
          color: ${'${theme.color}'};
          border-color: ${'${theme.accent}'};
        \`;
      `
    );

    const counts = new Map<string, number>();
    const eventEmitter = new EventEmitter(
      (labels, type) => {
        if (type === 'start' && typeof labels.method === 'string') {
          counts.set(labels.method, (counts.get(labels.method) ?? 0) + 1);
        }
      },
      () => 0,
      () => {}
    );

    const resolveImport = async (what: string, importer: string) => {
      if (what === 'test-css-processor') {
        return processorFile;
      }

      const candidate = `${resolve(dirname(importer), what)}.ts`;
      return existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : null;
    };

    try {
      const result = await transform(
        {
          cache: new TransformCacheCollection(),
          eventEmitter,
          options: {
            filename: entryFile,
            root,
            pluginOptions: {
              configFile: false,
              eval: { strategy: 'hybrid' },
              staticBindings: {
                [helpersFile]: {
                  makeTheme: (mode: string) => ({ color: `${mode}blue` }),
                },
              },
              tagResolver: (source, tag) =>
                source === 'test-css-processor' && tag === 'css'
                  ? processorFile
                  : null,
            },
          },
        },
        readFileSync(entryFile, 'utf8'),
        resolveImport
      );

      expect(result.cssText).toContain('color:darkblue');
      expect(result.cssText).toContain('border-color:red');
      expect(counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
