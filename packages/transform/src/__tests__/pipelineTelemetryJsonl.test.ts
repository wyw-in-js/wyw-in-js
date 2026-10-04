/* eslint-disable no-bitwise */
import path from 'path';

import { serializePipelineTelemetryJSONl } from '../debug/pipelineTelemetry.jsonl';
import { getPipelineParserAttempts } from '../debug/pipelineTelemetry.parse';
import { PIPELINE_TELEMETRY_SCHEMA } from '../debug/pipelineTelemetry.schema';
import { buildCompactPipelineTelemetrySummary } from '../debug/pipelineTelemetry.summary';
import type {
  ParseRevisionCounter,
  PipelineAccumulator,
} from '../debug/pipelineTelemetry.types';

const WORKING_DIR = path.join(
  path.parse(process.cwd()).root,
  'pipeline-telemetry-project'
);
const ROOT_FILENAME = path.join(WORKING_DIR, 'src', 'root.ts');

const serializeLegacyPipelineTelemetryJSONl = (
  accumulator: PipelineAccumulator,
  workingDir: string
): string => {
  const summary = buildCompactPipelineTelemetrySummary(accumulator);
  const { root } = summary;
  const { filename: rootFilename } = root;
  const serialized = JSON.stringify(
    summary,
    function legacyPipelineReplacer(
      this: unknown,
      key,
      value: unknown
    ): unknown {
      if (typeof value === 'number') {
        if (value === 0 || (key === 'passes' && value === 1)) return undefined;
        return value;
      }
      if (value === false) return undefined;
      if (typeof value !== 'string') return value;
      if (key === 'kind' && value === 'cached') return undefined;
      if (key === 'filename') {
        if (this !== root && value === rootFilename) return undefined;
        return path.isAbsolute(value)
          ? path.relative(workingDir, value)
          : value;
      }
      return value;
    }
  );
  return `${serialized}\n`;
};

type JSONRecord = Record<string, unknown>;

const CACHE_NAMES = ['barrelManifests', 'entrypoints', 'exports'] as const;
const CACHE_OPERATION_NAMES = ['get', 'has'] as const;
const PARSER_KEYS = [
  'oxc:module:js:js:r1:j0',
  'oxc:module:js:js:r1:j1',
  'oxc:module:js:ts:r1:j0',
  'oxc:module:js:ts:r1:j1',
  'oxc:module:jsx:js:r1:j0',
  'oxc:module:jsx:js:r1:j1',
  'oxc:module:jsx:ts:r1:j0',
  'oxc:module:jsx:ts:r1:j1',
  'oxc:module:ts:js:r1:j0',
  'oxc:module:ts:js:r1:j1',
  'oxc:module:ts:ts:r1:j0',
  'oxc:module:ts:ts:r1:j1',
  'oxc:module:tsx:js:r1:j0',
  'oxc:module:tsx:js:r1:j1',
  'oxc:module:tsx:ts:r1:j0',
  'oxc:module:tsx:ts:r1:j1',
  'oxc:module:dts:js:r1:j0',
  'oxc:module:dts:js:r1:j1',
  'oxc:module:dts:ts:r1:j0',
  'oxc:module:dts:ts:r1:j1',
  'oxc:unambiguous:js:js:r1:j0',
  'oxc:unambiguous:js:js:r1:j1',
  'oxc:unambiguous:js:ts:r1:j0',
  'oxc:unambiguous:js:ts:r1:j1',
  'oxc:unambiguous:jsx:js:r1:j0',
  'oxc:unambiguous:jsx:js:r1:j1',
  'oxc:unambiguous:jsx:ts:r1:j0',
  'oxc:unambiguous:jsx:ts:r1:j1',
  'oxc:unambiguous:ts:js:r1:j0',
  'oxc:unambiguous:ts:js:r1:j1',
  'oxc:unambiguous:ts:ts:r1:j0',
  'oxc:unambiguous:ts:ts:r1:j1',
  'oxc:unambiguous:tsx:js:r1:j0',
  'oxc:unambiguous:tsx:js:r1:j1',
  'oxc:unambiguous:tsx:ts:r1:j0',
  'oxc:unambiguous:tsx:ts:r1:j1',
  'oxc:unambiguous:dts:js:r1:j0',
  'oxc:unambiguous:dts:js:r1:j1',
  'oxc:unambiguous:dts:ts:r1:j0',
  'oxc:unambiguous:dts:ts:r1:j1',
] as const;

