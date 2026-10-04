/* eslint-env jest */
import * as oxc from 'oxc-parser';

import { enableDebug, logger } from '@wyw-in-js/shared';

import {
  recordPipelineUncachedParse,
  registerPipelineTelemetryReporter,
  runWithPipelineTelemetry,
  type PipelineTelemetrySummary,
} from '../debug/pipelineTelemetry';
import { EventEmitter } from '../utils/EventEmitter';
import type * as ParseOxc from '../utils/parseOxc';

const parseJson = oxc.parseSync;
const filename = '/project/component.tsx';
const code = '// Привет 👋\nexport const View = () => <div title="γειά" />;';
const options = { astType: 'ts', range: true, sourceType: 'module' } as const;
let importId = 0;
let supportSpy: ReturnType<typeof jest.spyOn>;
let parseSpy: ReturnType<typeof jest.spyOn>;

const loadParser = async () => {
  importId += 1;
  // Each module instance gets its own raw-transfer failure state.
  return import(
    `../utils/parseOxc.ts?raw-transfer-test=${importId}`
  ) as Promise<typeof ParseOxc>;
};

const collectTelemetry = async (parse: () => void) => {
  const emitter = new EventEmitter(
    () => {},
    () => 0,
    () => {}
  );
  const summaries: PipelineTelemetrySummary[] = [];
  const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
    summaries.push(summary)
  );
  try {
    await runWithPipelineTelemetry(emitter, () => ({ filename }), parse);
  } finally {
    unregister();
  }
  expect(summaries).toHaveLength(1);
  return summaries[0];
};

beforeEach(() => {
  supportSpy = jest.spyOn(oxc, 'rawTransferSupported').mockReturnValue(true);
  parseSpy = jest
    .spyOn(oxc, 'parseSync')
    .mockImplementation((file, source, opts) => {
      // Bun does not support raw transfer. Exercise routing with a spy while
      // keeping AST materialization and diagnostics on the real JSON parser.
      const jsonOptions = { ...opts, experimentalRawTransfer: false };
      return parseJson(file, source, jsonOptions);
    });
});

afterEach(() => {
  parseSpy.mockRestore();
  supportSpy.mockRestore();
});

