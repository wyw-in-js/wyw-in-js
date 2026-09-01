import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TransformCacheCollection } from '../cache';
import { EventEmitter } from '../utils/EventEmitter';
import {
  beginPipelineCleanup,
  beginPipelineDangerousCode,
  beginPipelineShake,
  finishPipelineCleanup,
  finishPipelineDangerousCode,
  finishPipelineShake,
  getPipelineCodeSha256Hex,
  PIPELINE_TELEMETRY_SCHEMA,
  recordPipelineCacheRequest,
  recordPipelineCacheClear,
  recordPipelineCacheSalt,
  recordPipelineCleanupIteration,
  recordPipelineDisposableRoot,
  recordPipelineEntrypoint,
  recordPipelineLateNoMetadata,
  recordPipelineProcessors,
  recordPipelineUncachedParse,
  registerPipelineTelemetryJSONlReporter,
  registerPipelineTelemetryReporter,
  runWithoutPipelineTelemetry,
  runWithPipelineTelemetry,
  type PipelineTelemetryCompactSummary,
  type PipelineTelemetrySummary,
} from '../debug/pipelineTelemetry';
import {
  getCodeMeasurement,
  measureCode,
  setCodeMeasurement,
} from '../debug/pipelineTelemetry.measurements';
import {
  createAccumulator,
  releaseAccumulator,
} from '../debug/pipelineTelemetry.state';
import type { CodeMeasurementCache } from '../debug/pipelineTelemetry.types';
import { transform } from '../transform';
import { parseFile } from '../transform/Entrypoint.helpers';
import { removeUnusedAfterReplacement } from '../utils/applyOxcProcessors/cleanup-after-replacement';
import { parseOxcCached } from '../utils/parseOxc';

const createEmitter = () =>
  new EventEmitter(
    () => {},
    () => 0,
    () => {}
  );

const revisionOf = (code: string): string =>
  createHash('sha256').update(code).digest('base64url');

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

const runTransform = async (
  root: string,
  filename: string,
  code: string,
  emitter: EventEmitter
) =>
  transform(
    {
      cache: new TransformCacheCollection(),
      eventEmitter: emitter,
      options: {
        filename,
        root,
        pluginOptions: {
          configFile: false,
          tagResolver: (source, tag) =>
            source === 'test-css-processor' && tag === 'css'
              ? processorFile
              : null,
        },
      },
    },
    code,
    async (what) => {
      if (what === 'test-css-processor') {
        return processorFile;
      }

      throw new Error(`Unable to resolve ${JSON.stringify(what)}`);
    }
  );

