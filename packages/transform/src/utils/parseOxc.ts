import { parseSync, rawTransferSupported } from 'oxc-parser';
import type { Comment, Program } from 'oxc-parser';

import { logger, stripQueryAndHash } from '@wyw-in-js/shared';

import {
  currentPipelineObserver,
  type ParseKind,
  type PipelineParseMeasurement,
} from '../telemetry/observer';
import {
  getOxcParserLanguage,
  type OxcParserLanguage,
} from './oxcParserLanguage';

// The single parse entry of the transform package. Internal parses go through
// parseOxcCached, or parseOxcFragmentProgramCached for the static expression
// texts that the value engine builds; parseOxcProgramFresh serves callers that
// own and may mutate the AST. All share the .js JSX fallback, raw-transfer
// recovery and parse telemetry. Direct parser calls elsewhere are rejected by the package's lint
// config.

type OxcSourceType = 'module' | 'unambiguous';
export type OxcAstType = 'js' | 'ts';

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
let useRawTransfer = rawTransferSupported();
const logRawTransfer = logger.extend('transform:parse:raw-transfer');

export const parseOxcSync = (
  filename: string,
  code: string,
  options: OxcParseOptions,
  telemetryKind?: ParseKind,
  // A JSX reparse belongs to its original .js logical request.
  telemetryFilename = filename,
  telemetryJsxFallbackAllowed = telemetryKind === 'cached' &&
    telemetryFilename.endsWith('.js')
): ReturnType<typeof parseSync> => {
  const language = options.lang ?? getOxcParserLanguage(filename);
  const optionsWithTransfer: OxcParseOptions = {
    ...options,
    // Oxc's raw and JSON deserializers currently disagree on node spans when
    // a JS-shaped AST is requested for a TypeScript-family language. Preserve
    // the established JSON representation for any mixed language/AST mode.
    experimentalRawTransfer:
      useRawTransfer &&
      options.experimentalRawTransfer !== false &&
      isOxcRawTransferAstTypeCompatible(language, options.astType),
  };
  try {
    return parseSync(filename, code, optionsWithTransfer);
  } catch (error) {
    if (
      !optionsWithTransfer.experimentalRawTransfer ||
      !(error instanceof RangeError) ||
      error.message !== 'Array buffer allocation failed'
    ) {
      throw error;
    }

    // Platform support does not guarantee Oxc can allocate its ~6 GiB raw
    // transfer buffer. Keep using JSON after allocation fails so every file
    // does not attempt the same oversized allocation again.
    useRawTransfer = false;
    if (telemetryKind) {
      currentPipelineObserver().recordRawTransferFallback(
        telemetryFilename,
        code,
        options.sourceType ?? 'module',
        options.astType ??
          (language === 'js' || language === 'jsx' ? 'js' : 'ts'),
        telemetryKind,
        telemetryJsxFallbackAllowed
      );
    }
    try {
      logRawTransfer(
        'Array buffer allocation failed for %s; using JSON for this and subsequent parses',
        filename
      );
    } catch {
      // A failing debug sink must not prevent recovery through JSON.
    }
    const jsonOptions: OxcParseOptions = {
      ...optionsWithTransfer,
      experimentalRawTransfer: false,
    };
    return parseSync(filename, code, jsonOptions);
  }
};

type ParsedOxcPayload = {
  comments: Comment[];
  jsxFallback: boolean;
  module: {
    hasModuleSyntax: boolean;
  };
  program: Program;
};

type ParsedOxc = ParsedOxcPayload & {
  // The file, without query and hash, whose parse stored this entry; null for
  // a static expression fragment. Reads under other names keep the owner.
  readonly owner: string | null;
  pipelineMeasurement: PipelineParseMeasurement | undefined;
};

