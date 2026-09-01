import { parseSync, rawTransferSupported } from 'oxc-parser';
import type { Comment, Program } from 'oxc-parser';

import {
  recordPipelineCachedParseMiss,
  recordPipelineCachedParseHit,
} from '../debug/pipelineTelemetry';
import {
  getOxcParserLanguage,
  type OxcParserLanguage,
} from './oxcParserLanguage';

type OxcSourceType = 'module' | 'unambiguous';

type OxcParseOptions = Parameters<typeof parseSync>[2] & {
  experimentalRawTransfer?: boolean;
};

export const isOxcRawTransferAstTypeCompatible = (
  language: OxcParserLanguage,
  astType: 'js' | 'ts' | undefined
): boolean => {
  if (astType === undefined) return true;

  const languageAstType = language === 'js' || language === 'jsx' ? 'js' : 'ts';
  return astType === languageAstType;
};

// Raw transfer deserializes the Program AST from a shared buffer instead of a
// JSON string. JSON materialization dominated parse cost in large-build
// profiles.
const useRawTransfer = rawTransferSupported();

export const parseOxcSync = (
  filename: string,
  code: string,
  options: OxcParseOptions
): ReturnType<typeof parseSync> => {
  const language = options.lang ?? getOxcParserLanguage(filename);
  const optionsWithTransfer: OxcParseOptions = {
    ...options,
    // Oxc's raw and JSON deserializers currently disagree on node spans when
    // a JS-shaped AST is requested for a TypeScript-family language. Preserve
    // the established JSON representation for any mixed language/AST mode.
    experimentalRawTransfer:
      useRawTransfer &&
      isOxcRawTransferAstTypeCompatible(language, options.astType),
  };
  return parseSync(filename, code, optionsWithTransfer);
};

type ParsedOxc = {
  comments: Comment[];
  jsxFallback: boolean;
  module: {
    hasModuleSyntax: boolean;
  };
  pipelineMeasurement: { bytes: number; revision: string } | undefined;
  program: Program;
};

// 200 evicts under sustained pressure on large monorepos — the
// removeUnusedAfterReplacement cleanup loop reparses on every iteration
// (new content -> new key) and applyOxcProcessors reparses after extraction.
// 1000 evicted cross-file snippet entries once keys became filename-agnostic;
// 4000 kept those entries hot in the measured build. This is a count bound;
// retained bytes still depend on the source and AST sizes.
const MAX_PARSE_CACHE_ENTRIES = 4000;
// Bucketed by parser semantics with the code string itself as the inner key:
// building a key containing the code allocated a whole-file string per lookup
// purely to feed the map hash.
const parseCache = new Map<string, Map<string, ParsedOxc>>();
let parseCacheSize = 0;
const commentsByProgram = new WeakMap<Program, readonly Comment[]>();

const getAstType = (filename: string): 'js' | 'ts' =>
  filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'ts' : 'js';

const getJsxFallbackFilename = (filename: string): string | null => {
  if (filename.endsWith('.js')) return `${filename}x`;

  return null;
};

// The filename selects Oxc's language dialect independently of astType and
// controls whether .js may fall back to JSX, so both semantics are part of the
// bucket key. Paths with equivalent parser behavior still share entries.
const getParseCacheBucket = (
  filename: string,
  sourceType: OxcSourceType
): Map<string, ParsedOxc> => {
  const bucketKey = `${sourceType}\0${getOxcParserLanguage(
    filename
  )}\0${getAstType(filename)}\0${getJsxFallbackFilename(filename) !== null}`;
  let bucket = parseCache.get(bucketKey);
  if (!bucket) {
    bucket = new Map();
    parseCache.set(bucketKey, bucket);
  }
  return bucket;
};

const setCachedParse = (
  bucket: Map<string, ParsedOxc>,
  code: string,
  value: ParsedOxc
): ParsedOxc => {
  if (!bucket.has(code)) {
    parseCacheSize += 1;
  }
  bucket.set(code, value);
  commentsByProgram.set(value.program, value.comments);
  if (parseCacheSize > MAX_PARSE_CACHE_ENTRIES) {
    // Evict the oldest entry of the largest bucket; the bucket set is small.
    let largest: Map<string, ParsedOxc> | null = null;
    for (const candidate of parseCache.values()) {
      if (!largest || candidate.size > largest.size) {
        largest = candidate;
      }
    }
    const oldestCode = largest?.keys().next().value;
    if (largest && oldestCode !== undefined) {
      largest.delete(oldestCode);
      parseCacheSize -= 1;
    }
  }

  return value;
};