describe('raw-transfer allocation fallback', () => {
  it('retries using JSON and uses JSON for subsequent files', async () => {
    const { parseOxcSync } = await loadParser();
    parseOxcSync('/project/previous.tsx', code, options);
    expect(parseSpy.mock.calls[0][2]).toEqual({
      ...options,
      experimentalRawTransfer: true,
    });
    parseSpy.mockClear();
    parseSpy.mockImplementationOnce(() => {
      throw new RangeError('Array buffer allocation failed');
    });

    const parsed = parseOxcSync(filename, code, options);
    const expected = parseJson(filename, code, options);
    expect(parsed.program).toEqual(expected.program);
    expect(parsed.comments).toEqual(expected.comments);
    expect(parsed.module).toEqual(expected.module);
    expect(parsed.errors).toEqual(expected.errors);
    expect(parseSpy.mock.calls).toEqual([
      [filename, code, { ...options, experimentalRawTransfer: true }],
      [filename, code, { ...options, experimentalRawTransfer: false }],
    ]);
    expect(options).toEqual({
      astType: 'ts',
      range: true,
      sourceType: 'module',
    });

    parseOxcSync('/project/next.ts', 'export const next = 1;', {
      ...options,
      experimentalRawTransfer: true,
    });
    expect(parseSpy.mock.calls[2][2]).toEqual({
      ...options,
      experimentalRawTransfer: false,
    });
  });

  it('keeps using raw transfer when parsing succeeds', async () => {
    const { parseOxcSync } = await loadParser();
    parseOxcSync(filename, code, options);
    parseOxcSync('/project/next.tsx', code, options);
    expect(parseSpy).toHaveBeenCalledTimes(2);
    for (const call of parseSpy.mock.calls) {
      expect(call[2]).toEqual({ ...options, experimentalRawTransfer: true });
    }
  });

  it('respects an explicit opt-out without disabling future raw parses', async () => {
    const { parseOxcSync } = await loadParser();
    parseOxcSync(filename, code, {
      ...options,
      experimentalRawTransfer: false,
    });
    parseOxcSync(filename, code, options);
    expect(parseSpy.mock.calls.map((call) => call[2])).toEqual([
      { ...options, experimentalRawTransfer: false },
      { ...options, experimentalRawTransfer: true },
    ]);
  });

  it('uses JSON on unsupported platforms and for mixed language/AST modes', async () => {
    supportSpy.mockReturnValue(false);
    const unsupported = await loadParser();
    unsupported.parseOxcSync(filename, code, options);
    supportSpy.mockReturnValue(true);
    const compatible = await loadParser();
    compatible.parseOxcSync(filename, code, { ...options, astType: 'js' });
    expect(parseSpy.mock.calls.map((call) => call[2])).toEqual([
      { ...options, experimentalRawTransfer: false },
      { ...options, astType: 'js', experimentalRawTransfer: false },
    ]);
  });

  it.each([
    new RangeError('Invalid typed array length'),
    new RangeError('Maximum call stack size exceeded'),
    new Error('Array buffer allocation failed'),
  ])('propagates an unrelated error: %s', async (error) => {
    const { parseOxcSync } = await loadParser();
    parseSpy.mockImplementationOnce(() => {
      throw error;
    });
    expect(() => parseOxcSync(filename, code, options)).toThrow(error);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    parseOxcSync(filename, code, options);
    expect(parseSpy.mock.calls[1][2]).toEqual({
      ...options,
      experimentalRawTransfer: true,
    });
  });

  it('propagates JSON failure without retrying it', async () => {
    const { parseOxcSync } = await loadParser();
    const error = new Error('JSON parse failed');
    parseSpy.mockImplementation(() => {
      throw error;
    });
    parseSpy.mockImplementationOnce(() => {
      throw new RangeError('Array buffer allocation failed');
    });
    expect(() => parseOxcSync(filename, code, options)).toThrow(error);
    expect(parseSpy).toHaveBeenCalledTimes(2);
    expect(() => parseOxcSync(filename, code, options)).toThrow(error);
    expect(parseSpy).toHaveBeenCalledTimes(3);
  });

  it('does not retry or disable raw transfer after a JSON allocation failure', async () => {
    const { parseOxcSync } = await loadParser();
    const error = new RangeError('Array buffer allocation failed');
    parseSpy.mockImplementationOnce(() => {
      throw error;
    });
    expect(() =>
      parseOxcSync(filename, code, {
        ...options,
        experimentalRawTransfer: false,
      })
    ).toThrow(error);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    parseOxcSync(filename, code, options);
    expect(parseSpy.mock.calls[1][2]).toEqual({
      ...options,
      experimentalRawTransfer: true,
    });
  });

  it('preserves syntax diagnostics and the cached .js JSX fallback', async () => {
    const { parseOxcSync, parseOxcCached } = await loadParser();
    parseSpy.mockImplementationOnce(() => {
      throw new RangeError('Array buffer allocation failed');
    });
    const invalidCode = 'export const = ;';
    expect(parseOxcSync(filename, invalidCode, options).errors).toEqual(
      parseJson(filename, invalidCode, options).errors
    );
    const cached = parseOxcCached('/project/component.js', code, 'module');
    expect(cached.jsxFallback).toBe(true);
    expect(cached.program.body).toHaveLength(1);
    expect(parseOxcCached('/project/component.js', code, 'module')).toBe(
      cached
    );
    expect(() =>
      parseOxcCached('/project/invalid.ts', invalidCode, 'module')
    ).toThrow();
  });
});

