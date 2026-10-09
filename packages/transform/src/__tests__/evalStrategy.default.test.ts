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
import type { PluginOptions } from '../types';
import { EventEmitter } from '../utils/EventEmitter';
import { getEvalStrategy } from '../utils/evalStrategy';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

const resolveImport = async (what: string, importer: string) => {
  if (what === 'test-css-processor') {
    return processorFile;
  }

  if (what.startsWith('.')) {
    const base = resolve(dirname(importer), what);
    for (const ext of ['.ts', '.js']) {
      const candidate = `${base}${ext}`;
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }

  return null;
};

const countEvaluations = () => {
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

  return {
    eventEmitter,
    evalFileCount: () => counts.get('transform:evalFile') ?? 0,
  };
};

describe('getEvalStrategy', () => {
  it('defaults to hybrid when options did not go through loadWywOptions', () => {
    expect(getEvalStrategy({})).toBe('hybrid');
    expect(getEvalStrategy({ eval: {} })).toBe('hybrid');
    expect(getEvalStrategy({ eval: { strategy: undefined } })).toBe('hybrid');
  });

  it('keeps an explicit strategy', () => {
    expect(getEvalStrategy({ eval: { strategy: 'execute' } })).toBe('execute');
    expect(getEvalStrategy({ eval: { strategy: 'static' } })).toBe('static');
  });
});

describe('eval.strategy left undefined', () => {
  const run = async (evalOptions: PluginOptions['eval']) => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-strategy-default-'));
    const tokensFile = join(root, 'tokens.ts');
    const entryFile = join(root, 'entry.ts');
    writeFileSync(tokensFile, `export const color = 'red';\n`);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './tokens';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    const { eventEmitter, evalFileCount } = countEvaluations();
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
              eval: evalOptions,
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

      return { cssText: result.cssText, evalFiles: evalFileCount() };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('resolves imported values the same way as the default hybrid strategy', async () => {
    const hybrid = await run({ strategy: 'hybrid' });
    // `{ strategy: undefined }` overrides the loadWywOptions default, so every
    // stage has to fall back to the same effective strategy on its own.
    const unset = await run({ strategy: undefined });

    expect(hybrid.cssText).toContain('color:red');
    expect(hybrid.evalFiles).toBe(0);
    expect(unset).toEqual(hybrid);
  });
});
