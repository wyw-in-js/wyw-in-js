import { createHash } from 'crypto';
import fs from 'fs';
import NativeModule from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ChildProcessWithoutNullStreams } from 'child_process';

import type {
  EvalOptionsV2,
  EvalWarning,
  FeatureFlags,
  ImportLoaderContext,
  ImportLoaders,
} from '@wyw-in-js/shared';

import { TransformCacheCollection, type TransformCacheEpoch } from '../cache';
import type { EvalTelemetryToken } from '../debug/evalTelemetry';
import type { ParentEntrypoint } from '../types';
import type { Entrypoint } from '../transform/Entrypoint';
import type { IEvaluatedEntrypoint } from '../transform/EvaluatedEntrypoint';
import { loadAndParse } from '../transform/Entrypoint.helpers';
import { rootLog } from '../transform/rootLog';
import type { Services } from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';
import { parseRequest, stripQueryAndHash } from '../utils/parseRequest';

import type { DebugEvalValueStatus } from './debugEval';
import type { EvalRunnerInitPayload } from './protocol';
import { encodeGlobals, type SerializedValue } from './serialize';
import type { PreparedModule } from './prepareModuleOnDemand';
import type { WriteQueue } from './writeQueue';

const DefaultModuleImplementation = NativeModule as typeof NativeModule & {
  builtinModules?: string[];
};

export const isBuiltinSpecifier = (specifier: string) => {
  const normalized = specifier.startsWith('node:')
    ? specifier.slice(5)
    : specifier;
  return (
    DefaultModuleImplementation.builtinModules?.includes(normalized) ||
    DefaultModuleImplementation.builtinModules?.includes(`node:${normalized}`)
  );
};

export const isVirtualSpecifier = (specifier: string) =>
  specifier.startsWith('/@') ||
  specifier.startsWith('virtual:') ||
  specifier.startsWith('\0');

const DEFAULT_EVAL_OPTIONS: Required<
  Pick<EvalOptionsV2, 'errors' | 'require' | 'resolver'>
> = {
  errors: 'strict',
  require: 'warn-and-run',
  resolver: 'bundler',
};

export const RESOLVE_CACHE_SIZE = 5000;
export const LOAD_CACHE_SIZE = 1000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const EVAL_TIMEOUT_MS = Number(
  process.env.WYW_EVAL_TIMEOUT_MS ?? 300_000
);
export const INIT_TIMEOUT_MS = 120_000;
export const HAPPYDOM_INIT_TIMEOUT_MS = Number(
  process.env.WYW_EVAL_HAPPYDOM_INIT_TIMEOUT_MS ??
    process.env.WYW_HAPPYDOM_TIMEOUT_MS ??
    15_000
);

export type ResolveCacheEntry = {
  resolvedId: string | null;
  external?: boolean;
  usedNativeFallback?: boolean;
};

export type ResolveResult = ResolveCacheEntry & {
  only: string[];
};

export type PreparedCacheEntry = PreparedModule & {
  hash: string;
  exports?: Record<string, SerializedValue>;
};

export type EntrypointPublication =
  | Entrypoint
  | IEvaluatedEntrypoint
  | undefined;

export const PREPARED_PUBLICATION = Symbol('preparedPublication');

export type PreparedLoadResult = PreparedCacheEntry & {
  [PREPARED_PUBLICATION]: EntrypointPublication;
  resetModule?: true;
};

export type CachedDependencyRecord = {
  only?: string[];
  resolved: string | null;
};

export type CachedDependencyOwner = {
  dependencies?: Map<string, CachedDependencyRecord>;
  name: string;
};

export type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type CacheGeneration = {
  invalidationError: Error | null;
};

type CacheEpochBinding = {
  cacheEpoch: TransformCacheEpoch;
};

export type EpochServices = Services & CacheEpochBinding;

export type EvalRequestContext = {
  cacheGeneration: CacheGeneration;
  entrypoint: Entrypoint | null;
  epoch: number;
  inputQueue: WriteQueue;
  runner: ChildProcessWithoutNullStreams;
  sessionId: number;
  services: EpochServices;
};

export type ActiveEvalRequest = {
  context: EvalRequestContext;
  id: string;
};

export type EvaluateResult = {
  values: Map<string, unknown> | null;
  dependencies: string[];
  publication: EntrypointPublication;
};

export const createEvaluateResult = (
  values: Map<string, unknown> | null,
  dependencies: string[],
  publication: EntrypointPublication
): EvaluateResult =>
  Object.defineProperty({ values, dependencies }, 'publication', {
    value: publication,
  }) as EvaluateResult;