describe('raw-transfer fallback reporting', () => {
  it('counts the cached retry once without inflating requests or cache hits', async () => {
    const { parseOxcCached } = await loadParser();
    parseSpy.mockImplementationOnce(() => {
      throw new RangeError('Array buffer allocation failed');
    });
    const summary = await collectTelemetry(() => {
      parseOxcCached(filename, code, 'module');
      parseOxcCached(filename, code, 'module');
      parseOxcCached(filename, code, 'unambiguous');
    });
    expect(summary.parse).toEqual(
      expect.objectContaining({
        allRequests: 3,
        cacheHits: 2,
        cacheMisses: 1,
        errors: 0,
        parserAttempts: 2,
        parsedBytes: Buffer.byteLength(code) * 2,
        rawTransferFallbackAttempts: 1,
      })
    );
    expect(summary.parse.revisions).toHaveLength(2);
    const primary = summary.parse.revisions.find(
      (revision) => revision.cacheMisses
    );
    expect(primary).toEqual(
      expect.objectContaining({
        parserAttempts: 2,
        rawTransferFallbackAttempts: 1,
      })
    );
    const shared = summary.parse.revisions.find(
      (revision) => !revision.cacheMisses
    );
    expect(shared).toEqual(
      expect.objectContaining({
        parserAttempts: 0,
        rawTransferFallbackAttempts: 0,
      })
    );
  });

  it('attributes a retry during JSX fallback to the original .js request', async () => {
    const { parseOxcCached } = await loadParser();
    parseSpy.mockImplementationOnce((file, source, opts) =>
      parseJson(file, source, {
        ...opts,
        experimentalRawTransfer: false,
      })
    );
    parseSpy.mockImplementationOnce(() => {
      throw new RangeError('Array buffer allocation failed');
    });
    const summary = await collectTelemetry(() => {
      parseOxcCached('/project/component.js', code, 'module');
    });
    expect(summary.parse).toEqual(
      expect.objectContaining({
        allRequests: 1,
        cacheMisses: 1,
        errors: 0,
        jsxFallbackAttempts: 1,
        parserAttempts: 3,
        parsedBytes: Buffer.byteLength(code) * 3,
        rawTransferFallbackAttempts: 1,
      })
    );
    expect(summary.parse.revisions).toHaveLength(1);
    expect(summary.parse.revisions[0].parserKey).toBe('oxc:module:js:js:r1:j1');
  });

  it.each([false, true])(
    'counts an uncached retry when JSON fails: %s',
    async (jsonFails) => {
      const { parseOxcSync } = await loadParser();
      const jsonError = new Error('JSON parse failed');
      if (jsonFails) {
        parseSpy.mockImplementation(() => {
          throw jsonError;
        });
      }
      parseSpy.mockImplementationOnce(() => {
        throw new RangeError('Array buffer allocation failed');
      });
      const summary = await collectTelemetry(() => {
        let failed = false;
        try {
          parseOxcSync(filename, code, options, 'uncached');
        } catch (error) {
          failed = true;
          expect(error).toBe(jsonError);
        }
        recordPipelineUncachedParse(filename, code, 'module', 'ts', failed);
      });
      expect(summary.parse).toEqual(
        expect.objectContaining({
          allRequests: 1,
          cacheMisses: 0,
          errors: jsonFails ? 1 : 0,
          parserAttempts: 2,
          parsedBytes: Buffer.byteLength(code) * 2,
          rawTransferFallbackAttempts: 1,
          uncachedRequests: 1,
        })
      );
    }
  );

  it.each([false, true])(
    'reports the switch once even if the debug sink fails: %s',
    async (sinkFails) => {
      const previousDebug = process.env.DEBUG;
      const previousLog = logger.log;
      const messages: unknown[][] = [];
      logger.log = (...args) => {
        messages.push(args);
        if (sinkFails) throw new Error('Debug sink failed');
      };
      enableDebug('wyw-in-js:transform:parse:raw-transfer');
      try {
        const { parseOxcSync } = await loadParser();
        parseSpy.mockImplementationOnce(() => {
          throw new RangeError('Array buffer allocation failed');
        });
        expect(parseOxcSync(filename, code, options).errors).toHaveLength(0);
        expect(parseOxcSync(filename, code, options).errors).toHaveLength(0);
        expect(messages).toHaveLength(1);
        expect(messages[0].join(' ')).toContain('JSON');
        expect(messages[0].join(' ')).toContain(filename);
      } finally {
        logger.log = previousLog;
        enableDebug(previousDebug ?? '');
        if (previousDebug === undefined) delete process.env.DEBUG;
      }
    }
  );
});
