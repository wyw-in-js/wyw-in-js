import { parseSync } from 'oxc-parser';
import type { Comment, Program } from 'oxc-parser';

import {
  recordPipelineCachedParseMiss,
  recordPipelineCachedParseHit,
} from '../debug/pipelineTelemetry';

type OxcSourceType = 'module' | 'unambiguous';

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
const parseCache = new Map<string, ParsedOxc>();
const commentsByProgram = new WeakMap<Program, readonly Comment[]>();

const getAstType = (filename: string): 'js' | 'ts' =>
  filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'ts' : 'js';

const getJsxFallbackFilename = (filename: string): string | null => {
  if (filename.endsWith('.js')) return `${filename}x`;

  return null;
};

// Keyed by astType, not filename: the parse depends only on the grammar and
// the code, so identical per-candidate snippet programs
// (`const __wyw_static_value = ...;`) and identical files share one entry
// no matter which path asked. On a large monorepo this removes thousands of
// snippet reparses per build.
const makeCacheKey = (
  filename: string,
  code: string,
  sourceType: OxcSourceType
): string => `${sourceType}\0${getAstType(filename)}\0${code}`;

const setCachedParse = (key: string, value: ParsedOxc): ParsedOxc => {
  parseCache.set(key, value);
  commentsByProgram.set(value.program, value.comments);
  if (parseCache.size > MAX_PARSE_CACHE_ENTRIES) {
    const oldestKey = parseCache.keys().next().value;
    if (oldestKey) {
      parseCache.delete(oldestKey);
    }
  }

  return value;
};

export const parseOxcCached = (
  filename: string,
  code: string,
  sourceType: OxcSourceType
): ParsedOxc => {
  const cacheKey = makeCacheKey(filename, code, sourceType);
  const cached = parseCache.get(cacheKey);
  if (cached) {
    // Refresh recency so insertion-order eviction behaves as LRU: hot entries
    // (the current file's program, common snippets) must outlive one-shot
    // content versions produced by the cleanup loops.
    parseCache.delete(cacheKey);
    parseCache.set(cacheKey, cached);
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
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(filename, code, {
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
      parsed = parseSync(jsxFallbackFilename, code, {
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
    setCachedParse(makeCacheKey(filename, code, other), value);
  }

  const cachedParse = setCachedParse(cacheKey, value);
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