// 200 evicts under sustained pressure on large monorepos — the
// removeUnusedAfterReplacement cleanup loop reparses on every iteration
// (new content -> new key) and applyOxcProcessors reparses after extraction.
// 1000 evicted cross-file snippet entries once keys became filename-agnostic;
// 4000 kept those entries hot in the measured build. This is a count bound;
// retained bytes still depend on the source and AST sizes.
export const MAX_PARSE_CACHE_ENTRIES = 4000;
// A transform worker pool splits this budget between its workers, so N workers
// keep about as many ASTs as one in-process cache would, not N times as many.
let maxParseCacheEntries = MAX_PARSE_CACHE_ENTRIES;

export const setParseCacheLimit = (limit: number): void => {
  maxParseCacheEntries = Math.max(1, Math.floor(limit));
};
// Every edit of a file adds a new code string. A dev server that keeps editing
// one file would otherwise fill the whole count budget with its old versions.
// A file keeps this many codes of its own; a warm build of a file needs fewer
// than ten once static expression fragments are not counted.
export const MAX_PARSE_CACHE_ENTRIES_PER_FILE = 16;
// Bucketed by parser semantics with the code string itself as the inner key:
// building a key containing the code allocated a whole-file string per lookup
// purely to feed the map hash.
type ParseCacheBucket = Map<string, ParsedOxc>;
const parseCache = new Map<string, ParseCacheBucket>();
let parseCacheSize = 0;
// Owner file -> its codes, least recently used first -> the buckets holding
// each code. Only files own codes; fragments are bounded by the count limit.
const parseCodesByFilename = new Map<
  string,
  Map<string, Set<ParseCacheBucket>>
>();
const commentsByProgram = new WeakMap<Program, readonly Comment[]>();

const getAstType = (filename: string): OxcAstType =>
  filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'ts' : 'js';

const getJsxFallbackFilename = (filename: string): string | null => {
  if (filename.endsWith('.js')) return `${filename}x`;

  return null;
};

/**
 * Some bundlers pass .js files with JSX to WyW before a later JSX transform.
 * Such a file is read as JSX when the JS grammar rejects it on JSX syntax.
 */
export const needsJsxFallback = (
  filename: string,
  errorMessage: string
): boolean =>
  getJsxFallbackFilename(filename) !== null && errorMessage.includes('JSX');

// The filename selects Oxc's language dialect independently of astType and
// controls whether .js may fall back to JSX, so both semantics are part of the
// bucket key. Paths with equivalent parser behavior still share entries.
const getParseCacheBucket = (
  filename: string,
  sourceType: OxcSourceType,
  astType: OxcAstType
): Map<string, ParsedOxc> => {
  const bucketKey = `${sourceType}\0${getOxcParserLanguage(
    filename
  )}\0${astType}\0${getJsxFallbackFilename(filename) !== null}`;
  let bucket = parseCache.get(bucketKey);
  if (!bucket) {
    bucket = new Map();
    parseCache.set(bucketKey, bucket);
  }
  return bucket;
};

const forgetOwnedCode = (
  bucket: ParseCacheBucket,
  code: string,
  owner: string | null
): void => {
  if (owner === null) return;
  const codes = parseCodesByFilename.get(owner);
  const buckets = codes?.get(code);
  if (!codes || !buckets) return;
  buckets.delete(bucket);
  if (buckets.size > 0) return;
  codes.delete(code);
  if (codes.size === 0) {
    parseCodesByFilename.delete(owner);
  }
};

const touchOwnedCode = (entry: ParsedOxc, code: string): void => {
  if (entry.owner === null) return;
  const codes = parseCodesByFilename.get(entry.owner);
  const buckets = codes?.get(code);
  if (!codes || !buckets) return;
  codes.delete(code);
  codes.set(code, buckets);
};

const deleteCachedParse = (bucket: ParseCacheBucket, code: string): void => {
  const entry = bucket.get(code);
  if (!entry) return;
  bucket.delete(code);
  parseCacheSize -= 1;
  forgetOwnedCode(bucket, code, entry.owner);
};

// Drops a code from the buckets that still hold it for this owner and returns
// how many entries went away.
const dropOwnedCode = (
  owner: string,
  code: string,
  buckets: Set<ParseCacheBucket>
): number => {
  let dropped = 0;
  buckets.forEach((bucket) => {
    if (bucket.get(code)?.owner !== owner) return;
    bucket.delete(code);
    dropped += 1;
  });
  return dropped;
};