const stripLegacyDefaults = (value: JSONRecord): JSONRecord =>
  JSON.parse(
    JSON.stringify(value, (key, nestedValue: unknown): unknown => {
      if (typeof nestedValue === 'number') {
        if (nestedValue === 0 || (key === 'passes' && nestedValue === 1)) {
          return undefined;
        }
      }
      if (nestedValue === false) return undefined;
      if (key === 'kind' && nestedValue === 'cached') return undefined;
      return nestedValue;
    })
  );

const decodePipelineTelemetryJSONl = (line: string): JSONRecord => {
  const wire = JSON.parse(line) as JSONRecord;
  const result: JSONRecord = {
    root: wire.root,
    schemaVersion: wire.schemaVersion,
    type: wire.type,
  };

  if (wire.cache) {
    const [
      requests,
      hits,
      misses,
      clearRequests,
      clearEntries,
      rawSalt,
      rawByOperation,
      rawClearReasons,
    ] = wire.cache as unknown[];
    const [calls, clears, disables, migrations, unchanged, changes] =
      rawSalt as unknown[];
    result.cache = {
      byOperation: (rawByOperation as unknown[][]).map(
        ([
          cacheId,
          operationId,
          operationHits,
          operationMisses,
          operationRequests,
        ]) => ({
          cache: CACHE_NAMES[cacheId as number],
          operation: CACHE_OPERATION_NAMES[operationId as number],
          hits: operationHits,
          misses: operationMisses,
          requests: operationRequests,
        })
      ),
      clearEntries,
      clearReasons: (rawClearReasons as unknown[][]).map(
        ([cacheId, reason, entries, reasonRequests]) => ({
          cache: CACHE_NAMES[cacheId as number],
          entries,
          reason,
          requests: reasonRequests,
        })
      ),
      clearRequests,
      hits,
      misses,
      requests,
      salt: { calls, changes, clears, disables, migrations, unchanged },
    };
  }

  if (wire.cleanup) {
    const [
      calls,
      attemptedIterations,
      attemptedRanges,
      attemptedBytes,
      committedIterations,
      committedRanges,
      committedBytes,
      rollbackBytes,
      rawRemovals,
      converged,
      rollbacks,
      capHits,
      stalled,
      errors,
    ] = wire.cleanup as unknown[];
    const [
      emptyBlocks,
      expressions,
      generatedHelpers,
      imports,
      scopedDeclarations,
      topLevelDeclarations,
    ] = rawRemovals as unknown[];
    result.cleanup = {
      calls,
      candidateRemovals: {
        emptyBlocks,
        expressions,
        generatedHelpers,
        imports,
        scopedDeclarations,
        topLevelDeclarations,
      },
      capHits,
      committedBytes,
      committedIterations,
      committedRanges,
      converged,
      errors,
      rollbackBytes,
      rollbacks,
      stalled,
      attemptedBytes,
      attemptedIterations,
      attemptedRanges,
    };
  }

  if (wire.entrypoints) {
    const [
      requests,
      roots,
      children,
      created,
      cached,
      loops,
      initialRoots,
      onDemandRoots,
      disposableRoots,
      rawByOnly,
      rawDisposableRootsByPhase,
    ] = wire.entrypoints as unknown[];
    result.entrypoints = {
      byOnly: (rawByOnly as unknown[][]).map(([only, count]) => ({
        count,
        only,
      })),
      cached,
      children,
      created,
      disposableRoots,
      disposableRootsByPhase: (rawDisposableRootsByPhase as unknown[][]).map(
        ([phase, count]) => ({ count, phase })
      ),
      initialRoots,
      loops,
      onDemandRoots,
      requests,
      roots,
    };
  }

  if (wire.lateNoMetadata) {
    const [count, dangerousCodeCalls, dangerousCodeMs, rawEvents] =
      wire.lateNoMetadata as unknown[];
    result.lateNoMetadata = {
      count,
      dangerousCodeCalls,
      dangerousCodeMs,
      events: (rawEvents as unknown[][]).map(([phase, only, filename]) => {
        const event: JSONRecord = { only, phase };
        if (filename !== undefined) event.filename = filename;
        return event;
      }),
    };
  }

  if (wire.parse) {
    const [rawTotals, rawRevisions] = wire.parse as unknown[][];
    const [
      allRequests,
      cachedRequests,
      uncachedRequests,
      cacheHits,
      cacheMisses,
      parserAttempts,
      requestedBytes,
      parsedBytes,
      errors,
      jsxFallbackRequests,
      jsxFallbackAttempts,
      rawTransferFallbackAttempts,
    ] = rawTotals;
    result.parse = {
      allRequests,
      cacheHits,
      cacheMisses,
      cachedRequests,
      errors,
      jsxFallbackAttempts,
      jsxFallbackRequests,
      parsedBytes,
      parserAttempts,
      requestedBytes,
      rawTransferFallbackAttempts,
      uncachedRequests,
      revisions: rawRevisions.map(
        ([revision, rawParserKey, bytes, requests, rawMask, ...values]) => {
          const mask = rawMask as number;
          let cursor = 0;
          const counter: JSONRecord = {
            bytes,
            cacheHits: 0,
            cacheMisses: 0,
            errors: 0,
            jsxFallbackAttempts: 0,
            jsxFallbackRequests: 0,
            rawTransferFallbackAttempts: 0,
            kind: 'cached',
            parserKey:
              typeof rawParserKey === 'number'
                ? PARSER_KEYS[rawParserKey]
                : rawParserKey,
            requests,
            revision,
          };
          if (mask & 1) {
            counter.kind = values[cursor];
            cursor += 1;
          }
          const maskedCounters = [
            [2, 'cacheHits'],
            [4, 'cacheMisses'],
            [8, 'errors'],
            [16, 'jsxFallbackRequests'],
            [32, 'jsxFallbackAttempts'],
            [64, 'rawTransferFallbackAttempts'],
          ] as const;
          maskedCounters.forEach(([bit, key]) => {
            if (mask & bit) {
              counter[key] = values[cursor];
              cursor += 1;
            }
          });
          counter.parserAttempts =
            Number(counter.kind === 'cached' ? counter.cacheMisses : requests) +
            Number(counter.jsxFallbackAttempts) +
            Number(counter.rawTransferFallbackAttempts);
          return counter;
        }
      ),
    };
  }

  if (wire.processors) {
    result.processors = {
      byPhase: (wire.processors as unknown[][]).map(
        ([phase, rawMask, ...values]) => {
          const mask = rawMask as number;
          let cursor = 0;
          const counter: JSONRecord = {
            definedProcessors: 0,
            importCandidates: 0,
            lookupAttempts: 0,
            lookupHits: 0,
            passes: 1,
            reusedPlans: 0,
            usages: 0,
          };
          const maskedCounters = [
            [1, 'definedProcessors'],
            [2, 'importCandidates'],
            [4, 'lookupAttempts'],
            [8, 'lookupHits'],
            [16, 'passes'],
            [32, 'reusedPlans'],
            [64, 'usages'],
          ] as const;
          maskedCounters.forEach(([bit, key]) => {
            if (mask & bit) {
              counter[key] = values[cursor];
              cursor += 1;
            }
          });
          counter.phase = phase;
          return counter;
        }
      ),
    };
  }

  if (wire.shakes) {
    const [attempts, successes, errors, generatedBytes, rawCalls] =
      wire.shakes as unknown[];
    result.shakes = {
      attempts,
      calls: (rawCalls as unknown[][]).map(
        ([
          inputRevision,
          mode,
          only,
          outputRevision,
          inputBytes,
          rawMask,
          ...values
        ]) => {
          const mask = rawMask as number;
          const call: JSONRecord = {
            error: (mask & 1) !== 0,
            generatedBytes: 0,
            inputBytes,
            inputRevision,
            mode,
            only,
            outputRevision,
          };
          if (mask & 2) {
            [call.generatedBytes] = values;
          }
          return call;
        }
      ),
      errors,
      generatedBytes,
      successes,
    };
  }

  return stripLegacyDefaults(result);
};