export const bindServicesToEpoch = (
  services: Services,
  epoch: TransformCacheEpoch = services.cacheEpoch ??
    services.cache.getCurrentEpoch()
): EpochServices => {
  services.cache.assertEpoch(epoch);
  return services.cacheEpoch === epoch
    ? (services as EpochServices)
    : { ...services, cacheEpoch: epoch };
};

export const getServicesCacheOwner = (
  services: EpochServices
): TransformCacheEpoch['owner'] => services.cacheEpoch.owner;

export type EvalFileDebugLine = {
  contentBase64: string | null;
  evalSeq: number;
  hash: string | null;
  id: string;
  importer: string | null;
  only: string[];
  payloadKind: 'code' | 'serialized-exports';
  request: string | null;
  type: 'eval-file';
  valuesBase64: string | null;
  valueStatus: DebugEvalValueStatus;
};

export type PendingEval = {
  cacheGeneration: CacheGeneration;
  entrypoint: Entrypoint;
  services: EpochServices;
  telemetry: EvalTelemetryToken | undefined;
  resolve: (value: EvaluateResult) => void;
  reject: (reason?: unknown) => void;
};

export const isEvalTimeoutError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && (error as { code?: string }).code) {
    return (error as { code?: string }).code === 'WYW_EVAL_TIMEOUT';
  }
  return false;
};

const warnedUnknownImportsByServices = new WeakMap<Services, Set<string>>();

export const getWarnedUnknownImports = (services: Services): Set<string> => {
  const cached = warnedUnknownImportsByServices.get(services);
  if (cached) return cached;
  const created = new Set<string>();
  warnedUnknownImportsByServices.set(services, created);
  return created;
};

const warnedSlowImportsByServices = new WeakMap<Services, Set<string>>();

export const getWarnedSlowImports = (services: Services): Set<string> => {
  const cached = warnedSlowImportsByServices.get(services);
  if (cached) return cached;
  const created = new Set<string>();
  warnedSlowImportsByServices.set(services, created);
  return created;
};

export const isWarningEnabled = (value: string | undefined): boolean =>
  Boolean(value) && value !== '0' && value !== 'false';

export const getSlowImportThresholdMs = () => {
  const raw = process.env.WYW_WARN_SLOW_IMPORTS_MS;
  if (!raw) return 50;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 50;
  return parsed;
};

export const getEvalOptions = (services: Services): EvalOptionsV2 => ({
  ...DEFAULT_EVAL_OPTIONS,
  ...(services.options.pluginOptions.eval ?? {}),
});

export const buildRunnerPath = (): string => {
  const url = new URL('./runner.js', import.meta.url);
  return fileURLToPath(url);
};

export const stripEntrypointGlobalsFromRunnerContext = (
  globals: Record<string, unknown>,
  entrypoint: string
): Record<string, unknown> => {
  const entrypointDir = path.dirname(entrypoint);
  const shouldStripFilename =
    Object.prototype.hasOwnProperty.call(globals, '__filename') &&
    globals.__filename === entrypoint;
  const shouldStripDirname =
    Object.prototype.hasOwnProperty.call(globals, '__dirname') &&
    globals.__dirname === entrypointDir;

  if (!shouldStripFilename && !shouldStripDirname) {
    return globals;
  }

  const nextGlobals = { ...globals };
  if (shouldStripFilename) {
    delete nextGlobals.__filename;
  }
  if (shouldStripDirname) {
    delete nextGlobals.__dirname;
  }

  return nextGlobals;
};

export const getEntrypointResolveRoot = (entrypoint: Entrypoint): string => {
  let current: { name: string; parents: ParentEntrypoint[] } = entrypoint;
  const seen = new Set<string>();

  while (current.parents.length > 0 && !seen.has(current.name)) {
    seen.add(current.name);
    [current] = current.parents;
  }

  return current.name;
};

const encodeGlobalsMemo = new WeakMap<object, Record<string, unknown>>();
const encodeGlobalsCached = (input: unknown): Record<string, unknown> => {
  if (input !== null && typeof input === 'object') {
    const obj = input as object;
    const cached = encodeGlobalsMemo.get(obj);
    if (cached) return cached;
    const encoded = encodeGlobals(input) as Record<string, unknown>;
    encodeGlobalsMemo.set(obj, encoded);
    return encoded;
  }
  return encodeGlobals(input) as Record<string, unknown>;
};

