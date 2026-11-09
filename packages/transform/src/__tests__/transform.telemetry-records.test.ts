import { createHash } from 'crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { createFileReporter } from '../debug/fileReporter';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';
import { EventEmitter } from '../utils/EventEmitter';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

// The first evaluation spawns the eval runner.
const EVAL_TEST_TIMEOUT = 30_000;

type JSONRecord = Record<string, any>;

type TransformResult = Awaited<ReturnType<typeof transform>>;

const delay = (intervalMs: number) =>
  new Promise<void>((done) => {
    setTimeout(done, intervalMs);
  });

const readJsonl = (file: string): JSONRecord[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const waitForRecords = async (
  file: string,
  type: string
): Promise<JSONRecord[]> => {
  const startedAt = Date.now();
  const poll = async (): Promise<JSONRecord[]> => {
    if (existsSync(file) && readFileSync(file, 'utf8').endsWith('\n')) {
      const records = readJsonl(file);
      if (records.some((record) => record.type === type)) return records;
    }
    if (Date.now() - startedAt > 5_000) {
      throw new Error(`no ${type} record in ${file}`);
    }
    await delay(5);
    return poll();
  };

  return poll();
};

const createEmitterWithoutReporter = () => {
  let actionId = 0;
  return new EventEmitter(
    () => {},
    ((phase: string) => {
      if (phase !== 'start') return undefined;
      const id = actionId;
      actionId += 1;
      return id;
    }) as never,
    () => {}
  );
};

// The encoding of parse and shake revisions declared by the schema.
const revisionOf = (code: string) =>
  createHash('sha256').update(code).digest('base64url');

const pluginOptions = {
  configFile: false,
  eval: { strategy: 'execute' as const },
  tagResolver: (source: string, tag: string) =>
    source === 'test-css-processor' && tag === 'css' ? processorFile : null,
};

const createResolver =
  (beforeResolve?: () => Promise<void>) =>
  async (what: string, importer: string) => {
    await beforeResolve?.();
    if (what === 'test-css-processor') return processorFile;
    if (what.startsWith('.')) {
      const resolved = resolve(dirname(importer), what);
      return resolved.endsWith('.js') ? resolved : `${resolved}.js`;
    }
    return null;
  };

/**
 * entry.js -> tokens.js (a wildcard barrel) -> theme.js
 *
 * `String(...)` keeps the color out of the static resolver, so the value of
 * the `css` template is computed by evaluating theme.js. Without the barrel
 * entry.js imports theme.js directly.
 */
const writeProject = (root: string, { barrel }: { barrel: boolean }) => {
  const files = {
    entry: join(root, 'entry.js'),
    nested: join(root, 'nested.js'),
    theme: join(root, 'theme.js'),
    tokens: join(root, 'tokens.js'),
  };

  writeFileSync(
    files.theme,
    dedent`
      const base = 'dark';

      export const color = String(base + 'green');
    `
  );
  writeFileSync(files.tokens, `export * from './theme';`);
  writeFileSync(
    files.entry,
    dedent`
      import { css } from 'test-css-processor';
      import { color } from '${barrel ? './tokens' : './theme'}';

      export const className = css\`
        color: ${'${color}'};
      \`;
    `
  );
  writeFileSync(
    files.nested,
    dedent`
      import { css } from 'test-css-processor';

      export const nestedClassName = css\`
        color: blue;
      \`;
    `
  );

  return files;
};

/** Reads a named field of a tuple through the layout the schema declares. */
const fieldOf = (
  schema: JSONRecord,
  layout: string,
  tuple: unknown[],
  name: string
) => {
  const index = (
    schema.tupleEncoding.layouts[layout] as string[] | undefined
  )?.indexOf(name);
  if (index === undefined || index < 0) {
    throw new Error(`the ${layout} layout has no ${name} field`);
  }
  return tuple[index];
};

describe('transform telemetry records', () => {
  let root: string;
  let reportDir: string;
  const caches: TransformCacheCollection[] = [];

  const newCache = () => {
    const cache = new TransformCacheCollection();
    caches.push(cache);
    return cache;
  };

  const transformObserved = async (
    filename: string,
    beforeResolve?: () => Promise<void>
  ) => {
    const reporter = createFileReporter({ dir: reportDir });
    let result: TransformResult;
    try {
      result = await transform(
        {
          cache: newCache(),
          eventEmitter: reporter.emitter,
          options: { filename, root, pluginOptions },
        },
        readFileSync(filename, 'utf8'),
        createResolver(beforeResolve)
      );
    } finally {
      reporter.onDone(root);
    }

    const [pipelineSchema, ...pipeline] = await waitForRecords(
      join(reportDir, 'pipeline-telemetry.jsonl'),
      'pipeline-telemetry'
    );
    const [evalSchema, ...evalRecords] = await waitForRecords(
      join(reportDir, 'eval-telemetry.jsonl'),
      'eval-root'
    );

    return { evalRecords, evalSchema, pipeline, pipelineSchema, result };
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'wyw-telemetry-records-')));
    reportDir = join(root, 'report');
  });

  afterEach(() => {
    caches.splice(0).forEach((cache) => disposeEvalBroker(cache));
    rmSync(root, { recursive: true, force: true });
  });

  it(
    'fills every section of the pipeline record of an observed root',
    async () => {
      const files = writeProject(root, { barrel: true });
      const { pipeline, pipelineSchema, result } = await transformObserved(
        files.entry
      );

      expect(result.cssText).toContain('color:darkgreen');
      expect(pipelineSchema.type).toBe('pipeline-telemetry-schema');
      expect(pipeline).toHaveLength(1);
      const [record] = pipeline;
      const field = (layout: string, tuple: unknown[], name: string) =>
        fieldOf(pipelineSchema, layout, tuple, name) as any;

      expect(Object.keys(record).sort()).toEqual([
        'cache',
        'cleanup',
        'entrypoints',
        'parse',
        'processors',
        'root',
        'schemaVersion',
        'shakes',
        'type',
      ]);
      expect(record.type).toBe('pipeline-telemetry');
      expect(record.schemaVersion).toBe(2);
      expect(record.root.status).toBe('success');
      expect(record.root.filename).toMatch(/(^|\/)entry\.js$/);

      // cache: requests = get + has requests, every bucket is hits + misses.
      const { cacheOperation } = pipelineSchema.tupleEncoding.enumIds;
      const requestsByOperation = new Map<string, number>();
      let bucketRequests = 0;
      (field('cache', record.cache, 'byOperation') as unknown[][]).forEach(
        (bucket) => {
          const operation =
            cacheOperation[field('cacheByOperation', bucket, 'operationId')];
          const requests = field('cacheByOperation', bucket, 'requests');
          expect(requests).toBe(
            field('cacheByOperation', bucket, 'hits') +
              field('cacheByOperation', bucket, 'misses')
          );
          bucketRequests += requests;
          requestsByOperation.set(
            operation,
            (requestsByOperation.get(operation) ?? 0) + requests
          );
        }
      );
      expect(requestsByOperation.get('get')).toBeGreaterThanOrEqual(1);
      expect(requestsByOperation.get('has')).toBeGreaterThanOrEqual(1);
      expect(field('cache', record.cache, 'requests')).toBe(bucketRequests);

      // entrypoints: requests = roots + children.
      const roots = field('entrypoints', record.entrypoints, 'roots');
      const children = field('entrypoints', record.entrypoints, 'children');
      expect(roots).toBeGreaterThanOrEqual(1);
      expect(children).toBeGreaterThanOrEqual(1);
      expect(
        field('entrypoints', record.entrypoints, 'initialRoots')
      ).toBeGreaterThanOrEqual(1);
      expect(field('entrypoints', record.entrypoints, 'requests')).toBe(
        roots + children
      );

      // parse: allRequests = cachedRequests + uncachedRequests.
      const totals = field('parse', record.parse, 'totals');
      const allRequests = field('parseTotals', totals, 'allRequests');
      expect(allRequests).toBeGreaterThanOrEqual(1);
      expect(allRequests).toBe(
        field('parseTotals', totals, 'cachedRequests') +
          field('parseTotals', totals, 'uncachedRequests')
      );
      expect(
        (field('parse', record.parse, 'revisions') as unknown[]).length
      ).toBeGreaterThanOrEqual(1);

      // shakes: attempts = successes + errors.
      const attempts = field('shakes', record.shakes, 'attempts');
      expect(attempts).toBeGreaterThanOrEqual(1);
      expect(field('shakes', record.shakes, 'successes')).toBe(attempts);
      expect(field('shakes', record.shakes, 'errors')).toBe(0);
      expect(
        (field('shakes', record.shakes, 'calls') as unknown[]).length
      ).toBe(attempts);

      const phases = (record.processors as unknown[][]).map((processor) =>
        field('processor', processor, 'phase')
      );
      expect(phases).toContain('preeval');

      expect(field('cleanup', record.cleanup, 'calls')).toBeGreaterThanOrEqual(
        1
      );
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'records the physical eval preparation stages of an observed root',
    async () => {
      const files = writeProject(root, { barrel: true });
      const { evalRecords, evalSchema, result } = await transformObserved(
        files.entry
      );

      expect(result.cssText).toContain('color:darkgreen');
      expect(evalSchema.type).toBe('eval-telemetry-schema');
      const evalRoots = evalRecords.filter(
        (record) => record.type === 'eval-root'
      );
      expect(evalRoots).toHaveLength(1);
      const [evalRoot] = evalRoots;

      expect(evalRoot.schemaVersion).toBe(2);
      expect(evalRoot.root.status).toBe('success');
      expect(evalRoot.root.entrypoint).toMatch(/(^|\/)entry\.js$/);

      const { preparation } = evalRoot.loads;
      expect(preparation.calls).toBeGreaterThanOrEqual(1);
      expect(preparation.errors).toBe(0);
      expect(preparation.prepareCalls).toBeGreaterThanOrEqual(1);
      expect(preparation.shakeCalls).toBeGreaterThanOrEqual(1);
      expect(preparation.stripCalls).toBeGreaterThanOrEqual(1);
      expect(preparation.artifacts.length).toBeGreaterThanOrEqual(1);
    },
    EVAL_TEST_TIMEOUT
  );

  it(
    'keeps a nested transform without a reporter out of the observed root',
    async () => {
      const files = writeProject(root, { barrel: false });
      const nestedCode = readFileSync(files.nested, 'utf8');
      let nestedResult: TransformResult | undefined;

      const { pipeline, pipelineSchema, result } = await transformObserved(
        files.entry,
        async () => {
          if (nestedResult) return;
          nestedResult = await transform(
            {
              cache: newCache(),
              eventEmitter: createEmitterWithoutReporter(),
              options: { filename: files.nested, root, pluginOptions },
            },
            nestedCode,
            createResolver()
          );
        }
      );

      expect(result.cssText).toContain('color:darkgreen');
      expect(nestedResult?.cssText).toContain('color:blue');
      expect(pipeline).toHaveLength(1);
      const [record] = pipeline;
      const field = (layout: string, tuple: unknown[], name: string) =>
        fieldOf(pipelineSchema, layout, tuple, name) as any;

      expect(record.root.filename).toMatch(/(^|\/)entry\.js$/);
      // The nested transform is a root with loaded code of its own; only the
      // observed root may be counted as one.
      expect(field('entrypoints', record.entrypoints, 'initialRoots')).toBe(1);

      const nestedRevision = revisionOf(nestedCode);
      const parseRevisions = (
        field('parse', record.parse, 'revisions') as unknown[][]
      ).map((revision) => field('parseRevision', revision, 'revision'));
      expect(parseRevisions.length).toBeGreaterThanOrEqual(1);
      expect(parseRevisions).not.toContain(nestedRevision);

      const shakeInputs = (
        field('shakes', record.shakes, 'calls') as unknown[][]
      ).map((call) => field('shakeCall', call, 'inputRevision'));
      expect(shakeInputs).not.toContain(nestedRevision);
      expect(JSON.stringify(record)).not.toContain('nested.js');
    },
    EVAL_TEST_TIMEOUT
  );
});