const createAccumulator = (
  filename: string = ROOT_FILENAME
): PipelineAccumulator => ({
  cache: {
    byOperation: new Array(6),
    clearReasons: new Map(),
    salt: {
      changes: [],
      unchanged: 0,
    },
  },
  cleanup: {
    calls: 0,
    candidateRemovals: {
      emptyBlocks: 0,
      expressions: 0,
      generatedHelpers: 0,
      imports: 0,
      scopedDeclarations: 0,
      topLevelDeclarations: 0,
    },
    capHits: 0,
    committedBytes: 0,
    committedIterations: 0,
    committedRanges: 0,
    converged: 0,
    errors: 0,
    rollbackBytes: 0,
    rollbacks: 0,
    stalled: 0,
    attemptedBytes: 0,
    attemptedIterations: 0,
    attemptedRanges: 0,
  },
  codeMeasurements: {
    codeUnits: 0,
    count: 0,
    entries: new Map(),
    evictionKeys: [][Symbol.iterator](),
  },
  closed: false,
  dangerousByFile: new Map(),
  entrypoints: {
    byOnly: new Map(),
    cached: 0,
    children: 0,
    created: 0,
    disposableRootsByPhase: new Map(),
    initialRoots: 0,
    loops: 0,
    roots: 0,
  },
  lateNoMetadata: [],
  lastCode: undefined,
  lastMeasurement: undefined,
  lastSharedMissCode: undefined,
  localCodeMeasurements: new Map(),
  onlyNormalizations: new Map(),
  parse: {
    cachedRevisions: new WeakMap<object, ParseRevisionCounter>(),
    revisionBuckets: new Map(),
    revisions: [],
  },
  processors: {
    byPhase: new Map(),
  },
  root: {
    filename,
    status: 'success',
  },
  shakes: {
    attempts: 0,
    calls: [],
    errors: 0,
    generatedBytes: 0,
    successes: 0,
  },
});