export const parseOxcCached = (
  filename: string,
  code: string,
  sourceType: OxcSourceType
): ParsedOxc => {
  const bucket = getParseCacheBucket(filename, sourceType);
  const cached = bucket.get(code);
  if (cached) {
    // Refresh recency so insertion-order eviction behaves as LRU: hot entries
    // (the current file's program, common snippets) must outlive one-shot
    // content versions produced by the cleanup loops.
    bucket.delete(code);
    bucket.set(code, cached);
    const knownMeasurement = cached.pipelineMeasurement;
    const measurement = recordPipelineCachedParseHit(
      cached,
      filename,
      code,
      sourceType,
      cached.jsxFallback,
      knownMeasurement
    );
    if (measurement && measurement !== knownMeasurement) {
      cached.pipelineMeasurement = measurement;
    }
    return cached;
  }

  const astType = getAstType(filename);
  let parsed: ReturnType<typeof parseOxcSync>;
  try {
    parsed = parseOxcSync(filename, code, {
      astType,
      range: true,
      sourceType,
    });
  } catch (error) {
    recordPipelineCachedParseMiss(
      filename,
      code,
      sourceType,
      astType,
      false,
      true
    );
    throw error;
  }
  let fatalError = parsed.errors.find((error) => error.severity === 'Error');
  const jsxFallbackFilename = getJsxFallbackFilename(filename);
  let jsxFallback = false;
  if (fatalError?.message.includes('JSX') && jsxFallbackFilename) {
    // Some bundlers pass .js files with JSX to WyW before a later JSX transform.
    jsxFallback = true;
    try {
      parsed = parseOxcSync(jsxFallbackFilename, code, {
        astType: getAstType(jsxFallbackFilename),
        range: true,
        sourceType,
      });
    } catch (error) {
      recordPipelineCachedParseMiss(
        filename,
        code,
        sourceType,
        astType,
        jsxFallback,
        true
      );
      throw error;
    }
    fatalError = parsed.errors.find((error) => error.severity === 'Error');
  }

  if (fatalError) {
    recordPipelineCachedParseMiss(
      filename,
      code,
      sourceType,
      astType,
      jsxFallback,
      true
    );
    throw new Error(fatalError.message);
  }

  const sharedValue = {
    comments: parsed.comments,
    jsxFallback,
    module: {
      hasModuleSyntax: parsed.module.hasModuleSyntax,
    },
    program: parsed.program as Program,
  };
  const value: ParsedOxc = {
    ...sharedValue,
    pipelineMeasurement: undefined,
  };
  if (parsed.module.hasModuleSyntax) {
    // Module syntax pins 'unambiguous' to the module grammar, so both
    // sourceType requests resolve to the same AST — publish it under both
    // keys instead of parsing the same content twice.
    const other: OxcSourceType =
      sourceType === 'module' ? 'unambiguous' : 'module';
    // Cache entries keep source-type-specific telemetry identity, while their
    // immutable parse payload is shared.
    setCachedParse(getParseCacheBucket(filename, other), code, {
      ...sharedValue,
      pipelineMeasurement: undefined,
    });
  }

  const cachedParse = setCachedParse(bucket, code, value);
  const telemetryMeasurement = recordPipelineCachedParseMiss(
    filename,
    code,
    sourceType,
    astType,
    jsxFallback,
    false,
    cachedParse
  );
  if (telemetryMeasurement) {
    cachedParse.pipelineMeasurement = telemetryMeasurement;
  }
  return cachedParse;
};

export const parseOxcProgramCached = (
  filename: string,
  code: string,
  sourceType: OxcSourceType
): Program => parseOxcCached(filename, code, sourceType).program;

export const getOxcProgramComments = (
  program: Program
): readonly Comment[] | undefined => commentsByProgram.get(program);
