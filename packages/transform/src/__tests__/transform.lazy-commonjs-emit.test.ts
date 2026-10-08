import fs from 'fs';
import os from 'os';
import path from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker, EvalBroker } from '../eval/broker';
import { transform } from '../transform';
import { Entrypoint } from '../transform/Entrypoint';
import type { IEvaluatedEntrypoint } from '../transform/EvaluatedEntrypoint';
import { EventEmitter } from '../utils/EventEmitter';

const EMIT_COMMONJS_SPAN = 'transform:emitCommonJS';
// The first transform spawns the eval runner.
const BROKER_TEST_TIMEOUT = 30_000;

const processorFile = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const createEmitCounter = () => {
  const counter = { emits: 0 };
  const eventEmitter = new EventEmitter(
    (labels, type) => {
      if (type === 'finish' && labels.method === EMIT_COMMONJS_SPAN) {
        counter.emits += 1;
      }
    },
    () => 0,
    () => {}
  );

  return { counter, eventEmitter };
};

const readTransformedCode = (
  entry: Entrypoint | IEvaluatedEntrypoint | undefined
): string | null => {
  if (entry instanceof Entrypoint) {
    return entry.transformedCode;
  }

  return entry?.transformResultCode ?? null;
};

describe('CommonJS emit of the transform stage', () => {
  let root: string;
  let componentFile: string;
  let tokensFile: string;
  let cache: TransformCacheCollection;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-lazy-commonjs-emit-'))
    );
    tokensFile = path.join(root, 'tokens.ts');
    componentFile = path.join(root, 'component.ts');
    // The IIFE keeps the value out of static resolution, so the dependency
    // really goes through the eval broker.
    fs.writeFileSync(
      tokensFile,
      `export const colors = (() => ({ blue: 'blue' }))();\n`
    );
    fs.writeFileSync(
      componentFile,
      dedent`
        import { css } from 'test-css-processor';
        import { colors } from './tokens';

        export const className = css\`
          color: \${colors.blue};
        \`;
      `
    );
    cache = new TransformCacheCollection();
  });

  afterEach(() => {
    disposeEvalBroker(cache);
    fs.rmSync(root, { force: true, recursive: true });
  });

  const runTransform = (eventEmitter: EventEmitter) =>
    transform(
      {
        asyncResolveKey: 'lazy-commonjs-emit-test',
        cache,
        eventEmitter,
        options: {
          filename: componentFile,
          root,
          pluginOptions: {
            configFile: false,
            features: { globalCache: true },
            tagResolver: (source: string, tag: string) =>
              source === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
          },
        },
      },
      fs.readFileSync(componentFile, 'utf8'),
      async (what: string, importer: string) => {
        if (what === 'test-css-processor') {
          return processorFile;
        }

        return `${path.resolve(path.dirname(importer), what)}.ts`;
      }
    );

  it(
    'is not run by a broker-backed transform',
    async () => {
      const { counter, eventEmitter } = createEmitCounter();
      const evaluate = jest.spyOn(EvalBroker.prototype, 'evaluate');

      try {
        const result = await runTransform(eventEmitter);

        expect(result.cssText).toContain('color:blue;');
        expect(evaluate).toHaveBeenCalled();
      } finally {
        evaluate.mockRestore();
      }

      expect(counter.emits).toBe(0);
    },
    BROKER_TEST_TIMEOUT
  );

  it(
    'runs once when the transformed code is first read',
    async () => {
      const { counter, eventEmitter } = createEmitCounter();

      const result = await runTransform(eventEmitter);
      expect(result.cssText).toContain('color:blue;');
      expect(counter.emits).toBe(0);

      const tokens = cache.get('entrypoints', tokensFile);
      expect(tokens).toBeDefined();

      const firstRead = readTransformedCode(tokens);
      expect(firstRead).toContain('exports.colors');
      expect(counter.emits).toBe(1);

      expect(readTransformedCode(tokens)).toBe(firstRead);
      expect(counter.emits).toBe(1);
    },
    BROKER_TEST_TIMEOUT
  );
});
