const DENOMINATORS = Object.freeze({
  cache:
    'requests = get requests + has requests; each byOperation bucket has requests = hits + misses; salt.calls counts setKeySalt decisions, while salt.changes retains only transitions; clearRequests counts primary-cache clear/invalidate operations and clearEntries counts entries present before them',
  cleanup:
    'calls are cleanup invocations; attemptedIterations are loop bodies and committedIterations are candidate revisions accepted after parse; candidateRemovals are raw pre-merge ranges by collector and can overlap, while attempted/committed ranges and bytes use merged ranges; outcomes partition calls',
  entrypoints:
    'requests are completed Entrypoint.innerCreate decisions; requests = roots + children = created + cached + loops; byOnly counts the effective merged entrypoint.only list; initialRoots means a root request with loadedCode, while onDemandRoots has no loadedCode; disposable roots are events rather than unique filenames; calls that throw before a decision are not counted',
  lateNoMetadata:
    'count is late no-metadata short-circuit events; events retain each phase/only occurrence, while dangerousCodeCalls and dangerousCodeMs include each distinct affected filename once',
  parse:
    'allRequests = cachedRequests + uncachedRequests; cachedRequests = cacheHits + cacheMisses; parserAttempts = cacheMisses + jsxFallbackAttempts + rawTransferFallbackAttempts for cached revisions and requests + jsxFallbackAttempts + rawTransferFallbackAttempts for uncached revisions; requestedBytes count each logical request input, parsedBytes count input bytes per physical parseSync attempt including failed raw allocations, errors count failed logical requests; rawTransferFallbackAttempts count JSON retries after raw-transfer allocation failures; compact revision records store source bytes once',
  processors:
    'passes are applyOxcProcessors invocations that reach a recorded import/usage analysis result; lookupAttempts exclude side-effect imports and candidates without a local binding; reused plans skip import lookup but still count usages',
  shakes:
    'attempts are core prepareOxcCodeImpl shake calls; attempts = successes + errors',
});

const TUPLE_LAYOUTS = Object.freeze({
  cache: [
    'requests',
    'hits',
    'misses',
    'clearRequests',
    'clearEntries',
    'salt',
    'byOperation',
    'clearReasons',
  ],
  cacheByOperation: ['cacheId', 'operationId', 'hits', 'misses', 'requests'],
  cacheClearReason: ['cacheId', 'reason', 'entries', 'requests'],
  cacheSalt: [
    'calls',
    'clears',
    'disables',
    'migrations',
    'unchanged',
    'changes',
  ],
  cleanup: [
    'calls',
    'attemptedIterations',
    'attemptedRanges',
    'attemptedBytes',
    'committedIterations',
    'committedRanges',
    'committedBytes',
    'rollbackBytes',
    'candidateRemovals',
    'converged',
    'rollbacks',
    'capHits',
    'stalled',
    'errors',
  ],
  cleanupCandidateRemovals: [
    'emptyBlocks',
    'expressions',
    'generatedHelpers',
    'imports',
    'scopedDeclarations',
    'topLevelDeclarations',
  ],
  entrypoints: [
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
  ],
  entrypointByOnly: ['only', 'count'],
  entrypointDisposableRoot: ['phase', 'count'],
  lateNoMetadata: ['count', 'dangerousCodeCalls', 'dangerousCodeMs', 'events'],
  lateNoMetadataEvent: ['phase', 'only', 'filename?'],
  parse: ['totals', 'revisions'],
  parseRevision: [
    'revision',
    'parserKeyIdOrString',
    'bytes',
    'requests',
    'mask',
    '...values',
  ],
  parseTotals: [
    'allRequests',
    'cachedRequests',
    'uncachedRequests',
    'cacheHits',
    'cacheMisses',
    'parserAttempts',
    'requestedBytes',
    'parsedBytes',
    'errors',
    'jsxFallbackRequests',
    'jsxFallbackAttempts',
    'rawTransferFallbackAttempts',
  ],
  processor: ['phase', 'mask', '...values'],
  shakes: ['attempts', 'successes', 'errors', 'generatedBytes', 'calls'],
  shakeCall: [
    'inputRevision',
    'mode',
    'only',
    'outputRevision',
    'inputBytes',
    'mask',
    '...values',
  ],
});

const ENUM_IDS = Object.freeze({
  cache: ['barrelManifests', 'entrypoints', 'exports'],
  cacheOperation: ['get', 'has'],
  parserKey: [
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
  ],
} as const);

const MASKS = Object.freeze({
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
});

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

export const PIPELINE_TELEMETRY_SCHEMA = deepFreeze({
  denominators: DENOMINATORS,
  encodings: {
    bytes: 'UTF-8 byte length',
    filenames:
      'relative to the reporter working directory; cross-volume paths fall back to basename',
    only: 'deduplicated and sorted; any list containing the wildcard normalizes to ["*"]',
    revision: 'SHA-256 digest encoded as unpadded base64url',
  },
  omittedSections:
    'root summaries omit counter sections whose denominator and totals are zero',
  schemaVersion: 2 as const,
  tupleEncoding: {
    defaults:
      'nested filename omission means the root filename; absent parse kind means cached; absent processor passes means 1',
    enumIds: ENUM_IDS,
    layouts: TUPLE_LAYOUTS,
    masks: MASKS,
    optionalValues:
      'values for set bits are appended in ascending bit order; the marker-only error bit appends no value',
  },
  type: 'pipeline-telemetry-schema' as const,
});