export const buildRunnerInitPayload = (
  services: Services,
  entrypoint: Entrypoint,
  featuresOverride?: FeatureFlags<'happyDOM'>
): EvalRunnerInitPayload => {
  const evalOptions = getEvalOptions(services);
  const { pluginOptions } = services.options;
  const root = services.options.root ?? process.cwd();
  const { overrideContext, importOverrides, extensions } = pluginOptions;
  const features = featuresOverride ?? pluginOptions.features;
  const baseGlobals: Record<string, unknown> = {
    ...(evalOptions.globals ?? {}),
  };
  const withFilename = {
    ...baseGlobals,
    __filename: entrypoint.name,
    __dirname: path.dirname(entrypoint.name),
  };
  const globals = overrideContext
    ? overrideContext(withFilename, entrypoint.name)
    : baseGlobals;
  const sanitizedGlobals = stripEntrypointGlobalsFromRunnerContext(
    globals,
    entrypoint.name
  );

  return {
    evalOptions: {
      globals: encodeGlobalsCached(sanitizedGlobals),
      importOverrides,
      errors: evalOptions.errors ?? 'strict',
      require: evalOptions.require ?? 'warn-and-run',
      root,
      extensions,
    },
    features,
    entrypoint: entrypoint.name,
  };
};

export const emitWarning = (services: Services, message: string) => {
  if (services.emitWarning) {
    services.emitWarning(message);
    return;
  }

  // eslint-disable-next-line no-console
  console.warn(message);
};

export const emitEvalWarning = (services: Services, warning: EvalWarning) => {
  const { onWarn } = getEvalOptions(services);
  onWarn?.(warning);
  emitWarning(services, warning.message);
};

const defaultImportLoaders: ImportLoaders = {
  raw: 'raw',
  url: 'url',
};

export const loadByImportLoaders = (
  services: Services,
  request: string,
  resolved: string,
  importer: string
): { handled: boolean; value: unknown } => {
  const { pluginOptions } = services.options;
  const importLoaders =
    pluginOptions.importLoaders === undefined
      ? defaultImportLoaders
      : { ...defaultImportLoaders, ...pluginOptions.importLoaders };

  const { query, hash } = parseRequest(request);
  if (!query) return { handled: false, value: undefined };

  const params = new URLSearchParams(query);
  const matchedKey = Array.from(params.keys()).find(
    (key) => importLoaders[key] !== undefined && importLoaders[key] !== false
  );

  if (!matchedKey) return { handled: false, value: undefined };

  const loader = importLoaders[matchedKey];

  const filename = stripQueryAndHash(resolved);
  const importerFilename = stripQueryAndHash(importer);
  const importerDir = path.dirname(importerFilename);

  const toUrl = () => {
    const relative = path
      .relative(importerDir, filename)
      .replace(/\\/g, path.posix.sep);

    if (relative.startsWith('.') || path.isAbsolute(relative)) {
      return relative;
    }

    return `./${relative}`;
  };

  const readFile = () => fs.readFileSync(filename, 'utf-8');

  const context: ImportLoaderContext = {
    importer: importerFilename,
    request,
    resolved,
    filename,
    query,
    hash,
    emitWarning: (message) => emitWarning(services, message),
    readFile,
    toUrl,
  };

  if (loader === 'raw') {
    return { handled: true, value: context.readFile() };
  }

  if (loader === 'url') {
    return { handled: true, value: context.toUrl() };
  }

  if (typeof loader === 'function') {
    return { handled: true, value: loader(context) };
  }

  return { handled: false, value: undefined };
};

export const hashContent = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

// A scoped broker must distinguish transform-cache lifecycles without keeping
// the latest cache (and its Entrypoint -> Services -> LoaderContext graph)
// alive. WeakMap values do not retain their keys when the token has no back
// reference to the cache.
const transformCacheSessionTokens = new WeakMap<
  TransformCacheCollection,
  { lifecycleVersion: number; token: object }
>();

export const getTransformCacheSessionToken = (
  cache: TransformCacheCollection
) => {
  const lifecycleVersion = cache.getCurrentEpoch().version;
  const cached = transformCacheSessionTokens.get(cache);
  if (cached?.lifecycleVersion === lifecycleVersion) return cached.token;
  const token = {};
  transformCacheSessionTokens.set(cache, { lifecycleVersion, token });
  return token;
};

export const formatLoaderResult = (code: string, loader?: string | null) => {
  if (loader === 'json') {
    return `export default ${JSON.stringify(JSON.parse(code))};`;
  }
  if (loader === 'raw' || loader === 'text') {
    return `export default ${JSON.stringify(code)};`;
  }
  return code;
};

export const toSerializedError = (error: unknown) => {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    message: err.message,
    name: err.name,
    stack: err.stack,
  };
};

export const createDetachedServices = (
  services: EpochServices
): EpochServices => {
  const cache = new TransformCacheCollection();
  return {
    ...services,
    asyncResolve: undefined,
    cache,
    cacheEpoch: cache.getCurrentEpoch(),
    emitWarning: undefined,
    evalBroker: undefined,
    eventEmitter: EventEmitter.dummy,
    loadAndParseFn: loadAndParse,
    loadDependencyCode: undefined,
    log: rootLog,
    options: {
      ...services.options,
      inputSourceMap: undefined,
    },
  };
};