const recordOwnedCode = (
  bucket: ParseCacheBucket,
  code: string,
  owner: string
): void => {
  let codes = parseCodesByFilename.get(owner);
  if (!codes) {
    codes = new Map();
    parseCodesByFilename.set(owner, codes);
  }
  const buckets = codes.get(code) ?? new Set();
  codes.delete(code);
  codes.set(code, buckets.add(bucket));
  for (const [oldestCode, oldestBuckets] of codes) {
    if (codes.size <= MAX_PARSE_CACHE_ENTRIES_PER_FILE) break;
    codes.delete(oldestCode);
    parseCacheSize -= dropOwnedCode(owner, oldestCode, oldestBuckets);
  }
};

const setCachedParse = (
  bucket: ParseCacheBucket,
  code: string,
  value: ParsedOxc
): ParsedOxc => {
  const previous = bucket.get(code);
  if (previous) {
    forgetOwnedCode(bucket, code, previous.owner);
  } else {
    parseCacheSize += 1;
  }
  bucket.set(code, value);
  commentsByProgram.set(value.program, value.comments);
  if (value.owner !== null) {
    recordOwnedCode(bucket, code, value.owner);
  }
  while (parseCacheSize > maxParseCacheEntries) {
    // Evict the oldest entry of the largest bucket; the bucket set is small.
    let largest: ParseCacheBucket | null = null;
    for (const candidate of parseCache.values()) {
      if (!largest || candidate.size > largest.size) {
        largest = candidate;
      }
    }
    const oldestCode = largest?.keys().next().value;
    if (!largest || oldestCode === undefined) break;
    deleteCachedParse(largest, oldestCode);
  }

  return value;
};

// Parses with the .js JSX fallback. Failed requests are reported through
// recordFailure; the caller records successful ones.
const parseWithJsxFallback = (
  filename: string,
  code: string,
  sourceType: OxcSourceType,
  astType: OxcAstType,
  telemetryKind: ParseKind,
  recordFailure: (jsxFallback: boolean) => void
): ParsedOxcPayload => {
  const jsxFallbackFilename = getJsxFallbackFilename(filename);
  const jsxFallbackAllowed = jsxFallbackFilename !== null;
  const options = { astType, range: true, sourceType } as const;
  let parsed: ReturnType<typeof parseOxcSync>;
  try {
    parsed = parseOxcSync(
      filename,
      code,
      options,
      telemetryKind,
      filename,
      jsxFallbackAllowed
    );
  } catch (error) {
    recordFailure(false);
    throw error;
  }
  let fatalError = parsed.errors.find((error) => error.severity === 'Error');
  let jsxFallback = false;
  if (
    fatalError &&
    jsxFallbackFilename &&
    needsJsxFallback(filename, fatalError.message)
  ) {
    jsxFallback = true;
    try {
      parsed = parseOxcSync(
        jsxFallbackFilename,
        code,
        options,
        telemetryKind,
        filename,
        jsxFallbackAllowed
      );
    } catch (error) {
      recordFailure(jsxFallback);
      throw error;
    }
    fatalError = parsed.errors.find((error) => error.severity === 'Error');
  }

  if (fatalError) {
    recordFailure(jsxFallback);
    throw new Error(fatalError.message);
  }

  return {
    comments: parsed.comments,
    jsxFallback,
    module: {
      hasModuleSyntax: parsed.module.hasModuleSyntax,
    },
    program: parsed.program as Program,
  };
};

