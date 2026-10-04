import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createFileReporter } from '../debug/fileReporter';
import { beginEvalTelemetry } from '../debug/evalTelemetry';
import {
  beginPipelineShake,
  finishPipelineShake,
  recordPipelineCacheRequest,
  recordPipelineProcessors,
  runWithPipelineTelemetry,
} from '../debug/pipelineTelemetry';
import { EventEmitter } from '../utils/EventEmitter';
import { parseOxcCached } from '../utils/parseOxc';

const delay = (intervalMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, intervalMs);
  });

const waitFor = async (
  predicate: () => boolean,
  { timeoutMs = 1000, intervalMs = 5 } = {}
) => {
  const startedAt = Date.now();
  const poll = async (): Promise<void> => {
    if (predicate()) {
      return;
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor timed out');
    }

    await delay(intervalMs);
    await poll();
  };

  await poll();
};

const readJsonl = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const hasJsonlLines = (file: string, length: number) => {
  if (!existsSync(file)) {
    return false;
  }

  const content = readFileSync(file, 'utf8');
  return (
    content.endsWith('\n') &&
    content.split('\n').filter(Boolean).length >= length
  );
};

describe('createFileReporter', () => {
  it('exposes a cheap enabled flag for debug-only work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    const reporter = createFileReporter({ dir });

    try {
      expect(EventEmitter.dummy.enabled).toBe(false);
      expect(reporter.emitter.enabled).toBe(true);
      expect(EventEmitter.dummy.hasEventListener('staticPlan')).toBe(false);
      expect(reporter.emitter.hasEventListener('staticPlan')).toBe(true);
    } finally {
      reporter.onDone(dir);
      await waitFor(() => existsSync(join(dir, 'actions.jsonl')));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes staticResolve single events to static-resolve.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    const reporter = createFileReporter({ dir });

    try {
      reporter.emitter.single({
        filename: join(dir, 'foo.ts'),
        phase: 'export',
        reason: 'unsupported-expression',
        status: 'rejected',
        type: 'staticResolve',
      });
      reporter.emitter.single({
        candidate: '_exp',
        filename: join(dir, 'foo.ts'),
        phase: 'candidate',
        status: 'resolved',
        type: 'staticResolve',
      });
      // unrelated single events should not land in the static-resolve stream
      reporter.emitter.single({
        file: join(dir, 'foo.ts'),
        fileIdx: 'idx',
        imports: [],
        only: ['*'],
        type: 'dependency',
      });

      reporter.onDone(dir);
      const target = join(dir, 'static-resolve.jsonl');
      await waitFor(() => hasJsonlLines(target, 2));

      const events = readJsonl(target);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(
        expect.objectContaining({
          phase: 'export',
          reason: 'unsupported-expression',
          status: 'rejected',
          type: 'staticResolve',
        })
      );
      expect(events[1]).toEqual(
        expect.objectContaining({
          candidate: '_exp',
          phase: 'candidate',
          status: 'resolved',
          type: 'staticResolve',
        })
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes staticPlan single events to static-plan.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    const reporter = createFileReporter({ dir });

    try {
      reporter.emitter.single({
        filename: join(dir, 'foo.ts'),
        needCount: 1,
        runtimeDependencyCount: 2,
        staticValueCount: 3,
        type: 'staticPlan',
        unresolvedCount: 4,
        usageCount: 5,
      });

      reporter.onDone(dir);
      const target = join(dir, 'static-plan.jsonl');
      await waitFor(
        () => existsSync(target) && readFileSync(target).length > 0
      );

      const events = readJsonl(target);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(
        expect.objectContaining({
          needCount: 1,
          runtimeDependencyCount: 2,
          staticValueCount: 3,
          type: 'staticPlan',
          unresolvedCount: 4,
          usageCount: 5,
        })
      );
      expect(events[0].filename).toContain('foo.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes one pipeline telemetry summary per transform root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    const reporter = createFileReporter({ dir });

    try {
      await runWithPipelineTelemetry(
        reporter.emitter,
        () => ({ filename: join(dir, 'root.ts') }),
        async () => {
          recordPipelineCacheRequest('entrypoints', 'get', true);
          recordPipelineProcessors('preeval', false, 1, 1, 0, 0, 0);
          const code = 'export const value: number = 1;';
          parseOxcCached(join(dir, 'root.ts'), code, 'module');
          parseOxcCached(join(dir, 'root.ts'), code, 'module');
          const shakeToken = beginPipelineShake(
            'export const unused = 1;',
            ['unused'],
            'preval'
          );
          finishPipelineShake(shakeToken, 'export {};', false);
        }
      );

      reporter.onDone(dir);

      const target = join(dir, 'pipeline-telemetry.jsonl');
      await waitFor(() => hasJsonlLines(target, 2));

      const events = readJsonl(target);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(
        expect.objectContaining({
          denominators: expect.any(Object),
          schemaVersion: 2,
          tupleEncoding: expect.objectContaining({
            layouts: expect.objectContaining({
              parseRevision: [
                'revision',
                'parserKeyIdOrString',
                'bytes',
                'requests',
                'mask',
                '...values',
              ],
            }),
            masks: {
              parseRevision: {
                cacheHits: 2,
                cacheMisses: 4,
                errors: 8,
                jsxFallbackAttempts: 32,
                jsxFallbackRequests: 16,
                kind: 1,
                rawTransferFallbackAttempts: 64,
              },
              processor: {
                definedProcessors: 1,
                importCandidates: 2,
                lookupAttempts: 4,
                lookupHits: 8,
                passes: 16,
                reusedPlans: 32,
                usages: 64,
              },
              shakeCall: { error: 1, generatedBytes: 2 },
            },
          }),
          type: 'pipeline-telemetry-schema',
        })
      );
      expect(events[1]).toEqual(
        expect.objectContaining({
          cache: [1, 1, 0, 0, 0, [0, 0, 0, 0, 0, []], [[1, 0, 1, 0, 1]], []],
          root: expect.objectContaining({
            filename: expect.stringContaining('root.ts'),
            status: 'success',
          }),
          schemaVersion: 2,
          type: 'pipeline-telemetry',
        })
      );
      expect(events[1].parse).toEqual([
        [2, 2, 0, 1, 1, 1, 62, 31, 0, 0, 0, 0],
        [[expect.any(String), 10, 31, 2, 6, 1, 1]],
      ]);
      expect(events[1].processors).toEqual([['preeval', 6, 1, 1]]);
      expect(events[1].shakes).toEqual([
        1,
        1,
        0,
        10,
        [
          [
            expect.any(String),
            'preval',
            ['unused'],
            expect.any(String),
            24,
            2,
            10,
          ],
        ],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes eval telemetry schema and flushes an error root immediately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    const reporter = createFileReporter({ dir });
    const broker = {};
    const target = join(dir, 'eval-telemetry.jsonl');

    try {
      const failed = beginEvalTelemetry(reporter.emitter, broker, () => ({
        entrypoint: join(dir, 'failed-root.ts'),
      }));
      expect(failed).toBeDefined();
      failed!.start({ batchIndex: 0, batchSize: 1 });
      failed!.recordLoadRequest();
      failed!.recordLoadCacheOutcome('miss');
      const preparation = failed!.beginPreparation(join(dir, 'dep.ts'), [
        'value',
      ]);
      preparation.finish({
        code: 'export const value = "λ";',
        imports: null,
        only: ['value'],
        outputRevision: 'prepared-hash',
      });
      failed!.finish('error');

      await waitFor(() => hasJsonlLines(target, 2));

      const succeeded = beginEvalTelemetry(reporter.emitter, broker, () => ({
        entrypoint: join(dir, 'cached-root.ts'),
      }));
      expect(succeeded).toBeDefined();
      succeeded!.start({ batchIndex: 0, batchSize: 1 });
      succeeded!.recordLoadRequest();
      succeeded!.recordLoadCacheOutcome('hit');
      succeeded!.finish('success');

      reporter.onDone(dir);
      reporter.onDone(dir);
      await waitFor(() => hasJsonlLines(target, 3));

      const events = readJsonl(target);
      expect(events).toHaveLength(3);
      expect(events[0]).toEqual(
        expect.objectContaining({
          denominators: expect.any(Object),
          limitations: expect.any(Object),
          schemaVersion: 2,
          type: 'eval-telemetry-schema',
        })
      );
      expect(events[1]).toEqual(
        expect.objectContaining({
          loads: expect.objectContaining({
            cache: expect.objectContaining({ misses: 1 }),
            preparation: expect.objectContaining({ calls: 1 }),
            requests: 1,
          }),
          root: expect.objectContaining({
            entrypoint: 'failed-root.ts',
            status: 'error',
          }),
          type: 'eval-root',
        })
      );
      expect(events[1].loads.preparation.artifacts[0].id).toBe('dep.ts');
      expect(events[2]).toEqual(
        expect.objectContaining({
          loads: expect.objectContaining({
            cache: expect.objectContaining({ hits: 1 }),
            requests: 1,
          }),
          root: expect.objectContaining({
            entrypoint: 'cached-root.ts',
            status: 'success',
          }),
          type: 'eval-root',
        })
      );
    } finally {
      reporter.onDone(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flushes prior roots with an error root before onDone without duplicates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    const reporter = createFileReporter({ dir });
    const target = join(dir, 'pipeline-telemetry.jsonl');

    try {
      await runWithPipelineTelemetry(
        reporter.emitter,
        () => ({ filename: join(dir, 'success.ts') }),
        async () => 1
      );
      await expect(
        runWithPipelineTelemetry(
          reporter.emitter,
          () => ({ filename: join(dir, 'error.ts') }),
          async () => {
            throw new Error('transform failed');
          }
        )
      ).rejects.toThrow('transform failed');

      await waitFor(() => hasJsonlLines(target, 3));
      expect(readJsonl(target).map((event) => event.root?.status)).toEqual([
        undefined,
        'success',
        'error',
      ]);

      reporter.onDone(dir);
      reporter.onDone(dir);
      await delay(5);
      expect(readJsonl(target)).toHaveLength(3);
    } finally {
      reporter.onDone(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes every root exactly once across the telemetry chunk boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    const reporter = createFileReporter({ dir });
    const target = join(dir, 'pipeline-telemetry.jsonl');
    const suffix = 'x'.repeat(130 * 1024);
    const filenames = [`a-${suffix}`, `b-${suffix}`, `c-${suffix}`];

    try {
      for (const filename of filenames) {
        // Preserve root emission order while exercising the shared writer.
        // eslint-disable-next-line no-await-in-loop
        await runWithPipelineTelemetry(
          reporter.emitter,
          () => ({ filename }),
          async () => undefined
        );
      }

      await waitFor(() => hasJsonlLines(target, 3));
      expect(
        readJsonl(target)
          .slice(1)
          .map((event) => event.root.filename)
      ).toEqual(filenames.slice(0, 2));

      reporter.onDone(dir);
      reporter.onDone(dir);
      await waitFor(() => hasJsonlLines(target, 4));
      expect(
        readJsonl(target)
          .slice(1)
          .map((event) => event.root.filename)
      ).toEqual(filenames);
    } finally {
      reporter.onDone(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes eval file payloads to eval-files.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    const reporter = createFileReporter({ dir });

    try {
      const values = {
        exports: {
          color: {
            serialized: { kind: 'string', value: 'red' },
            status: 'serialized',
          },
        },
      };

      reporter.emitter.single({
        contentBase64: Buffer.from('export const color = "red";').toString(
          'base64'
        ),
        evalSeq: 1,
        hash: 'content-hash',
        id: join(dir, 'theme.ts'),
        importer: null,
        only: ['color'],
        payloadKind: 'code',
        request: null,
        type: 'eval-file',
        valuesBase64: Buffer.from(JSON.stringify(values)).toString('base64'),
      });

      reporter.onDone(dir);

      const target = join(dir, 'eval-files.jsonl');
      await waitFor(() => hasJsonlLines(target, 1));

      const events = readJsonl(target);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(
        expect.objectContaining({
          evalSeq: 1,
          hash: 'content-hash',
          only: ['color'],
          payloadKind: 'code',
          type: 'eval-file',
        })
      );
      expect(events[0].id).toContain('theme.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes perf spans to perf-spans.jsonl without changing actions.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    const reporter = createFileReporter({ dir });

    try {
      const result = reporter.emitter.perf('transform:preeval', () => 42);
      reporter.emitter.action('workflow', '000001:1', '00001#1', () => {});

      reporter.onDone(dir);

      expect(result).toBe(42);

      const perfTarget = join(dir, 'perf-spans.jsonl');
      await waitFor(() => hasJsonlLines(perfTarget, 1));

      const perfEvents = readJsonl(perfTarget);
      expect(perfEvents).toHaveLength(1);
      expect(perfEvents[0]).toEqual(
        expect.objectContaining({
          isAsync: false,
          method: 'transform:preeval',
          spanId: 0,
          status: 'finished',
          type: 'perf-span',
        })
      );
      expect(perfEvents[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(perfEvents[0].finishedAt).toBeGreaterThanOrEqual(
        perfEvents[0].startedAt
      );

      const actionsTarget = join(dir, 'actions.jsonl');
      await waitFor(() => hasJsonlLines(actionsTarget, 2));

      const actionEvents = readJsonl(actionsTarget);
      expect(actionEvents).toEqual([
        expect.objectContaining({
          actionId: 0,
          entrypointRef: '00001#1',
          idx: '000001:1',
          startedAt: expect.any(Number),
          type: 'workflow',
        }),
        expect.objectContaining({
          actionId: 0,
          finishedAt: expect.any(Number),
          isAsync: false,
          result: 'finished',
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records failed and concurrent async perf spans independently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    const reporter = createFileReporter({ dir });

    try {
      await expect(
        reporter.emitter.perf('transform:evalFile', async () => {
          await delay(1);
          throw new Error('eval failed');
        })
      ).rejects.toThrow('eval failed');

      await Promise.all([
        reporter.emitter.perf('transform:preeval', () => delay(2)),
        reporter.emitter.perf('transform:preeval', () => delay(1)),
      ]);

      reporter.onDone(dir);

      const perfTarget = join(dir, 'perf-spans.jsonl');
      await waitFor(() => hasJsonlLines(perfTarget, 3));

      const perfEvents = readJsonl(perfTarget);
      expect(perfEvents).toHaveLength(3);

      expect(perfEvents[0]).toEqual(
        expect.objectContaining({
          isAsync: true,
          method: 'transform:evalFile',
          spanId: 0,
          status: 'failed',
          type: 'perf-span',
        })
      );
      expect(perfEvents[0].error).toBeDefined();

      const preevalSpans = perfEvents.filter(
        (event) => event.method === 'transform:preeval'
      );
      expect(preevalSpans).toHaveLength(2);
      expect(preevalSpans.map((event) => event.spanId).sort()).toEqual([1, 2]);
      expect(preevalSpans.every((event) => event.status === 'finished')).toBe(
        true
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns once and keeps other streams alive when a stream fails to open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    // A directory at the target path makes the async open fail
    // deterministically (EISDIR), like the flaky EINVAL seen in the wild.
    mkdirSync(join(dir, 'eval-files.jsonl'));

    const warnings: unknown[][] = [];
    // eslint-disable-next-line no-console
    const originalWarn = console.warn;
    // eslint-disable-next-line no-console
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const reporter = createFileReporter({ dir });

      await waitFor(() => warnings.length > 0);

      reporter.emitter.single({ evalSeq: 1, type: 'eval-file' });
      reporter.emitter.single({ evalSeq: 2, type: 'eval-file' });

      reporter.emitter.single({
        filename: join(dir, 'foo.ts'),
        phase: 'export',
        reason: 'unsupported-expression',
        status: 'rejected',
        type: 'staticResolve',
      });

      reporter.onDone(dir);

      const target = join(dir, 'static-resolve.jsonl');
      await waitFor(() => hasJsonlLines(target, 1));

      expect(readJsonl(target)).toHaveLength(1);
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0][0])).toContain('eval-files.jsonl');
    } finally {
      // eslint-disable-next-line no-console
      console.warn = originalWarn;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops pipeline telemetry safely when its stream fails to open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    mkdirSync(join(dir, 'pipeline-telemetry.jsonl'));

    const warnings: unknown[][] = [];
    // eslint-disable-next-line no-console
    const originalWarn = console.warn;
    // eslint-disable-next-line no-console
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const reporter = createFileReporter({ dir });
      await waitFor(() => warnings.length > 0);

      await expect(
        runWithPipelineTelemetry(
          reporter.emitter,
          () => ({ filename: join(dir, 'root.ts') }),
          async () => 42
        )
      ).resolves.toBe(42);
      reporter.emitter.single({
        filename: join(dir, 'root.ts'),
        phase: 'export',
        reason: 'unsupported-expression',
        status: 'rejected',
        type: 'staticResolve',
      });

      expect(() => reporter.onDone(dir)).not.toThrow();
      expect(() => reporter.onDone(dir)).not.toThrow();
      const target = join(dir, 'static-resolve.jsonl');
      await waitFor(() => hasJsonlLines(target, 1));

      expect(readJsonl(target)).toHaveLength(1);
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0][0])).toContain('pipeline-telemetry.jsonl');
    } finally {
      // eslint-disable-next-line no-console
      console.warn = originalWarn;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a dummy reporter without evaluating telemetry metadata', async () => {
    const reporter = createFileReporter(false);
    let metadataCalls = 0;

    expect(() =>
      reporter.emitter.single({ type: 'staticResolve' })
    ).not.toThrow();
    await expect(
      runWithPipelineTelemetry(
        reporter.emitter,
        () => {
          metadataCalls += 1;
          return { filename: '/project/root.ts' };
        },
        async () => {
          recordPipelineCacheRequest('entrypoints', 'get', true);
          return 42;
        }
      )
    ).resolves.toBe(42);
    expect(metadataCalls).toBe(0);
    expect(() => reporter.onDone('/')).not.toThrow();
  });
});