describe('pipeline telemetry boundary', () => {
  it('reuses the exact SHA-256 digest across cache and telemetry encodings', async () => {
    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );
    const code = 'export const greeting = "γειά 👋";';
    const samples = ['plain ascii', 'nul\0byte', 'emoji 👋', '\ud800'];

    expect(getPipelineCodeSha256Hex(code)).toBeUndefined();
    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/digest.ts' }),
      async () => {
        const cache = new TransformCacheCollection<{
          dependencies: Map<string, { resolved: string | null }>;
          initialCode: string;
        }>();
        [...samples, code].forEach((content, index) => {
          const filename = `/project/digest-${index}.ts`;
          cache.add('entrypoints', filename, {
            dependencies: new Map(),
            initialCode: content,
          });
          expect(getPipelineCodeSha256Hex(content)).toBe(
            createHash('sha256').update(content).digest('hex')
          );
          expect(cache.invalidateIfChanged(filename, content)).toBe(false);
        });
        parseFile(undefined, '/project/digest.ts', code);
      }
    );
    unregister();

    expect(summaries).toHaveLength(1);
    expect(summaries[0].parse.revisions).toEqual([
      expect.objectContaining({
        parsedBytes: Buffer.byteLength(code),
        requestedBytes: Buffer.byteLength(code),
        revision: revisionOf(code),
      }),
    ]);
    expect(getPipelineCodeSha256Hex(code)).toBeUndefined();
  });

  it('keeps distinct revisions that collide in the numeric lookup fingerprint', async () => {
    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );
    const first = 'a111m111z';
    const second = 'a222m222z';

    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/fingerprint.ts' }),
      async () => {
        recordPipelineUncachedParse(
          '/project/first.ts',
          first,
          'module',
          'ts',
          false
        );
        recordPipelineUncachedParse(
          '/project/second.ts',
          second,
          'module',
          'ts',
          false
        );
      }
    );
    unregister();

    expect(summaries[0].parse.revisions).toEqual([
      expect.objectContaining({ revision: revisionOf(first) }),
      expect.objectContaining({ revision: revisionOf(second) }),
    ]);
  });

  it('canonicalizes cached measurements created by different reporters', async () => {
    const code = 'export const shared: number = 1;';
    const firstFilename = '/project/first-shared.ts';
    const secondFilename = '/project/second-shared.ts';

    for (const filename of [firstFilename, secondFilename]) {
      const emitter = createEmitter();
      const unregister = registerPipelineTelemetryReporter(emitter, () => {});
      // Keep the reporter identities and cache warmups deliberately separate.
      // eslint-disable-next-line no-await-in-loop
      await runWithPipelineTelemetry(
        emitter,
        () => ({ filename }),
        async () => parseOxcCached(filename, code, 'module')
      );
      unregister();
    }

    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );
    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/current-root.ts' }),
      async () => {
        parseOxcCached(firstFilename, code, 'module');
        parseOxcCached(secondFilename, code, 'module');
      }
    );
    unregister();

    expect(summaries[0].parse.revisions).toEqual([
      expect.objectContaining({
        cacheHits: 2,
        cacheMisses: 0,
        requests: 2,
        revision: revisionOf(code),
      }),
    ]);
  });

  it('bounds and reuses shared code measurements across roots', () => {
    const cache: CodeMeasurementCache = {
      codeUnits: 0,
      count: 0,
      entries: new Map(),
      evictionKeys: [][Symbol.iterator](),
    };
    cache.evictionKeys = cache.entries.keys();
    const firstAccumulator = createAccumulator('/project/first.ts', cache);
    let oldestCode = '';
    let newestCode = '';
    let newestMeasurement: { bytes: number; revision: string } | undefined;

    for (let index = 0; index < 4_097; index += 1) {
      const code = String.fromCharCode(
        33 + Math.floor(index / 1_024),
        97,
        33 + (Math.floor(index / 32) % 32),
        97,
        33 + (index % 32)
      );
      const measurement = { bytes: 5, revision: `revision-${index}` };
      setCodeMeasurement(firstAccumulator, code, measurement);
      if (index === 0) oldestCode = code;
      if (index === 4_096) {
        newestCode = code;
        newestMeasurement = measurement;
      }
    }
    releaseAccumulator(firstAccumulator);

    expect(cache).toMatchObject({
      codeUnits: 4_096 * 5,
      count: 4_096,
    });
    expect(cache.entries.size).toBe(4_096);

    const secondAccumulator = createAccumulator('/project/second.ts', cache);
    expect(getCodeMeasurement(secondAccumulator, oldestCode)).toBeUndefined();
    expect(getCodeMeasurement(secondAccumulator, newestCode)).toBe(
      newestMeasurement
    );
    const replacement = { bytes: 5, revision: 'replacement' };
    setCodeMeasurement(secondAccumulator, newestCode, replacement);
    expect(getCodeMeasurement(secondAccumulator, newestCode)).toBe(replacement);
    expect(cache).toMatchObject({
      codeUnits: 4_096 * 5,
      count: 4_096,
    });
    releaseAccumulator(secondAccumulator);
  });

  it('upgrades a shared bytes-only measurement without changing retention', () => {
    const entries: CodeMeasurementCache['entries'] = new Map();
    const cache: CodeMeasurementCache = {
      codeUnits: 0,
      count: 0,
      entries,
      evictionKeys: entries.keys(),
    };
    const code = 'same';
    const firstAccumulator = createAccumulator('/project/first.ts', cache);
    setCodeMeasurement(firstAccumulator, code, { bytes: code.length });
    releaseAccumulator(firstAccumulator);

    const secondAccumulator = createAccumulator('/project/second.ts', cache);
    expect(measureCode(secondAccumulator, code).revision).toBe(
      revisionOf(code)
    );
    expect(cache).toMatchObject({
      codeUnits: code.length,
      count: 1,
    });
    expect(cache.entries.size).toBe(1);
    releaseAccumulator(secondAccumulator);
  });

  it('does not evaluate root metadata when no internal reporter is registered', async () => {
    let metadataCalls = 0;

    await expect(
      runWithPipelineTelemetry(
        EventEmitter.dummy,
        () => {
          metadataCalls += 1;
          throw new Error('disabled telemetry evaluated its payload');
        },
        async () => 42
      )
    ).resolves.toBe(42);

    expect(metadataCalls).toBe(0);
  });

  it('keeps transform output and later roots intact when a JSONL sink throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-pipeline-telemetry-'));
    const filename = join(root, 'plain.ts');
    const code = 'export const answer: number = 42;';
    const emitter = createEmitter();
    let throwingSinkCalls = 0;
    const unregisterThrowing = registerPipelineTelemetryJSONlReporter(
      emitter,
      root,
      () => {
        throwingSinkCalls += 1;
        throw new Error('telemetry sink failed');
      }
    );

    try {
      const withoutReporter = await runTransform(
        root,
        filename,
        code,
        createEmitter()
      );
      const withThrowingReporter = await runTransform(
        root,
        filename,
        code,
        emitter
      );
      expect(withThrowingReporter).toEqual(withoutReporter);
      expect(throwingSinkCalls).toBe(1);
      unregisterThrowing();

      const lines: string[] = [];
      const statuses: string[] = [];
      const unregisterWorking = registerPipelineTelemetryJSONlReporter(
        emitter,
        root,
        (line, status) => {
          lines.push(line);
          statuses.push(status);
        }
      );
      await runTransform(root, filename, code, emitter);
      unregisterWorking();

      expect(lines).toHaveLength(1);
      expect(statuses).toEqual(['success']);
      expect(JSON.parse(lines[0])).toMatchObject({
        root: { filename: 'plain.ts', status: 'success' },
      });
    } finally {
      unregisterThrowing();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('flushes a fresh summary after both successful and failed roots', async () => {
    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );

    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/first.ts' }),
      async () => {
        recordPipelineCacheRequest('entrypoints', 'get', true);
      }
    );

    await expect(
      runWithPipelineTelemetry(
        emitter,
        () => ({ filename: '/project/second.ts' }),
        async () => {
          recordPipelineCacheRequest('exports', 'has', false);
          throw new Error('expected failure');
        }
      )
    ).rejects.toThrow('expected failure');

    unregister();

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      cache: {
        requests: 1,
      },
      root: {
        filename: '/project/first.ts',
        status: 'success',
      },
    });
    expect(summaries[1]).toMatchObject({
      cache: {
        requests: 1,
      },
      root: {
        filename: '/project/second.ts',
        status: 'error',
      },
    });
    expect(summaries[0].cache.byOperation).toEqual([
      {
        cache: 'entrypoints',
        hits: 1,
        misses: 0,
        operation: 'get',
        requests: 1,
      },
    ]);
    expect(summaries[1].cache.byOperation).toEqual([
      {
        cache: 'exports',
        hits: 0,
        misses: 1,
        operation: 'has',
        requests: 1,
      },
    ]);
  });

  it('omits empty sections from compact summaries without dropping alternate denominators', async () => {
    const emitter = createEmitter();
    const summaries: PipelineTelemetryCompactSummary[] = [];
    const unregister = registerPipelineTelemetryReporter(
      emitter,
      (summary) => summaries.push(summary),
      true
    );

    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/empty.ts' }),
      async () => {}
    );
    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/salt.ts' }),
      async () => recordPipelineCacheSalt(null, 'salt', 'migrate')
    );
    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/clear.ts' }),
      async () => recordPipelineCacheClear('entrypoints', 'explicit', 0)
    );
    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/disposable.ts' }),
      async () =>
        recordPipelineDisposableRoot('/project/disposable.ts', 'collect')
    );
    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/processors.ts' }),
      async () => recordPipelineProcessors('preeval', false, 3, 2, 1, 1, 4)
    );
    const compactParseCode = 'export const compact: number = 1;';
    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/compact-parse.ts' }),
      async () => {
        parseOxcCached('/project/compact-parse.ts', compactParseCode, 'module');
        parseOxcCached('/project/compact-parse.ts', compactParseCode, 'module');
      }
    );
    unregister();

    expect(summaries[0]).toEqual({
      root: { filename: '/project/empty.ts', status: 'success' },
      schemaVersion: 1,
      type: 'pipeline-telemetry',
    });
    expect(summaries[1]).toEqual(
      expect.objectContaining({
        cache: expect.objectContaining({
          requests: 0,
          salt: {
            calls: 1,
            changes: [{ current: 'salt', outcome: 'migrate', previous: null }],
            clears: 0,
            disables: 0,
            migrations: 1,
            unchanged: 0,
          },
        }),
      })
    );
    expect(summaries[2]).toEqual(
      expect.objectContaining({
        cache: expect.objectContaining({ clearRequests: 1, requests: 0 }),
      })
    );
    expect(summaries[3]).toEqual(
      expect.objectContaining({
        entrypoints: expect.objectContaining({
          disposableRoots: 1,
          requests: 0,
        }),
      })
    );
    expect(summaries[4].processors).toEqual({
      byPhase: [
        {
          definedProcessors: 1,
          importCandidates: 3,
          lookupAttempts: 2,
          lookupHits: 1,
          passes: 1,
          phase: 'preeval',
          reusedPlans: 0,
          usages: 4,
        },
      ],
    });
    expect(summaries[5].parse?.revisions).toEqual([
      {
        bytes: Buffer.byteLength(compactParseCode),
        cacheHits: 1,
        cacheMisses: 1,
        errors: 0,
        jsxFallbackAttempts: 0,
        jsxFallbackRequests: 0,
        kind: 'cached',
        parserAttempts: 1,
        parserKey: 'oxc:module:ts:ts:r1:j0',
        requests: 2,
        revision: revisionOf(compactParseCode),
      },
    ]);
  });

  it('isolates interleaved roots that share one reporter', async () => {
    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondBarrier = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const firstCode = 'export const first: number = 1;';
    const secondCode = 'export const second: number = 2;';

    const first = runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/a.ts' }),
      async () => {
        recordPipelineCacheRequest('entrypoints', 'get', true);
        parseFile(undefined, '/project/a.ts', firstCode);
        releaseSecond();
        await firstBarrier;
        recordPipelineCacheRequest('entrypoints', 'get', false);
      }
    );
    const second = runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/b.ts' }),
      async () => {
        await secondBarrier;
        recordPipelineCacheRequest('exports', 'has', false);
        parseFile(undefined, '/project/b.ts', secondCode);
        releaseFirst();
      }
    );

    await Promise.all([first, second]);
    unregister();

    const byFilename = new Map(
      summaries.map((summary) => [summary.root.filename, summary])
    );
    expect(byFilename.get('/project/a.ts')?.cache).toMatchObject({
      hits: 1,
      misses: 1,
      requests: 2,
    });
    expect(byFilename.get('/project/b.ts')?.cache).toMatchObject({
      hits: 0,
      misses: 1,
      requests: 1,
    });
    expect(byFilename.get('/project/a.ts')?.parse.revisions).toEqual([
      expect.objectContaining({
        requests: 1,
        revision: revisionOf(firstCode),
      }),
    ]);
    expect(byFilename.get('/project/b.ts')?.parse.revisions).toEqual([
      expect.objectContaining({
        requests: 1,
        revision: revisionOf(secondCode),
      }),
    ]);
  });

  it('accounts for cached, fallback, and uncached parser work by exact revision', async () => {
    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );
    const plainFilename = '/project/pipeline-telemetry-unicode.ts';
    const plainCode = "export const message: string = '🙂';";
    const jsxFilename = '/project/pipeline-telemetry-fallback.js';
    const jsxCode = 'export const element = <span>🙂</span>;';
    const uncachedFilename = '/project/pipeline-telemetry-uncached.ts';
    const uncachedCode = "export const direct: string = '🚀';";

    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: plainFilename }),
      async () => {
        parseOxcCached(plainFilename, plainCode, 'module');
        parseOxcCached(plainFilename, plainCode, 'module');
        parseOxcCached(jsxFilename, jsxCode, 'unambiguous');
        parseOxcCached(jsxFilename, jsxCode, 'unambiguous');
        parseFile(undefined, uncachedFilename, uncachedCode);
      }
    );
    unregister();

    expect(summaries).toHaveLength(1);
    const [summary] = summaries;
    const plainRevision = summary.parse.revisions.find(
      ({ revision }) => revision === revisionOf(plainCode)
    );
    const jsxRevision = summary.parse.revisions.find(
      ({ revision }) => revision === revisionOf(jsxCode)
    );
    const uncachedRevision = summary.parse.revisions.find(
      ({ revision }) => revision === revisionOf(uncachedCode)
    );
    const plainBytes = Buffer.byteLength(plainCode);
    const jsxBytes = Buffer.byteLength(jsxCode);
    const uncachedBytes = Buffer.byteLength(uncachedCode);

    expect(summary.parse).toMatchObject({
      allRequests: 5,
      cacheHits: 2,
      cacheMisses: 2,
      cachedRequests: 4,
      errors: 0,
      jsxFallbackAttempts: 1,
      jsxFallbackRequests: 2,
      parserAttempts: 4,
      requestedBytes: plainBytes * 2 + jsxBytes * 2 + uncachedBytes,
      uncachedRequests: 1,
    });
    expect(summary.parse.allRequests).toBe(
      summary.parse.cachedRequests + summary.parse.uncachedRequests
    );
    expect(summary.parse.cachedRequests).toBe(
      summary.parse.cacheHits + summary.parse.cacheMisses
    );
    expect(plainRevision).toEqual({
      cacheHits: 1,
      cacheMisses: 1,
      errors: 0,
      jsxFallbackAttempts: 0,
      jsxFallbackRequests: 0,
      kind: 'cached',
      parsedBytes: plainBytes,
      parserAttempts: 1,
      parserKey: 'oxc:module:ts:ts:r1:j0',
      requestedBytes: plainBytes * 2,
      requests: 2,
      revision: revisionOf(plainCode),
    });
    expect(jsxRevision).toEqual({
      cacheHits: 1,
      cacheMisses: 1,
      errors: 0,
      jsxFallbackAttempts: 1,
      jsxFallbackRequests: 2,
      kind: 'cached',
      parsedBytes: jsxBytes * 2,
      parserAttempts: 2,
      parserKey: 'oxc:unambiguous:js:js:r1:j1',
      requestedBytes: jsxBytes * 2,
      requests: 2,
      revision: revisionOf(jsxCode),
    });
    expect(uncachedRevision).toEqual({
      cacheHits: 0,
      cacheMisses: 0,
      errors: 0,
      jsxFallbackAttempts: 0,
      jsxFallbackRequests: 0,
      kind: 'uncached',
      parsedBytes: uncachedBytes,
      parserAttempts: 1,
      parserKey: 'oxc:module:ts:ts:r1:j0',
      requestedBytes: uncachedBytes,
      requests: 1,
      revision: revisionOf(uncachedCode),
    });
    expect(summary.parse.revisions).toHaveLength(3);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(plainCode);
    expect(serialized).not.toContain(jsxCode);
    expect(serialized).not.toContain(uncachedCode);
  });

  it('attributes shared module-syntax cache entries to each requested source type', async () => {
    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );
    const filename = '/project/pipeline-telemetry-shared-source-type.ts';
    const code = 'export const sharedSourceType: number = 1;';

    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename }),
      async () => {
        parseOxcCached(filename, code, 'module');
        parseOxcCached(filename, code, 'unambiguous');
      }
    );
    unregister();

    expect(summaries).toHaveLength(1);
    expect(
      summaries[0].parse.revisions.map(
        ({ cacheHits, cacheMisses, parserAttempts, parserKey, requests }) => ({
          cacheHits,
          cacheMisses,
          parserAttempts,
          parserKey,
          requests,
        })
      )
    ).toEqual([
      {
        cacheHits: 0,
        cacheMisses: 1,
        parserAttempts: 1,
        parserKey: 'oxc:module:ts:ts:r1:j0',
        requests: 1,
      },
      {
        cacheHits: 1,
        cacheMisses: 0,
        parserAttempts: 0,
        parserKey: 'oxc:unambiguous:ts:ts:r1:j0',
        requests: 1,
      },
    ]);
  });

  it('derives zero attempts for a cached JSX hit warmed outside the root', async () => {
    const filename = '/project/pipeline-telemetry-warm-jsx.js';
    const code = 'export const warmElement = <span>ready</span>;';
    parseOxcCached(filename, code, 'module');

    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );
    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename }),
      async () => {
        parseOxcCached(filename, code, 'module');
      }
    );
    unregister();

    expect(summaries[0].parse).toMatchObject({
      cacheHits: 1,
      cacheMisses: 0,
      jsxFallbackAttempts: 0,
      jsxFallbackRequests: 1,
      parsedBytes: 0,
      parserAttempts: 0,
    });
    expect(summaries[0].parse.revisions).toEqual([
      expect.objectContaining({
        cacheHits: 1,
        cacheMisses: 0,
        jsxFallbackAttempts: 0,
        jsxFallbackRequests: 1,
        parsedBytes: 0,
        parserAttempts: 0,
        requests: 1,
      }),
    ]);
  });

  it('accounts for cached, direct, and failed JSX fallback parse errors', async () => {
    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );
    const cachedFilename = '/project/pipeline-telemetry-error.js';
    const cachedCode =
      'export const element = <span />; export const broken = ;';
    const directFilename = '/project/pipeline-telemetry-error.ts';
    const directCode = 'export const broken: number = ;';

    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: cachedFilename }),
      async () => {
        expect(() =>
          parseOxcCached(cachedFilename, cachedCode, 'module')
        ).toThrow();
        expect(() =>
          parseFile(undefined, directFilename, directCode)
        ).toThrow();
      }
    );
    unregister();

    expect(summaries).toHaveLength(1);
    expect(summaries[0].parse).toMatchObject({
      allRequests: 2,
      cacheHits: 0,
      cacheMisses: 1,
      cachedRequests: 1,
      errors: 2,
      jsxFallbackAttempts: 1,
      jsxFallbackRequests: 1,
      parserAttempts: 3,
      uncachedRequests: 1,
    });
  });

  it('keys parse revisions by the exact filename-derived Oxc language', async () => {
    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );
    const languageCases = [
      ['/project/x.js', 'js'],
      ['/project/x.jsx', 'jsx'],
      ['/project/x.ts', 'ts'],
      ['/project/x.tsx', 'tsx'],
      ['/project/x.mts', 'ts'],
      ['/project/x.cts', 'ts'],
      ['/project/x.d.ts', 'dts'],
      ['/project/x.d.mts', 'dts'],
      ['/project/x.d.cts', 'dts'],
      ['/project/d.ts', 'ts'],
      ['/project/.d.ts', 'ts'],
      ['/project/index.d.css.ts', 'dts'],
      ['/project/index.d.css.mts', 'ts'],
      ['/project/.d.mts', 'ts'],
      ['/project/X.TS', 'js'],
      ['/project/x.ts?raw', 'js'],
    ] as const;
    const sharedCode = 'export const shared = 1;';

    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/root.ts' }),
      async () => {
        languageCases.forEach(([filename], index) => {
          recordPipelineUncachedParse(
            filename,
            `export const value${index} = ${index};`,
            'module',
            'js',
            false
          );
        });
        recordPipelineUncachedParse(
          '/project/shared.mts',
          sharedCode,
          'module',
          'js',
          false
        );
        recordPipelineUncachedParse(
          '/project/shared.cts',
          sharedCode,
          'module',
          'js',
          false
        );
        recordPipelineUncachedParse(
          '/project/shared.tsx',
          sharedCode,
          'module',
          'js',
          false
        );
        recordPipelineUncachedParse(
          '/project/shared.ts',
          sharedCode,
          'module',
          'ts',
          false
        );
      }
    );
    unregister();

    expect(summaries).toHaveLength(1);
    languageCases.forEach(([, language], index) => {
      const code = `export const value${index} = ${index};`;
      expect(
        summaries[0].parse.revisions.find(
          ({ revision }) => revision === revisionOf(code)
        )?.parserKey
      ).toBe(`oxc:module:${language}:js:r1:j0`);
    });
    expect(
      summaries[0].parse.revisions
        .filter(({ revision }) => revision === revisionOf(sharedCode))
        .map(({ parserKey, requests }) => ({ parserKey, requests }))
    ).toEqual([
      { parserKey: 'oxc:module:ts:js:r1:j0', requests: 2 },
      { parserKey: 'oxc:module:ts:ts:r1:j0', requests: 1 },
      { parserKey: 'oxc:module:tsx:js:r1:j0', requests: 1 },
    ]);
  });

  it('summarizes pipeline recorders with explicit denominator algebra', async () => {
    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );
    const filename = '/project/recorders.ts';
    const cleanupCode = 'const dead = 1;\nconst live = 2;';
    const cleanupEnd = cleanupCode.indexOf('\n');
    const shakeInput = 'export const unused = 1;';
    const shakeOutput = 'export {};';

    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename }),
      async () => {
        recordPipelineEntrypoint(true, true, 'created', ['z', 'a', 'z']);
        recordPipelineEntrypoint(false, false, 'cached', ['*', 'ignored']);
        recordPipelineEntrypoint(false, false, 'loop', ['loop']);
        recordPipelineDisposableRoot(filename, 'preeval');

        recordPipelineProcessors('preeval', false, 3, 2, 1, 1, 4);
        recordPipelineProcessors('collect', true, 2, 1, 1, 2, 3);

        const dangerousToken = beginPipelineDangerousCode(filename);
        finishPipelineDangerousCode(dangerousToken);
        recordPipelineLateNoMetadata(filename, ['z', 'a', 'z'], 'preeval');
        recordPipelineLateNoMetadata(filename, ['a'], 'collect');

        const shakeToken = beginPipelineShake(
          shakeInput,
          ['z', 'a', 'z'],
          'preval'
        );
        finishPipelineShake(shakeToken, shakeOutput, false);

        const cleanupToken = beginPipelineCleanup(filename);
        recordPipelineCleanupIteration(
          cleanupToken,
          cleanupCode,
          [{ start: 0, end: cleanupEnd }],
          true,
          1,
          2,
          3,
          4,
          5,
          6
        );
        finishPipelineCleanup(cleanupToken, 'converged');

        recordPipelineCacheRequest('entrypoints', 'get', true);
        recordPipelineCacheRequest('exports', 'has', false);
        recordPipelineCacheSalt(null, 'first', 'migrate');
        recordPipelineCacheSalt('first', 'first', 'unchanged');
        recordPipelineCacheSalt('first', 'second', 'clear');
        recordPipelineCacheSalt('second', null, 'disable');
        recordPipelineCacheClear('exports', 'salt-change', 3);
      }
    );
    unregister();

    expect(summaries).toHaveLength(1);
    const [summary] = summaries;
    expect(summary.entrypoints).toEqual({
      byOnly: [
        { count: 1, only: ['*'] },
        { count: 1, only: ['a', 'z'] },
        { count: 1, only: ['loop'] },
      ],
      cached: 1,
      children: 2,
      created: 1,
      disposableRoots: 1,
      disposableRootsByPhase: [{ count: 1, phase: 'preeval' }],
      initialRoots: 1,
      loops: 1,
      onDemandRoots: 0,
      requests: 3,
      roots: 1,
    });
    expect(summary.entrypoints.requests).toBe(
      summary.entrypoints.roots + summary.entrypoints.children
    );
    expect(summary.entrypoints.requests).toBe(
      summary.entrypoints.created +
        summary.entrypoints.cached +
        summary.entrypoints.loops
    );
    expect(summary.processors).toEqual({
      byPhase: [
        {
          definedProcessors: 2,
          importCandidates: 2,
          lookupAttempts: 1,
          lookupHits: 1,
          passes: 1,
          phase: 'collect',
          reusedPlans: 1,
          usages: 3,
        },
        {
          definedProcessors: 1,
          importCandidates: 3,
          lookupAttempts: 2,
          lookupHits: 1,
          passes: 1,
          phase: 'preeval',
          reusedPlans: 0,
          usages: 4,
        },
      ],
      totals: {
        definedProcessors: 3,
        importCandidates: 5,
        lookupAttempts: 3,
        lookupHits: 2,
        passes: 2,
        reusedPlans: 1,
        usages: 7,
      },
    });
    expect(summary.lateNoMetadata).toEqual({
      count: 2,
      dangerousCodeCalls: 1,
      dangerousCodeMs: expect.any(Number),
      events: [
        {
          filename,
          only: ['a'],
          phase: 'collect',
        },
        {
          filename,
          only: ['a', 'z'],
          phase: 'preeval',
        },
      ],
    });
    expect(summary.lateNoMetadata.dangerousCodeMs).toBeGreaterThanOrEqual(0);
    expect(summary.shakes).toEqual({
      attempts: 1,
      calls: [
        {
          error: false,
          generatedBytes: Buffer.byteLength(shakeOutput),
          inputBytes: Buffer.byteLength(shakeInput),
          inputRevision: revisionOf(shakeInput),
          mode: 'preval',
          only: ['a', 'z'],
          outputRevision: revisionOf(shakeOutput),
        },
      ],
      errors: 0,
      generatedBytes: Buffer.byteLength(shakeOutput),
      successes: 1,
    });
    expect(summary.shakes.attempts).toBe(
      summary.shakes.successes + summary.shakes.errors
    );
    const removedBytes = Buffer.byteLength(cleanupCode.slice(0, cleanupEnd));
    expect(summary.cleanup).toEqual({
      attemptedBytes: removedBytes,
      attemptedIterations: 1,
      attemptedRanges: 1,
      calls: 1,
      candidateRemovals: {
        emptyBlocks: 6,
        expressions: 5,
        generatedHelpers: 3,
        imports: 4,
        scopedDeclarations: 1,
        topLevelDeclarations: 2,
      },
      capHits: 0,
      committedBytes: removedBytes,
      committedIterations: 1,
      committedRanges: 1,
      converged: 1,
      errors: 0,
      rollbackBytes: 0,
      rollbacks: 0,
      stalled: 0,
    });
    expect(summary.cleanup.calls).toBe(
      summary.cleanup.converged +
        summary.cleanup.rollbacks +
        summary.cleanup.capHits +
        summary.cleanup.stalled +
        summary.cleanup.errors
    );
    expect(summary.cache).toMatchObject({
      clearEntries: 3,
      clearReasons: [
        {
          cache: 'exports',
          entries: 3,
          reason: 'salt-change',
          requests: 1,
        },
      ],
      clearRequests: 1,
      hits: 1,
      misses: 1,
      requests: 2,
      salt: {
        calls: 4,
        changes: [
          { current: 'first', outcome: 'migrate', previous: null },
          { current: 'second', outcome: 'clear', previous: 'first' },
          { current: null, outcome: 'disable', previous: 'second' },
        ],
        clears: 1,
        disables: 1,
        migrations: 1,
        unchanged: 1,
      },
    });
    expect(summary.cache.requests).toBe(
      summary.cache.hits + summary.cache.misses
    );
    expect(PIPELINE_TELEMETRY_SCHEMA.denominators).toEqual({
      cache:
        'requests = get requests + has requests; each byOperation bucket has requests = hits + misses; salt.calls counts setKeySalt decisions, while salt.changes retains only transitions; clearRequests counts primary-cache clear/invalidate operations and clearEntries counts entries present before them',
      cleanup:
        'calls are cleanup invocations; attemptedIterations are loop bodies and committedIterations are candidate revisions accepted after parse; candidateRemovals are raw pre-merge ranges by collector and can overlap, while attempted/committed ranges and bytes use merged ranges; outcomes partition calls',
      entrypoints:
        'requests are completed Entrypoint.innerCreate decisions; requests = roots + children = created + cached + loops; byOnly counts the effective merged entrypoint.only list; initialRoots means a root request with loadedCode, while onDemandRoots has no loadedCode; disposable roots are events rather than unique filenames; calls that throw before a decision are not counted',
      lateNoMetadata:
        'count is late no-metadata short-circuit events; events retain each phase/only occurrence, while dangerousCodeCalls and dangerousCodeMs include each distinct affected filename once',
      parse:
        'allRequests = cachedRequests + uncachedRequests; cachedRequests = cacheHits + cacheMisses; every miss or uncached request has one primary parse and at most one JSX fallback, so parserAttempts are derived as cacheMisses + jsxFallbackAttempts for cached revisions and requests + jsxFallbackAttempts for uncached revisions; requestedBytes count each logical request input, parsedBytes count input bytes per physical parseSync attempt, errors count failed logical requests, and JSX fallback requests/attempts separate logical need from physical fallback parses; compact revision records store source bytes once',
      processors:
        'passes are applyOxcProcessors invocations that reach a recorded import/usage analysis result; lookupAttempts exclude side-effect imports and candidates without a local binding; reused plans skip import lookup but still count usages',
      shakes:
        'attempts are core prepareOxcCodeImpl shake calls; attempts = successes + errors',
    });
  });

  it('partitions unexpected cleanup failures into the error outcome', async () => {
    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );
    const filename = '/project/cleanup-error.ts';

    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename }),
      async () => {
        expect(() =>
          removeUnusedAfterReplacement(
            'export const broken = ;',
            filename,
            new Set(),
            new Set(),
            new Set()
          )
        ).toThrow();
      }
    );
    unregister();

    expect(summaries).toHaveLength(1);
    expect(summaries[0].cleanup).toMatchObject({
      calls: 1,
      capHits: 0,
      converged: 0,
      errors: 1,
      rollbacks: 0,
      stalled: 0,
    });
  });

  it('restores the parent root after a nested telemetry root completes', async () => {
    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );

    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/outer.ts' }),
      async () => {
        recordPipelineCacheRequest('entrypoints', 'get', true);
        await runWithPipelineTelemetry(
          emitter,
          () => ({ filename: '/project/inner.ts' }),
          async () => {
            recordPipelineCacheRequest('exports', 'has', false);
          }
        );
        recordPipelineCacheRequest('entrypoints', 'get', false);
      }
    );
    unregister();

    const byFilename = new Map(
      summaries.map((summary) => [summary.root.filename, summary])
    );
    expect(byFilename.get('/project/outer.ts')?.cache).toMatchObject({
      hits: 1,
      misses: 1,
      requests: 2,
    });
    expect(byFilename.get('/project/inner.ts')?.cache).toMatchObject({
      hits: 0,
      misses: 1,
      requests: 1,
    });
  });

  it('does not attribute work from an unregistered nested transform boundary', async () => {
    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );

    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/outer.ts' }),
      async () => {
        recordPipelineCacheRequest('entrypoints', 'get', true);
        await runWithoutPipelineTelemetry(async () => {
          recordPipelineCacheRequest('exports', 'has', false);
        });
        recordPipelineCacheRequest('entrypoints', 'get', false);
      }
    );
    unregister();

    expect(summaries).toHaveLength(1);
    expect(summaries[0].cache).toMatchObject({
      hits: 1,
      misses: 1,
      requests: 2,
    });
    expect(summaries[0].cache.byOperation).toEqual([
      {
        cache: 'entrypoints',
        hits: 1,
        misses: 1,
        operation: 'get',
        requests: 2,
      },
    ]);
  });

  it('ignores detached work from a flushed root while another root is active', async () => {
    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );
    let releaseDetached!: () => void;
    const detachedBarrier = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detachedWork!: Promise<void>;

    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/flushed.ts' }),
      async () => {
        recordPipelineCacheRequest('entrypoints', 'get', true);
        recordPipelineCacheSalt(null, 'old-root', 'migrate');
        detachedWork = detachedBarrier.then(() => {
          recordPipelineCacheRequest('exports', 'has', false);
          recordPipelineCacheSalt('old-root', 'late-write', 'clear');
        });
      }
    );

    await runWithPipelineTelemetry(
      emitter,
      () => ({ filename: '/project/current.ts' }),
      async () => {
        releaseDetached();
        await detachedWork;
        recordPipelineCacheRequest('exports', 'get', true);
      }
    );
    unregister();

    const byFilename = new Map(
      summaries.map((summary) => [summary.root.filename, summary])
    );
    expect(byFilename.get('/project/flushed.ts')?.cache).toMatchObject({
      requests: 1,
      salt: { calls: 1 },
    });
    expect(byFilename.get('/project/current.ts')?.cache).toMatchObject({
      requests: 1,
      salt: { calls: 0 },
    });
  });

  it('flushes an error summary when option setup fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-pipeline-telemetry-'));
    const filename = join(root, 'invalid-options.ts');
    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );

    try {
      await expect(
        transform(
          {
            eventEmitter: emitter,
            options: {
              filename,
              root,
              pluginOptions: {
                configFile: false,
                eval: { resolver: 'invalid' } as never,
              },
            },
          },
          'export const value = 1;',
          async () => null
        )
      ).rejects.toThrow('Unsupported eval.resolver');
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        root: { filename, status: 'error' },
      });
      expect(summaries[0].entrypoints.requests).toBe(0);
      expect(summaries[0].parse.allRequests).toBe(0);
    } finally {
      unregister();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('collects stage counters from a real transform without metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-pipeline-telemetry-'));
    const filename = join(root, 'plain.ts');
    const code = 'export const answer: number = 42;';
    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );

    try {
      const result = await runTransform(root, filename, code, emitter);

      expect(result).toMatchObject({ code });
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        entrypoints: {
          children: 0,
          created: 1,
          disposableRoots: 1,
          initialRoots: 1,
          requests: 1,
          roots: 1,
        },
        lateNoMetadata: { count: 1, dangerousCodeCalls: 1 },
        root: { filename, status: 'success' },
        shakes: { attempts: 0, errors: 0, successes: 0 },
      });
      expect(
        summaries[0].lateNoMetadata.dangerousCodeMs
      ).toBeGreaterThanOrEqual(0);
      expect(summaries[0].parse.cachedRequests).toBeGreaterThan(0);
      expect(summaries[0].parse.errors).toBe(0);
      expect(summaries[0].processors.byPhase).toEqual([
        expect.objectContaining({
          importCandidates: 0,
          lookupAttempts: 0,
          passes: 1,
          phase: 'preeval',
          usages: 0,
        }),
      ]);
      expect(summaries[0].cache.salt).toMatchObject({
        calls: 1,
        migrations: 1,
      });
    } finally {
      unregister();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('collects processor, shaker, and cleanup counters from a real transform', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-pipeline-telemetry-'));
    const filename = join(root, 'styles.ts');
    const code = [
      "import { css } from 'test-css-processor';",
      'export const red = css`color: red;`;',
      'export const blue = css`color: blue;`;',
    ].join('\n');
    const emitter = createEmitter();
    const summaries: PipelineTelemetrySummary[] = [];
    const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
      summaries.push(summary)
    );

    try {
      const result = await runTransform(root, filename, code, emitter);

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).toContain('color:blue');
      expect(summaries).toHaveLength(1);
      expect(summaries[0].root).toEqual({ filename, status: 'success' });
      expect(summaries[0].processors.byPhase).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            importCandidates: 1,
            lookupAttempts: 1,
            lookupHits: 1,
            phase: 'preeval',
            usages: 2,
          }),
          expect.objectContaining({
            definedProcessors: 0,
            importCandidates: 0,
            lookupAttempts: 0,
            lookupHits: 0,
            phase: 'collect',
            reusedPlans: 1,
            usages: 2,
          }),
        ])
      );
      expect(summaries[0].shakes).toMatchObject({
        errors: 0,
      });
      expect(summaries[0].shakes.attempts).toBeGreaterThan(0);
      expect(summaries[0].shakes.successes).toBe(summaries[0].shakes.attempts);
      expect(summaries[0].shakes.generatedBytes).toBeGreaterThan(0);
      expect(summaries[0].cleanup.calls).toBeGreaterThan(0);
      expect(summaries[0].cleanup.calls).toBe(
        summaries[0].cleanup.converged +
          summaries[0].cleanup.rollbacks +
          summaries[0].cleanup.capHits +
          summaries[0].cleanup.stalled +
          summaries[0].cleanup.errors
      );
    } finally {
      unregister();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