const parseOxcCachedFor = (
  owner: string | null,
  filename: string,
  code: string,
  sourceType: OxcSourceType,
  astType: OxcAstType
): ParsedOxc => {
  const bucket = getParseCacheBucket(filename, sourceType, astType);
  const cached = bucket.get(code);
  if (cached) {
    // Refresh recency so insertion-order eviction behaves as LRU: hot entries
    // (the current file's program, common snippets) must outlive one-shot
    // content versions produced by the cleanup loops.
    bucket.delete(code);
    bucket.set(code, cached);
    touchOwnedCode(cached, code);
    const knownMeasurement = cached.pipelineMeasurement;
    const measurement = currentPipelineObserver().recordCachedParseHit(
      cached,
      filename,
      code,
      sourceType,
      astType,
      cached.jsxFallback,
      knownMeasurement
    );
    if (measurement && measurement !== knownMeasurement) {
      cached.pipelineMeasurement = measurement;
    }
    return cached;
  }

  const payload = parseWithJsxFallback(
    filename,
    code,
    sourceType,
    astType,
    'cached',
    (jsxFallback) =>
      currentPipelineObserver().recordCachedParseMiss(
        filename,
        code,
        sourceType,
        astType,
        jsxFallback,
        true
      )
  );
  const value: ParsedOxc = {
    ...payload,
    owner,
    pipelineMeasurement: undefined,
  };
  if (payload.module.hasModuleSyntax) {
    // Module syntax pins 'unambiguous' to the module grammar, so both
    // sourceType requests resolve to the same AST — publish it under both
    // keys instead of parsing the same content twice.
    const other: OxcSourceType =
      sourceType === 'module' ? 'unambiguous' : 'module';
    // Cache entries keep source-type-specific telemetry identity, while their
    // immutable parse payload is shared.
    setCachedParse(getParseCacheBucket(filename, other, astType), code, {
      ...payload,
      owner,
      pipelineMeasurement: undefined,
    });
  }

  const cachedParse = setCachedParse(bucket, code, value);
  const telemetryMeasurement = currentPipelineObserver().recordCachedParseMiss(
    filename,
    code,
    sourceType,
    astType,
    payload.jsxFallback,
    false,
    cachedParse
  );
  if (telemetryMeasurement) {
    cachedParse.pipelineMeasurement = telemetryMeasurement;
  }
  return cachedParse;
};

export const parseOxcCached = (
  filename: string,
  code: string,
  sourceType: OxcSourceType,
  // The AST shape defaults to the filename's language family. CommonJS emit
  // requests the JS shape for every file and gets its own cache bucket.
  astType: OxcAstType = getAstType(filename)
): ParsedOxc =>
  parseOxcCachedFor(
    stripQueryAndHash(filename),
    filename,
    code,
    sourceType,
    astType
  );

// Static expression texts that the value engine wraps in a declaration and
// parses under the name of the file they come from. They share the cache with
// whole files but do not count against that file's versions.
export const parseOxcFragmentProgramCached = (
  filename: string,
  code: string,
  sourceType: OxcSourceType
): Program =>
  parseOxcCachedFor(null, filename, code, sourceType, getAstType(filename))
    .program;

export const parseOxcProgramCached = (
  filename: string,
  code: string,
  sourceType: OxcSourceType,
  astType?: OxcAstType
): Program => parseOxcCached(filename, code, sourceType, astType).program;

// A caller-owned program for public APIs whose callers may mutate the AST. It
// neither reads nor populates the cache and is reported as an uncached request.
export const parseOxcProgramFresh = (
  filename: string,
  code: string,
  sourceType: OxcSourceType,
  astType: OxcAstType = getAstType(filename)
): Program => {
  const jsxFallbackAllowed = getJsxFallbackFilename(filename) !== null;
  const payload = parseWithJsxFallback(
    filename,
    code,
    sourceType,
    astType,
    'uncached',
    (jsxFallback) =>
      currentPipelineObserver().recordUncachedParse(
        filename,
        code,
        sourceType,
        astType,
        true,
        jsxFallback,
        jsxFallbackAllowed
      )
  );
  commentsByProgram.set(payload.program, payload.comments);
  currentPipelineObserver().recordUncachedParse(
    filename,
    code,
    sourceType,
    astType,
    false,
    payload.jsxFallback,
    jsxFallbackAllowed
  );
  return payload.program;
};

export const getOxcProgramComments = (
  program: Program
): readonly Comment[] | undefined => commentsByProgram.get(program);