const createFullAccumulator = (): PipelineAccumulator => {
  const rootFilename = path.join(WORKING_DIR, 'src', 'root "🔥\ud800".tsx');
  const otherFilename = path.join(WORKING_DIR, 'src', 'other\nfile.ts');
  const accumulator = createAccumulator(rootFilename);

  accumulator.root.status = 'soft-error';
  accumulator.cache.byOperation[5] = { hits: 0, misses: 2, requests: 2 };
  accumulator.cache.byOperation[0] = { hits: 1, misses: 0, requests: 1 };
  accumulator.cache.clearReasons.set('z', {
    cache: 'exports',
    entries: 3,
    reason: 'z-reason\n🔥',
    requests: 1,
  });
  accumulator.cache.clearReasons.set('a', {
    cache: 'entrypoints',
    entries: 0,
    reason: 'a-reason\ud800',
    requests: 2,
  });
  accumulator.cache.salt.changes.push(
    { current: 'one', outcome: 'migrate', previous: null },
    { current: null, outcome: 'disable', previous: 'one' }
  );
  accumulator.cache.salt.unchanged = 1;

  Object.assign(accumulator.cleanup, {
    attemptedBytes: 21,
    attemptedIterations: 4,
    attemptedRanges: 6,
    calls: 2,
    capHits: 1,
    committedBytes: 13,
    committedIterations: 2,
    committedRanges: 3,
    converged: 1,
    errors: 0,
    rollbackBytes: 8,
    rollbacks: 1,
    stalled: 0,
  });
  Object.assign(accumulator.cleanup.candidateRemovals, {
    emptyBlocks: 6,
    expressions: 5,
    generatedHelpers: 3,
    imports: 4,
    scopedDeclarations: 1,
    topLevelDeclarations: 2,
  });

  accumulator.dangerousByFile.set(rootFilename, {
    calls: 1,
    durationMs: 0.1,
  });
  accumulator.dangerousByFile.set(otherFilename, {
    calls: 2,
    durationMs: 0.2,
  });

  accumulator.entrypoints.byOnly.set('z', {
    count: 2,
    only: ['z', 'quote"', '🔥', '\ud800'],
  });
  accumulator.entrypoints.byOnly.set('a', { count: 1, only: [] });
  accumulator.entrypoints.cached = 1;
  accumulator.entrypoints.children = 1;
  accumulator.entrypoints.created = 2;
  accumulator.entrypoints.disposableRootsByPhase.set('preeval', 1);
  accumulator.entrypoints.disposableRootsByPhase.set('collect', 0);
  accumulator.entrypoints.initialRoots = 1;
  accumulator.entrypoints.roots = 2;

  accumulator.lateNoMetadata.push(
    { filename: rootFilename, only: ['z', '\ud800'], phase: 'preeval' },
    { filename: otherFilename, only: ['a', '🔥'], phase: 'collect' },
    { filename: rootFilename, only: [], phase: 'collect' }
  );

  accumulator.parse.revisions.push(
    {
      bytes: 31,
      cacheHits: 1,
      cacheMisses: 1,
      errors: 0,
      jsxFallbackAttempts: 0,
      jsxFallbackRequests: 1,
      rawTransferFallbackAttempts: 0,
      kind: 'cached',
      parserKey: 'z-parser\n🔥',
      requests: 2,
      revision: 'z-revision\ud800',
    },
    {
      bytes: 47,
      cacheHits: 0,
      cacheMisses: 0,
      errors: 1,
      jsxFallbackAttempts: 1,
      jsxFallbackRequests: 1,
      rawTransferFallbackAttempts: 0,
      kind: 'uncached',
      parserKey: 'a-parser',
      requests: 2,
      revision: 'a-revision',
    }
  );

  accumulator.processors.byPhase.set('z-phase\ud800', {
    definedProcessors: 0,
    importCandidates: 3,
    lookupAttempts: 2,
    lookupHits: 1,
    passes: 1,
    reusedPlans: 0,
    usages: 4,
  });
  accumulator.processors.byPhase.set('a-phase🔥', {
    definedProcessors: 2,
    importCandidates: 1,
    lookupAttempts: 1,
    lookupHits: 0,
    passes: 2,
    reusedPlans: 1,
    usages: 2,
  });

  accumulator.shakes.attempts = 2;
  accumulator.shakes.calls.push(
    {
      error: false,
      generatedBytes: 0,
      inputBytes: 31,
      inputRevision: 'input-z',
      mode: 'preval',
      only: ['z', '\ud800'],
      outputRevision: null,
    },
    {
      error: true,
      generatedBytes: 17,
      inputBytes: 47,
      inputRevision: 'input-a',
      mode: 'collect🔥',
      only: [],
      outputRevision: 'output-a',
    }
  );
  accumulator.shakes.errors = 1;
  accumulator.shakes.generatedBytes = 17;
  accumulator.shakes.successes = 1;
  return accumulator;
};

