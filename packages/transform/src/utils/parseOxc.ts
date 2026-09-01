import { parseSync, rawTransferSupported } from 'oxc-parser';
import type { Comment, Program } from 'oxc-parser';

import {
  recordPipelineCachedParseMiss,
  recordPipelineCachedParseHit,
} from '../debug/pipelineTelemetry';

type OxcSourceType = 'module' | 'unambiguous';

type OxcParseOptions = Parameters<typeof parseSync>[2] & {
  experimentalRawTransfer?: boolean;
};

// Raw transfer deserializes the AST from a shared buffer instead of a JSON
// string. Same AST shape, but several times cheaper — JSON materialization
// dominated parse cost in profiles of large builds.
const useRawTransfer = rawTransferSupported();

export const parseOxcSync = (
  filename: string,
  code: string,
  options: OxcParseOptions
): ReturnType<typeof parseSync> => {
  const optionsWithTransfer: OxcParseOptions = {
    ...options,
    experimentalRawTransfer: useRawTransfer,
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
// 4000 is still bounded (~200-400 MB worst case for an enormous build) and
// keeps every entry hot across the actions for a single file.
const MAX_PARSE_CACHE_ENTRIES = 4000;
// Bucketed by (sourceType, astType) with the code string itself as the inner
// key: building `${sourceType}\0${astType}\0${code}` allocated a whole-file
// string per lookup (65k lookups per build in profiles) purely to feed the
// map hash.
const parseCache = new Map<string, Map<string, ParsedOxc>>();
let parseCacheSize = 0;
const commentsByProgram = new WeakMap<Program, readonly Comment[]>();

const getAstType = (filename: string): 'js' | 'ts' =>
  filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'ts' : 'js';

const getJsxFallbackFilename = (filename: string): string | null => {
  if (filename.endsWith('.js')) return `${filename}x`;

  return null;
};

// Buckets are keyed by astType, not filename: the parse depends only on the
// grammar and the code, so identical per-candidate snippet programs
// (`const __wyw_static_value = ...;`) and identical files share one entry
// no matter which path asked. On a large monorepo this removes thousands of
// snippet reparses per build.
const getParseCacheBucket = (
  filename: string,
  sourceType: OxcSourceType
): Map<string, ParsedOxc> => {
  const bucketKey = `${sourceType}\0${getAstType(filename)}`;
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
    // Evict the oldest entry of the largest bucket; buckets are few (≤4).
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

  const value: ParsedOxc = {
    comments: parsed.comments,
    jsxFallback,
    module: {
      hasModuleSyntax: parsed.module.hasModuleSyntax,
    },
    pipelineMeasurement: undefined,
    program: parsed.program as Program,
  };
  if (parsed.module.hasModuleSyntax) {
    // Module syntax pins 'unambiguous' to the module grammar, so both
    // sourceType requests resolve to the same AST — publish it under both
    // keys instead of parsing the same content twice.
    const other: OxcSourceType =
      sourceType === 'module' ? 'unambiguous' : 'module';
    setCachedParse(getParseCacheBucket(filename, other), code, value);
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