const expectDifferentialMatch = (accumulator: PipelineAccumulator): string => {
  const actual = serializePipelineTelemetryJSONl(accumulator, WORKING_DIR);
  expect(decodePipelineTelemetryJSONl(actual)).toEqual(
    JSON.parse(serializeLegacyPipelineTelemetryJSONl(accumulator, WORKING_DIR))
  );
  return actual;
};

describe('serializePipelineTelemetryJSONl', () => {
  it.each([
    ['cached hit', 'cached', 1, 0, 0, 0],
    ['cached miss', 'cached', 1, 1, 0, 1],
    ['cached fallback miss', 'cached', 1, 1, 1, 2],
    ['uncached request', 'uncached', 1, 0, 0, 1],
    ['uncached aggregate with fallback', 'uncached', 2, 0, 1, 3],
  ] as const)(
    'derives physical parser attempts for %s',
    (_name, kind, requests, cacheMisses, jsxFallbackAttempts, expected) => {
      const counter: ParseRevisionCounter = {
        bytes: 17,
        cacheHits: kind === 'cached' ? requests - cacheMisses : 0,
        cacheMisses,
        errors: 0,
        jsxFallbackAttempts,
        jsxFallbackRequests: jsxFallbackAttempts,
        rawTransferFallbackAttempts: 0,
        kind,
        parserKey: 'test',
        requests,
        revision: 'test',
      };
      const parserAttempts = getPipelineParserAttempts(counter);
      expect(parserAttempts).toBe(expected);
      expect(counter.bytes * parserAttempts).toBe(17 * expected);
    }
  );

  it('matches the legacy compact serializer for an empty accumulator', () => {
    const line = expectDifferentialMatch(createAccumulator());
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      root: { filename: path.join('src', 'root.ts'), status: 'success' },
      schemaVersion: 2,
      type: 'pipeline-telemetry',
    });
  });

  it.each(['cached', 'uncached'] as const)(
    'preserves raw-transfer retries in %s JSONL revision and totals',
    (kind) => {
      const accumulator = createAccumulator();
      const counter: ParseRevisionCounter = {
        bytes: 31,
        cacheHits: kind === 'cached' ? 1 : 0,
        cacheMisses: kind === 'cached' ? 1 : 0,
        errors: 1,
        jsxFallbackAttempts: 1,
        jsxFallbackRequests: 1,
        kind,
        parserKey: 'oxc:module:js:js:r1:j1',
        rawTransferFallbackAttempts: 1,
        requests: 2,
        revision: 'allocation-fallback',
      };
      accumulator.parse.revisions.push(counter);
      const line = expectDifferentialMatch(accumulator);
      const wire = JSON.parse(line) as JSONRecord;
      const [totals, revisions] = wire.parse as unknown[][];
      const attempts = kind === 'cached' ? 3 : 4;
      expect(wire.schemaVersion).toBe(2);
      expect(totals[5]).toBe(attempts);
      expect(totals[7]).toBe(31 * attempts);
      expect(totals[11]).toBe(1);
      expect((revisions[0] as unknown[])[4]).toBe(
        kind === 'cached' ? 126 : 121
      );
      expect(decodePipelineTelemetryJSONl(line).parse).toEqual(
        expect.objectContaining({
          allRequests: 2,
          errors: 1,
          parserAttempts: attempts,
          rawTransferFallbackAttempts: 1,
        })
      );
    }
  );

  it.each([
    ['/work/project/src/root.ts', '/work/project', 'src/root.ts'],
    ['C:\\work\\project\\src\\root.ts', 'C:\\work\\project', 'src\\root.ts'],
    ['D:\\private\\root.ts', 'C:\\work\\project', 'root.ts'],
    [
      '\\\\server-a\\project\\src\\root.ts',
      '\\\\server-a\\project',
      'src\\root.ts',
    ],
    ['\\\\server-b\\private\\root.ts', '\\\\server-a\\project', 'root.ts'],
    ['//server-b/private/root.ts', '//server-a/project', 'root.ts'],
  ])(
    'serializes %s relative to %s without leaking cross-volume paths',
    (filename, workingDir, expected) => {
      const line = serializePipelineTelemetryJSONl(
        createAccumulator(filename),
        workingDir
      );
      const wire = JSON.parse(line) as JSONRecord;
      expect(wire.root).toEqual({ filename: expected, status: 'success' });
    }
  );

  it('matches every populated section, default omission, and path rule', () => {
    const line = expectDifferentialMatch(createFullAccumulator());
    const parsed = decodePipelineTelemetryJSONl(line);

    const parse = parsed.parse as JSONRecord;
    const revisions = parse.revisions as JSONRecord[];
    expect(revisions[0]).not.toHaveProperty('filename');
    expect(revisions[0]).not.toHaveProperty('kind');
    const processors = parsed.processors as JSONRecord;
    const byPhase = processors.byPhase as JSONRecord[];
    expect(byPhase[0]).not.toHaveProperty('filename');
    expect(byPhase[0]).not.toHaveProperty('passes');
    const shakes = parsed.shakes as JSONRecord;
    const calls = shakes.calls as JSONRecord[];
    expect(calls[0]).not.toHaveProperty('error');
    expect(calls[0]).not.toHaveProperty('filename');
    expect(calls[0].outputRevision).toBeNull();
    expect(line).toContain('🔥');
    expect(line).toContain('\\ud800');
  });

  it.each([
    [
      'cache salt without requests',
      () => {
        const accumulator = createAccumulator();
        accumulator.cache.salt.changes.push({
          current: 'one',
          outcome: 'migrate',
          previous: null,
        });
        return accumulator;
      },
    ],
    [
      'cache clear without requests',
      () => {
        const accumulator = createAccumulator();
        accumulator.cache.clearReasons.set('entrypoints\0test', {
          cache: 'entrypoints',
          entries: 0,
          reason: 'test',
          requests: 1,
        });
        return accumulator;
      },
    ],
    [
      'disposable root without entrypoint requests',
      () => {
        const accumulator = createAccumulator();
        accumulator.entrypoints.disposableRootsByPhase.set('collect', 1);
        return accumulator;
      },
    ],
    [
      'zero, negative zero, and non-finite counters',
      () => {
        const accumulator = createAccumulator();
        accumulator.cleanup.calls = 1;
        accumulator.cleanup.capHits = -0;
        accumulator.cleanup.errors = Number.NaN;
        return accumulator;
      },
    ],
    [
      'dangerous code map with default counters',
      () => {
        const accumulator = createAccumulator();
        accumulator.dangerousByFile.set(ROOT_FILENAME, {
          calls: 0,
          durationMs: 0,
        });
        return accumulator;
      },
    ],
    [
      'late no-metadata event without dangerous code',
      () => {
        const accumulator = createAccumulator();
        accumulator.lateNoMetadata.push({
          filename: ROOT_FILENAME,
          only: [],
          phase: 'collect',
        });
        return accumulator;
      },
    ],
    [
      'parse denominator without revisions',
      () => {
        const accumulator = createAccumulator();
        accumulator.parse.revisions.push({
          bytes: 1,
          cacheHits: 0,
          cacheMisses: 0,
          errors: 0,
          jsxFallbackAttempts: 0,
          jsxFallbackRequests: 0,
          rawTransferFallbackAttempts: 0,
          kind: 'uncached',
          parserKey: 'custom',
          requests: 1,
          revision: 'revision',
        });
        return accumulator;
      },
    ],
    [
      'processor phase with default counters',
      () => {
        const accumulator = createAccumulator();
        accumulator.processors.byPhase.set('preeval', {
          definedProcessors: 0,
          importCandidates: 0,
          lookupAttempts: 0,
          lookupHits: 0,
          passes: 1,
          reusedPlans: 0,
          usages: 0,
        });
        return accumulator;
      },
    ],
    [
      'shake denominator without completed calls',
      () => {
        const accumulator = createAccumulator();
        accumulator.shakes.attempts = 1;
        return accumulator;
      },
    ],
  ])('matches the legacy section boundary for %s', (_name, createFixture) => {
    expectDifferentialMatch(createFixture());
  });

  it('uses the exact tuple schema and preserves collection order', () => {
    const line = expectDifferentialMatch(createFullAccumulator());
    const wire = JSON.parse(line) as JSONRecord;

    expect(Object.keys(wire)).toEqual([
      'root',
      'schemaVersion',
      'type',
      'cache',
      'cleanup',
      'entrypoints',
      'lateNoMetadata',
      'parse',
      'processors',
      'shakes',
    ]);
    expect(wire.cache).toEqual([
      3,
      1,
      2,
      3,
      3,
      [
        3,
        0,
        1,
        1,
        1,
        [
          { current: 'one', outcome: 'migrate', previous: null },
          { current: null, outcome: 'disable', previous: 'one' },
        ],
      ],
      [
        [0, 0, 1, 0, 1],
        [2, 1, 0, 2, 2],
      ],
      [
        [2, 'z-reason\n🔥', 3, 1],
        [1, 'a-reason\ud800', 0, 2],
      ],
    ]);
    expect(wire.cleanup).toEqual([
      2,
      4,
      6,
      21,
      2,
      3,
      13,
      8,
      [6, 5, 3, 4, 1, 2],
      1,
      1,
      1,
      0,
      0,
    ]);
    expect(wire.entrypoints).toEqual([
      3,
      2,
      1,
      2,
      1,
      0,
      1,
      1,
      1,
      [
        [['z', 'quote"', '🔥', '\ud800'], 2],
        [[], 1],
      ],
      [
        ['preeval', 1],
        ['collect', 0],
      ],
    ]);
    expect(wire.lateNoMetadata).toEqual([
      3,
      3,
      0.1 + 0.2,
      [
        ['preeval', ['z', '\ud800']],
        ['collect', ['a', '🔥'], path.join('src', 'other\nfile.ts')],
        ['collect', []],
      ],
    ]);
    expect(wire.parse).toEqual([
      [4, 2, 2, 1, 1, 4, 156, 172, 1, 2, 1, 0],
      [
        ['z-revision\ud800', 'z-parser\n🔥', 31, 2, 22, 1, 1, 1],
        ['a-revision', 'a-parser', 47, 2, 57, 'uncached', 1, 1, 1],
      ],
    ]);
    expect(wire.processors).toEqual([
      ['z-phase\ud800', 78, 3, 2, 1, 4],
      ['a-phase🔥', 119, 2, 1, 1, 2, 1, 2],
    ]);
    expect(wire.shakes).toEqual([
      2,
      1,
      1,
      17,
      [
        ['input-z', 'preval', ['z', '\ud800'], null, 31, 0],
        ['input-a', 'collect🔥', [], 'output-a', 47, 3, 17],
      ],
    ]);
  });

  it('publishes the minimal wire layouts and masks', () => {
    const { enumIds, layouts, masks } = PIPELINE_TELEMETRY_SCHEMA.tupleEncoding;

    expect(enumIds).toEqual({
      cache: CACHE_NAMES,
      cacheOperation: CACHE_OPERATION_NAMES,
      parserKey: PARSER_KEYS,
    });
    expect(enumIds.parserKey).toEqual(PARSER_KEYS);
    expect(enumIds.parserKey).toHaveLength(40);
    expect(enumIds.parserKey[10]).toBe('oxc:module:ts:ts:r1:j0');
    expect(layouts).not.toHaveProperty('dangerousCode');
    expect(layouts).not.toHaveProperty('entrypointFile');
    expect(layouts.entrypoints).toEqual([
      'requests',
      'roots',
      'children',
      'created',
      'cached',
      'loops',
      'initialRoots',
      'onDemandRoots',
      'disposableRoots',
      'byOnly',
      'disposableRootsByPhase',
    ]);
    expect(layouts.parseRevision).toEqual([
      'revision',
      'parserKeyIdOrString',
      'bytes',
      'requests',
      'mask',
      '...values',
    ]);
    expect(layouts.processor).toEqual(['phase', 'mask', '...values']);
    expect(layouts.shakeCall).toEqual([
      'inputRevision',
      'mode',
      'only',
      'outputRevision',
      'inputBytes',
      'mask',
      '...values',
    ]);
    expect(masks).toEqual({
      parseRevision: {
        cacheHits: 2,
        cacheMisses: 4,
        errors: 8,
        jsxFallbackAttempts: 32,
        jsxFallbackRequests: 16,
        rawTransferFallbackAttempts: 64,
        kind: 1,
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
    });
    expect(PIPELINE_TELEMETRY_SCHEMA.denominators).not.toHaveProperty(
      'dangerousCode'
    );
    expect(PIPELINE_TELEMETRY_SCHEMA.encodings).toEqual({
      bytes: 'UTF-8 byte length',
      filenames:
        'relative to the reporter working directory; cross-volume paths fall back to basename',
      only: 'deduplicated and sorted; any list containing the wildcard normalizes to ["*"]',
      revision: 'SHA-256 digest encoded as unpadded base64url',
    });
    expect(Object.keys(layouts)).toEqual([
      'cache',
      'cacheByOperation',
      'cacheClearReason',
      'cacheSalt',
      'cleanup',
      'cleanupCandidateRemovals',
      'entrypoints',
      'entrypointByOnly',
      'entrypointDisposableRoot',
      'lateNoMetadata',
      'lateNoMetadataEvent',
      'parse',
      'parseRevision',
      'parseTotals',
      'processor',
      'shakes',
      'shakeCall',
    ]);
    expect(Object.isFrozen(PIPELINE_TELEMETRY_SCHEMA)).toBe(true);
    expect(Object.isFrozen(PIPELINE_TELEMETRY_SCHEMA.tupleEncoding)).toBe(true);
    expect(Object.isFrozen(enumIds.parserKey)).toBe(true);
    expect(Object.isFrozen(layouts.parseRevision)).toBe(true);
    expect(Object.isFrozen(masks.parseRevision)).toBe(true);
  });

  it('encodes common parser keys with stable numeric ids', () => {
    const accumulator = createAccumulator();
    const parserKeys = [...PARSER_KEYS, 'custom:source:ts:r9:j0'] as const;
    parserKeys.forEach((parserKey, index) => {
      accumulator.parse.revisions.push({
        bytes: index + 1,
        cacheHits: 0,
        cacheMisses: 1,
        errors: 0,
        jsxFallbackAttempts: 0,
        jsxFallbackRequests: 0,
        rawTransferFallbackAttempts: 0,
        kind: 'cached',
        parserKey,
        requests: 1,
        revision: `revision-${index}`,
      });
    });

    const wire = JSON.parse(
      serializePipelineTelemetryJSONl(accumulator, WORKING_DIR)
    ) as JSONRecord;
    const [, revisions] = wire.parse as unknown[][];
    expect(revisions.map((revision) => revision[1])).toEqual([
      ...PARSER_KEYS.map((_parserKey, index) => index),
      'custom:source:ts:r9:j0',
    ]);
  });
});
