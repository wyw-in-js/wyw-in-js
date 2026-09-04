/* eslint-disable no-continue, no-plusplus, no-nested-ternary, no-void, no-await-in-loop, @typescript-eslint/no-use-before-define */
import { createHash } from 'crypto';
import fs from 'fs';
import NativeModule from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

import type {
  EvalOptionsV2,
  EvalWarning,
  FeatureFlags,
  ImportLoaderContext,
  ImportLoaders,
} from '@wyw-in-js/shared';
import { isFeatureEnabled } from '@wyw-in-js/shared';

import type { Entrypoint } from '../transform/Entrypoint';
import type { CacheRecoveryReason } from '../transform/actions/CacheEpochAbortedError';
import { TransformCacheCollection, type TransformCacheEpoch } from '../cache';
import type { ParentEntrypoint } from '../types';
import { isStaticallyEvaluatableModule } from '../transform/isStaticallyEvaluatableModule';
import type { Services } from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';
import { rootLog } from '../transform/rootLog';
import {
  applyImportOverrideToOnly,
  getImportOverride,
  resolveMockSpecifier,
  toImportKey,
} from '../utils/importOverrides';
import { getFileIdx } from '../utils/getFileIdx';
import { collectOxcExportsAndImports } from '../utils/collectOxcExportsAndImports';
import { resolveWithNativeResolver } from '../utils/nativeResolver';
import { parseRequest, stripQueryAndHash } from '../utils/parseRequest';
import {
  hasCachedWywPrevalExport,
  type CachedEntrypointLike,
} from '../utils/hasCachedWywPrevalExport';
import {
  isSuperSet,
  loadAndParse,
  mergeOnly,
} from '../transform/Entrypoint.helpers';
import { oxcShaker } from '../shaker';
import { analyzeOxcBarrelFile } from '../transform/oxcBarrelManifest';
import {
  beginEvalTelemetry,
  hasEvalTelemetryReporter,
  recordEvalBrokerLifecycle,
  type EvalBrokerLifecycleEvent,
  type EvalTelemetryToken,
} from '../debug/evalTelemetry';

import {
  type EvalRunnerInitPayload,
  type EvalResultPayload,
  type DebugEvalFileValues,
  type LoadRequestPayload,
  type LoadResultPayload,
  type MainToRunnerMessage,
  type ResolveRequestPayload,
  type RunnerToMainMessage,
} from './protocol';
import { LruCache } from './lru';
import {
  prepareModuleOnDemand,
  type PreparedModule,
} from './prepareModuleOnDemand';
import {
  deserializeValue,
  encodeGlobals,
  serializeValue,
  type SerializedValue,
} from './serialize';
import { createWriteQueue, type WriteQueue, writeToStream } from './writeQueue';
import {
  BrokerLoadMirror,
  createLoadTransmissionTelemetry,
  getRunnerStorage,
  hasSameBrokerStorageShape,
  hasSameRunnerStorageShape,
  sendEvalMessage,
  sendEvalLoadResult,
  type LoadTransmissionTelemetry,
} from './brokerTelemetry';
import { registerEvalBrokerRecoveryParticipant } from './brokerRegistry';
import {
  debugAction,
  debugEvalEnabled,
  dumpEvalCode,
  flushDebugStreams,
  getDebugValuesStatus,
  serializedExportsToDebugValues,
  toBase64,
  toJsonBase64,
  type DebugEvalValueStatus,
} from './debugEval';
import { getStableInitPayloadHash } from './stable-init-hash';

const DefaultModuleImplementation = NativeModule as typeof NativeModule & {
  builtinModules?: string[];
};

const isBuiltinSpecifier = (specifier: string) => {
  const normalized = specifier.startsWith('node:')
    ? specifier.slice(5)
    : specifier;
  return (
    DefaultModuleImplementation.builtinModules?.includes(normalized) ||
    DefaultModuleImplementation.builtinModules?.includes(`node:${normalized}`)
  );
};

const isVirtualSpecifier = (specifier: string) =>
  specifier.startsWith('/@') ||
  specifier.startsWith('virtual:') ||
  specifier.startsWith('\0');

const isEvalOnlyKey = (key: string) =>
  key === '__wywPreval' || key === 'side-effect';

const isPreparedOnlySuperSet = (
  currentOnly: string[],
  requestedOnly: string[]
): boolean => {
  if (
    requestedOnly.includes('__wywPreval') &&
    !currentOnly.includes('__wywPreval')
  ) {
    return false;
  }

  return isSuperSet(currentOnly, requestedOnly);
};

const hasPreparedExportKeys = (
  prepared: {
    code?: string;
    exports?: Record<string, SerializedValue>;
  },
  requestedOnly: string[]
): boolean => {
  const requestedKeys = requestedOnly.filter(
    (key) => !isEvalOnlyKey(key) && key !== '*'
  );

  if (requestedKeys.length === 0) {
    return true;
  }

  if (!prepared.exports) {
    if (!prepared.code) {
      return false;
    }

    try {
      const collected = collectOxcExportsAndImports(
        prepared.code,
        'prepared-module.js'
      );
      if (collected.reexports.some((reexport) => reexport.exported === '*')) {
        return true;
      }

      const exportNames = new Set([
        ...Object.keys(collected.exports),
        ...collected.reexports
          .filter((reexport) => reexport.exported !== '*')
          .map((reexport) => reexport.exported),
      ]);

      return requestedKeys.every((key) => exportNames.has(key));
    } catch {
      return false;
    }
  }

  return requestedKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(prepared.exports, key)
  );
};

const isPreparedCacheHit = (
  prepared: {
    exports?: Record<string, SerializedValue>;
    only: string[];
  },
  requestedOnly: string[]
): boolean =>
  isPreparedOnlySuperSet(prepared.only, requestedOnly) &&
  hasPreparedExportKeys(prepared, requestedOnly);

const isExportContainer = (
  value: unknown
): value is Record<string | symbol, unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

const hasCachedExport = (
  source: Record<string | symbol, unknown>,
  key: string
) => {
  if (Object.prototype.hasOwnProperty.call(source, key)) {
    return true;
  }
  if (key === 'default') {
    return false;
  }
  const fallback = source.default;
  return (
    isExportContainer(fallback) &&
    Object.prototype.hasOwnProperty.call(fallback, key)
  );
};

const resolveCachedExport = (
  source: Record<string | symbol, unknown>,
  key: string
) => {
  if (key === 'default') {
    return Object.prototype.hasOwnProperty.call(source, 'default')
      ? (source as Record<string, unknown>).default
      : undefined;
  }

  if (Object.prototype.hasOwnProperty.call(source, key)) {
    return (source as Record<string, unknown>)[key];
  }

  const fallback = (source as Record<string, unknown>).default;
  if (
    isExportContainer(fallback) &&
    Object.prototype.hasOwnProperty.call(fallback, key)
  ) {
    return (fallback as Record<string, unknown>)[key];
  }

  return undefined;
};

const serializeCachedExports = (
  exportsValue: Record<string | symbol, unknown>,
  requiredOnly: string[]
): Record<string, SerializedValue> | null => {
  if (requiredOnly.some(isEvalOnlyKey)) {
    return null;
  }

  const keys = requiredOnly.includes('*')
    ? Object.keys(exportsValue).filter((key) => !isEvalOnlyKey(key))
    : requiredOnly.filter((key) => !isEvalOnlyKey(key));

  if (keys.length === 0) {
    return null;
  }

  const serialized: Record<string, SerializedValue> = {};
  for (const key of keys) {
    if (!hasCachedExport(exportsValue, key)) {
      return null;
    }
    try {
      const encoded = serializeValue(resolveCachedExport(exportsValue, key));
      if (encoded.kind === 'function') {
        return null;
      }
      serialized[key] = encoded;
    } catch {
      return null;
    }
  }

  return serialized;
};

type CachedExportEntrypointLike = {
  evaluatedOnly?: string[];
  exports?: Record<string | symbol, unknown>;
  loadedAndParsed?: {
    code?: string;
    evalConfig?: { filename?: null | string };
    evaluator?: unknown;
  };
};

const collectKnownExportNames = (
  services: EpochServices,
  id: string,
  cachedEntrypoint?: CachedExportEntrypointLike
): string[] | undefined => {
  let knownExports = services.cache.get('exports', id) as string[] | undefined;
  if (knownExports || !cachedEntrypoint) {
    return knownExports;
  }

  const { loadedAndParsed } = cachedEntrypoint;
  if (loadedAndParsed?.evaluator !== oxcShaker || !loadedAndParsed.code) {
    return undefined;
  }

  const analyzed = collectOxcExportsAndImports(
    loadedAndParsed.code,
    loadedAndParsed.evalConfig?.filename ?? id
  );
  if (analyzed.reexports.some((reexport) => reexport.exported === '*')) {
    return undefined;
  }

  knownExports = Array.from(
    new Set([
      ...Object.keys(analyzed.exports),
      ...analyzed.reexports.map((reexport) => reexport.exported),
    ])
  );
  services.cache.publish(services.cacheEpoch, 'exports', id, knownExports);
  return knownExports;
};

const getSerializableStaticImportKeys = (
  services: EpochServices,
  id: string,
  cachedEntrypoint: CachedExportEntrypointLike,
  requiredOnly: string[],
  request?: string | null,
  importerId?: string | null
): string[] | null => {
  const isStaticImportLoad = Boolean(request && importerId);
  const requestedExports = requiredOnly.includes('*')
    ? null
    : requiredOnly.filter((key) => !isEvalOnlyKey(key) && key !== '*');
  const knownExports = collectKnownExportNames(
    services,
    id,
    cachedEntrypoint
  )?.filter((key) => !isEvalOnlyKey(key) && key !== '*');

  if (isStaticImportLoad) {
    if (
      !requestedExports?.length ||
      !knownExports?.length ||
      !isSuperSet(cachedEntrypoint.evaluatedOnly ?? [], knownExports)
    ) {
      return null;
    }

    if (!requestedExports.every((key) => knownExports.includes(key))) {
      return null;
    }

    return isSuperSet(cachedEntrypoint.evaluatedOnly ?? [], requestedExports)
      ? requestedExports
      : null;
  }

  if (knownExports?.length) {
    return isSuperSet(cachedEntrypoint.evaluatedOnly ?? [], knownExports)
      ? knownExports
      : null;
  }

  const evaluatedOnly = cachedEntrypoint.evaluatedOnly ?? requiredOnly;
  return requiredOnly.includes('*') ? evaluatedOnly : requiredOnly;
};

const DEFAULT_EVAL_OPTIONS: Required<
  Pick<EvalOptionsV2, 'errors' | 'require' | 'resolver'>
> = {
  errors: 'strict',
  require: 'warn-and-run',
  resolver: 'bundler',
};

const RESOLVE_CACHE_SIZE = 5000;
const LOAD_CACHE_SIZE = 1000;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/u;
const REQUEST_TIMEOUT_MS = 30_000;
const EVAL_TIMEOUT_MS = Number(process.env.WYW_EVAL_TIMEOUT_MS ?? 300_000);
const INIT_TIMEOUT_MS = 120_000;
const HAPPYDOM_INIT_TIMEOUT_MS = Number(
  process.env.WYW_EVAL_HAPPYDOM_INIT_TIMEOUT_MS ??
    process.env.WYW_HAPPYDOM_TIMEOUT_MS ??
    15_000
);

type ResolveCacheEntry = {
  resolvedId: string | null;
  external?: boolean;
  usedNativeFallback?: boolean;
};

type ResolveResult = ResolveCacheEntry & {
  only: string[];
};

type PreparedCacheEntry = PreparedModule & {
  hash: string;
  exports?: Record<string, SerializedValue>;
};

type CachedDependencyRecord = {
  only?: string[];
  resolved: string | null;
};

type CachedDependencyOwner = {
  dependencies?: Map<string, CachedDependencyRecord>;
  name: string;
};

type DirectBarrelBinding =
  | {
      kind: 'named';
      imported: string;
      source: string;
    }
  | {
      kind: 'namespace';
      source: string;
    };

type ModuleNameNode =
  | { type: 'Identifier'; name: string }
  | { type: 'StringLiteral'; value: string };

type ModuleSpecifierNode = {
  exportKind?: string | null;
  exported: ModuleNameNode;
  imported: ModuleNameNode;
  importKind?: string | null;
  local: ModuleNameNode & { name: string };
  type: string;
};

type ModuleStatement = {
  declaration: { name: string; type: string };
  exportKind?: string | null;
  importKind?: string | null;
  source: { value: string };
  specifiers: ModuleSpecifierNode[];
  type: string;
};

type ParsedModuleAst = {
  program: {
    body: ModuleStatement[];
  };
};

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type CacheGeneration = {
  invalidationError: Error | null;
};

type EvalRequestContext = {
  cacheGeneration: CacheGeneration;
  entrypoint: Entrypoint | null;
  epoch: number;
  inputQueue: WriteQueue;
  runner: ChildProcessWithoutNullStreams;
  sessionId: number;
  services: EpochServices;
};

type EvaluateResult = {
  values: Map<string, unknown> | null;
  dependencies: string[];
};

type EpochServices = Services & Required<Pick<Services, 'cacheEpoch'>>;

const bindServicesToEpoch = (
  services: Services,
  epoch: TransformCacheEpoch = services.cacheEpoch ??
    services.cache.getCurrentEpoch()
): EpochServices => {
  services.cache.assertEpoch(epoch);
  return services.cacheEpoch === epoch
    ? (services as EpochServices)
    : { ...services, cacheEpoch: epoch };
};

const getServicesCacheOwner = (services: EpochServices) =>
  services.cacheEpoch.owner;

type EvalFileDebugLine = {
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

type PendingEval = {
  cacheGeneration: CacheGeneration;
  entrypoint: Entrypoint;
  services: EpochServices;
  telemetry: EvalTelemetryToken | undefined;
  resolve: (value: EvaluateResult) => void;
  reject: (reason?: unknown) => void;
};

const isEvalTimeoutError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && (error as { code?: string }).code) {
    return (error as { code?: string }).code === 'WYW_EVAL_TIMEOUT';
  }
  return false;
};

const warnedUnknownImportsByServices = new WeakMap<Services, Set<string>>();

const getWarnedUnknownImports = (services: Services): Set<string> => {
  const cached = warnedUnknownImportsByServices.get(services);
  if (cached) return cached;
  const created = new Set<string>();
  warnedUnknownImportsByServices.set(services, created);
  return created;
};

const warnedSlowImportsByServices = new WeakMap<Services, Set<string>>();

const getWarnedSlowImports = (services: Services): Set<string> => {
  const cached = warnedSlowImportsByServices.get(services);
  if (cached) return cached;
  const created = new Set<string>();
  warnedSlowImportsByServices.set(services, created);
  return created;
};

const isWarningEnabled = (value: string | undefined): boolean =>
  Boolean(value) && value !== '0' && value !== 'false';

const getSlowImportThresholdMs = () => {
  const raw = process.env.WYW_WARN_SLOW_IMPORTS_MS;
  if (!raw) return 50;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 50;
  return parsed;
};

const getEvalOptions = (services: Services): EvalOptionsV2 => ({
  ...DEFAULT_EVAL_OPTIONS,
  ...(services.options.pluginOptions.eval ?? {}),
});

const buildRunnerPath = (): string => {
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

const getEntrypointResolveRoot = (entrypoint: Entrypoint): string => {
  let current: { name: string; parents: ParentEntrypoint[] } = entrypoint;
  const seen = new Set<string>();

  while (current.parents.length > 0 && !seen.has(current.name)) {
    seen.add(current.name);
    [current] = current.parents;
  }

  return current.name;
};

const buildRunnerInitPayload = (
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

const emitWarning = (services: Services, message: string) => {
  if (services.emitWarning) {
    services.emitWarning(message);
    return;
  }

  // eslint-disable-next-line no-console
  console.warn(message);
};

const emitEvalWarning = (services: Services, warning: EvalWarning) => {
  const { onWarn } = getEvalOptions(services);
  onWarn?.(warning);
  emitWarning(services, warning.message);
};

const defaultImportLoaders: ImportLoaders = {
  raw: 'raw',
  url: 'url',
};

const loadByImportLoaders = (
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

const hashContent = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

const isTypeOnlyImport = (statement: ModuleStatement): boolean => {
  if (statement.type !== 'ImportDeclaration') {
    return false;
  }

  if (statement.importKind === 'type') {
    return true;
  }

  if (statement.specifiers.length === 0) {
    return false;
  }

  return statement.specifiers.every(
    (specifier) =>
      specifier.type === 'ImportSpecifier' && specifier.importKind === 'type'
  );
};

const isTypeOnlyExport = (statement: ModuleStatement): boolean =>
  statement.exportKind === 'type';

const getModuleExportName = (node: ModuleNameNode): string =>
  node.type === 'Identifier' ? node.name : node.value;

const getImportSpecifierName = (specifier: ModuleSpecifierNode): string =>
  getModuleExportName(specifier.imported);

const buildDirectBarrelProxy = (
  services: Services,
  id: string,
  only: string[]
): PreparedModule | null => {
  const requested = only.filter((key) => !isEvalOnlyKey(key));
  if (requested.length === 0 || requested.includes('*')) {
    return null;
  }

  const loadedAndParsed = services.loadAndParseFn(
    services,
    id,
    undefined,
    services.log
  );

  if (
    loadedAndParsed.evaluator === 'ignored' ||
    loadedAndParsed.ast === undefined
  ) {
    return null;
  }

  if (loadedAndParsed.evaluator === oxcShaker) {
    return buildDirectOxcBarrelProxy(id, loadedAndParsed.code, only);
  }

  const importedBindings = new Map<string, DirectBarrelBinding>();
  const exportedBindings = new Map<string, DirectBarrelBinding>();
  const ast = loadedAndParsed.ast as unknown as ParsedModuleAst;

  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration') {
      if (isTypeOnlyImport(statement)) {
        continue;
      }

      if (statement.specifiers.length === 0) {
        return null;
      }

      for (const specifier of statement.specifiers) {
        if (
          specifier.type === 'ImportSpecifier' &&
          specifier.importKind === 'type'
        ) {
          continue;
        }

        if (specifier.type === 'ImportSpecifier') {
          importedBindings.set(specifier.local.name, {
            kind: 'named',
            imported: getImportSpecifierName(specifier),
            source: statement.source.value,
          });
          continue;
        }

        if (specifier.type === 'ImportDefaultSpecifier') {
          importedBindings.set(specifier.local.name, {
            kind: 'named',
            imported: 'default',
            source: statement.source.value,
          });
          continue;
        }

        importedBindings.set(specifier.local.name, {
          kind: 'namespace',
          source: statement.source.value,
        });
      }

      continue;
    }

    if (statement.type === 'ExportNamedDeclaration') {
      if (isTypeOnlyExport(statement)) {
        continue;
      }

      if (statement.source) {
        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ExportSpecifier') {
            if (specifier.exportKind === 'type') {
              continue;
            }

            exportedBindings.set(getModuleExportName(specifier.exported), {
              kind: 'named',
              imported: getModuleExportName(specifier.local),
              source: statement.source.value,
            });
            continue;
          }

          if (specifier.type === 'ExportDefaultSpecifier') {
            exportedBindings.set(getModuleExportName(specifier.exported), {
              kind: 'named',
              imported: 'default',
              source: statement.source.value,
            });
            continue;
          }

          if (specifier.type === 'ExportNamespaceSpecifier') {
            exportedBindings.set(getModuleExportName(specifier.exported), {
              kind: 'namespace',
              source: statement.source.value,
            });
            continue;
          }

          return null;
        }

        continue;
      }

      if (statement.declaration) {
        return null;
      }

      for (const specifier of statement.specifiers) {
        if (
          specifier.type !== 'ExportSpecifier' ||
          specifier.exportKind === 'type'
        ) {
          return null;
        }

        if (specifier.local.type !== 'Identifier') {
          return null;
        }

        const binding = importedBindings.get(specifier.local.name);
        if (!binding) {
          return null;
        }

        exportedBindings.set(getModuleExportName(specifier.exported), binding);
      }

      continue;
    }

    if (statement.type === 'ExportDefaultDeclaration') {
      if (statement.declaration.type !== 'Identifier') {
        return null;
      }

      const binding = importedBindings.get(statement.declaration.name);
      if (!binding || binding.kind !== 'named') {
        return null;
      }

      exportedBindings.set('default', binding);
      continue;
    }

    if (
      statement.type === 'EmptyStatement' ||
      statement.type === 'TSDeclareFunction' ||
      statement.type === 'TSInterfaceDeclaration' ||
      statement.type === 'TSTypeAliasDeclaration'
    ) {
      continue;
    }

    return null;
  }

  const imports = new Map<string, string[]>();
  const lines: string[] = [];
  let namespaceIdx = 0;

  const addImport = (source: string, imported: string) => {
    if (!imports.has(source)) {
      imports.set(source, []);
    }

    const bucket = imports.get(source)!;
    if (!bucket.includes(imported)) {
      bucket.push(imported);
    }
  };

  for (const exported of requested) {
    const binding = exportedBindings.get(exported);
    if (!binding) {
      return null;
    }

    if (binding.kind === 'namespace') {
      if (exported === 'default' || !IDENTIFIER_RE.test(exported)) {
        return null;
      }

      const local = `__wyw_ns_${namespaceIdx++}`;
      lines.push(
        `import * as ${local} from ${JSON.stringify(binding.source)};`
      );
      lines.push(`export { ${local} as ${exported} };`);
      addImport(binding.source, '*');
      continue;
    }

    if (
      binding.imported !== 'default' &&
      !IDENTIFIER_RE.test(binding.imported)
    ) {
      return null;
    }

    if (exported !== 'default' && !IDENTIFIER_RE.test(exported)) {
      return null;
    }

    const imported =
      binding.imported === 'default' ? 'default' : binding.imported;
    const exportClause =
      exported === 'default'
        ? `${imported} as default`
        : imported === exported
        ? imported
        : `${imported} as ${exported}`;

    lines.push(
      `export { ${exportClause} } from ${JSON.stringify(binding.source)};`
    );
    addImport(binding.source, binding.imported);
  }

  if (lines.length === 0) {
    return null;
  }

  return {
    code: `${lines.join('\n')}\n`,
    imports,
    only,
  };
};

const buildDirectOxcBarrelProxy = (
  id: string,
  code: string,
  only: string[]
): PreparedModule | null => {
  const requested = only.filter((key) => !isEvalOnlyKey(key));
  const analyzed = analyzeOxcBarrelFile(code, id);
  if (!('reexports' in analyzed)) {
    return null;
  }

  const imports = new Map<string, string[]>();
  const lines: string[] = [];
  let namespaceIdx = 0;

  const addImport = (source: string, imported: string) => {
    if (!imports.has(source)) {
      imports.set(source, []);
    }

    const bucket = imports.get(source)!;
    if (!bucket.includes(imported)) {
      bucket.push(imported);
    }
  };

  for (const exported of requested) {
    const binding = analyzed.reexports.find(
      (reexport) => reexport.exported === exported
    );
    if (!binding) {
      return null;
    }

    if (binding.kind === 'namespace') {
      if (exported === 'default' || !IDENTIFIER_RE.test(exported)) {
        return null;
      }

      const local = `__wyw_ns_${namespaceIdx++}`;
      lines.push(
        `import * as ${local} from ${JSON.stringify(binding.source)};`
      );
      lines.push(`export { ${local} as ${exported} };`);
      addImport(binding.source, '*');
      continue;
    }

    if (
      binding.imported !== 'default' &&
      !IDENTIFIER_RE.test(binding.imported)
    ) {
      return null;
    }

    if (exported !== 'default' && !IDENTIFIER_RE.test(exported)) {
      return null;
    }

    const imported =
      binding.imported === 'default' ? 'default' : binding.imported;
    const exportClause =
      exported === 'default'
        ? `${imported} as default`
        : imported === exported
        ? imported
        : `${imported} as ${exported}`;

    lines.push(
      `export { ${exportClause} } from ${JSON.stringify(binding.source)};`
    );
    addImport(binding.source, binding.imported);
  }

  if (lines.length === 0) {
    return null;
  }

  return {
    code: `${lines.join('\n')}\n`,
    imports,
    only,
  };
};

// Memoize encodeGlobals on input reference. The user's globals object is
// stable across a build, so we can encode it once instead of per evaluate.
// If the input ref changes, fall through to a fresh encode (and reset the
// cache).
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

// A scoped broker must distinguish transform-cache lifecycles without keeping
// the latest cache (and its Entrypoint -> Services -> LoaderContext graph)
// alive. WeakMap values do not retain their keys when the token has no back
// reference to the cache.
const transformCacheSessionTokens = new WeakMap<
  TransformCacheCollection,
  { lifecycleVersion: number; token: object }
>();
const getTransformCacheSessionToken = (cache: TransformCacheCollection) => {
  const lifecycleVersion = cache.getLifecycleVersion();
  const cached = transformCacheSessionTokens.get(cache);
  if (cached?.lifecycleVersion === lifecycleVersion) return cached.token;
  const token = {};
  transformCacheSessionTokens.set(cache, { lifecycleVersion, token });
  return token;
};

const formatLoaderResult = (code: string, loader?: string | null) => {
  if (loader === 'json') {
    return `export default ${JSON.stringify(JSON.parse(code))};`;
  }
  if (loader === 'raw' || loader === 'text') {
    return `export default ${JSON.stringify(code)};`;
  }
  return code;
};

const toSerializedError = (error: unknown) => {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    message: err.message,
    name: err.name,
    stack: err.stack,
  };
};

const createDetachedServices = (services: EpochServices): EpochServices => {
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

export class EvalBroker {
  private runner: ChildProcessWithoutNullStreams | null = null;

  private runnerInputQueue: WriteQueue | null = null;

  private runnerOutputBuffer = '';

  private requestEpoch = 0;

  private readonly cacheGenerations = new WeakMap<
    TransformCacheEpoch['owner'],
    CacheGeneration
  >();

  private nextRunnerSessionId = 0;

  private activeRunnerSessionId = 0;

  private runnerReady: Promise<void> | null = null;

  private readonly isolatedRunners = new Set<ChildProcessWithoutNullStreams>();

  private lastInitKey: string | null = null;

  private lastHappyDomEnabled = false;

  private hasSemanticSession = false;

  private semanticSessionKey: string | Services | undefined;

  private semanticSessionCacheToken: object | undefined;

  private semanticSessionCacheGeneration: CacheGeneration | undefined;

  private evalQueue: Promise<void> = Promise.resolve();

  private disposed = false;

  public get isDisposed(): boolean {
    return this.disposed;
  }

  private readonly pending = new Map<string, PendingRequest>();

  private nextId = 0;

  private readonly resolveCache = new LruCache<string, ResolveCacheEntry>(
    RESOLVE_CACHE_SIZE
  );

  private readonly resolveInFlight = new Map<
    string,
    Promise<ResolveCacheEntry>
  >();

  private readonly loadCache = new LruCache<string, PreparedCacheEntry>(
    LOAD_CACHE_SIZE
  );

  private readonly loadInFlight = new Map<
    string,
    Promise<PreparedCacheEntry>
  >();

  // An invalidated id must keep asking the runner to drop its exact module
  // state until a complete LOAD_RESULT carrying resetModule is written.
  private readonly pendingModuleResets = new Set<string>();

  private readonly importsByModule = new Map<string, Map<string, string[]>>();

  private readonly onlyByModule = new Map<string, string[]>();

  // Modules that are part of the current eval session's link graph. Used
  // to scope `mergeKnownDependencyOnly` to entrypoints that share the
  // current runner's VM, instead of unioning across every cached
  // entrypoint project-wide. Cleared whenever the runner is killed or
  // respawned (mirrors loadMirror).
  private readonly sessionLinkGraph = new Set<string>();

  private readonly runtimeDependenciesByModule = new Map<string, Set<string>>();

  private readonly emittedDependencies = new Set<string>();

  private readonly loadMirror = new BrokerLoadMirror();

  // Batch queue: concurrent evaluate() callers (e.g. parallel webpack-loader
  // transform() invocations) pile up here within one event-loop turn, then a
  // microtask flushes them as a single sequential runner pass. Each call
  // still gets its own resolved Promise; this only collapses the per-call
  // evalQueue chain + state-clear churn.
  private pendingEvals: PendingEval[] = [];

  private readonly unsettledEvals = new Set<PendingEval>();

  private readonly evalsWithStartedTelemetry = new WeakSet<PendingEval>();

  private evalFlushScheduled = false;

  // Cached stable init payload hash. Keyed on the refs that feed the stable
  // bits (pluginOptions.eval and pluginOptions itself). Any reference change
  // invalidates the cache. The full per-entrypoint init key is
  // `${stableHash}::${entrypoint.name}` — cheap string concat instead of
  // re-canonicalizing+stringifying+SHA-256ing the whole payload per call.
  private stableInitHashCache: {
    pluginOptionsRef: unknown;
    evalOptionsRef: unknown;
    featuresRef: FeatureFlags<'happyDOM'>;
    rootRef: string | undefined;
    hash: string;
  } | null = null;

  private evalSeq = 0;

  private evalFileDebugLines: EvalFileDebugLine[] | null = null;

  private happyDomDisabled = false;

  private happyDomDisableWarned = false;

  private activeResolveRootId: string | null = null;

  private activeEntrypoint: Entrypoint | null = null;

  private activeEvalTelemetry: EvalTelemetryToken | undefined;

  private currentServices: EpochServices;

  private readonly detachedServices: EpochServices | null;

  private readonly sendLoadMessage = (
    message: MainToRunnerMessage,
    onSerialized?: (bytes: number) => void
  ): Promise<void> => this.sendMessage(message, onSerialized);

  constructor(
    services: Services,
    private readonly fallbackAsyncResolve: (
      what: string,
      importer: string,
      stack: string[]
    ) => Promise<string | null>,
    detachServicesWhenIdle = false
  ) {
    const epochServices = bindServicesToEpoch(services);
    this.currentServices = epochServices;
    registerEvalBrokerRecoveryParticipant(
      getServicesCacheOwner(epochServices),
      this
    );
    this.detachedServices = detachServicesWhenIdle
      ? createDetachedServices(epochServices)
      : null;
    this.recordBrokerLifecycle('broker-created', 'constructor');
    this.detachCurrentServices();
  }

  private detachCurrentServices(): void {
    if (this.detachedServices) {
      this.currentServices = this.detachedServices;
    }
  }

  private beginRunnerSession(
    payload: EvalRunnerInitPayload
  ): EvalRunnerInitPayload {
    this.nextRunnerSessionId += 1;
    this.activeRunnerSessionId = this.nextRunnerSessionId;
    return { ...payload, sessionId: this.activeRunnerSessionId };
  }

  private beginIsolatedRunnerSession(payload: EvalRunnerInitPayload): {
    payload: EvalRunnerInitPayload;
    sessionId: number;
  } {
    this.nextRunnerSessionId += 1;
    return {
      payload: { ...payload, sessionId: this.nextRunnerSessionId },
      sessionId: this.nextRunnerSessionId,
    };
  }

  private async initActiveRunner(
    payload: EvalRunnerInitPayload,
    timeoutMs: number
  ): Promise<void> {
    const sessionPayload = this.beginRunnerSession(payload);
    await this.request('INIT', sessionPayload, timeoutMs);
  }

  private recordBrokerLifecycle(
    event: EvalBrokerLifecycleEvent,
    reason: string,
    includeMirror = false
  ): void {
    const { eventEmitter } = this.currentServices;
    if (!hasEvalTelemetryReporter(eventEmitter)) return;
    recordEvalBrokerLifecycle(eventEmitter, this, () => ({
      event,
      reason,
      ...(includeMirror ? { mirror: this.loadMirror.snapshot() } : {}),
    }));
  }

  private ensureImportsMapping(
    id: string,
    imports: Map<string, string[]> | null | undefined
  ) {
    if (!imports || imports.size === 0) {
      if (!this.importsByModule.has(id)) {
        this.importsByModule.set(id, new Map());
      }
      return;
    }

    const existing = this.importsByModule.get(id);
    if (!existing || existing.size === 0) {
      this.importsByModule.set(id, imports);
      return;
    }

    // Merge: widen each specifier's import list rather than replacing.
    // Different variants of the same module may import different subsets
    // from the same dependency. The widest set must be preserved so that
    // any still-linking variant can resolve all its bindings.
    for (const [specifier, keys] of imports) {
      const existingKeys = existing.get(specifier);
      if (!existingKeys) {
        existing.set(specifier, keys);
      } else {
        existing.set(specifier, mergeOnly(existingKeys, keys));
      }
    }
  }

  private getImportOnly(
    importerId: string | null | undefined,
    specifier: string
  ): string[] {
    const importsOnly = importerId
      ? this.importsByModule.get(importerId)?.get(specifier)
      : undefined;
    const importerOnly = importerId
      ? this.onlyByModule.get(importerId) ?? ['*']
      : ['*'];
    return importerOnly.includes('__wywPreval')
      ? mergeOnly(importsOnly ?? ['*'], ['__wywPreval'])
      : importsOnly ?? ['*'];
  }

  private getLoadRequestOnly(
    id: string,
    importerId: string | null | undefined,
    request: string | null | undefined
  ): string[] | null {
    if (!request || !importerId || importerId === id) {
      return null;
    }

    const imports = this.importsByModule.get(importerId);
    if (!imports?.has(request)) {
      return null;
    }

    const { root } = this.currentServices.options;
    const keyInfo = toImportKey({
      source: request,
      resolved: id,
      root,
    });
    const override = getImportOverride(
      this.currentServices.options.pluginOptions.importOverrides,
      keyInfo.key
    );
    let nextOnly = applyImportOverrideToOnly(
      this.getImportOnly(importerId, request),
      override
    );
    const cached = this.currentServices.cache.get('entrypoints', id) as
      | CachedEntrypointLike
      | undefined;
    if (
      nextOnly.includes('__wywPreval') &&
      cached?.evaluated &&
      !cached.ignored &&
      !hasCachedWywPrevalExport(this.currentServices, id, cached)
    ) {
      nextOnly = nextOnly.filter((item) => item !== '__wywPreval');
    }

    return nextOnly;
  }

  public async evaluate(
    entrypoint: Entrypoint,
    services?: Services
  ): Promise<EvaluateResult> {
    if (this.disposed) {
      throw new Error('[wyw-in-js] Eval broker has been disposed');
    }
    const activeServices = bindServicesToEpoch(
      services ?? this.currentServices,
      entrypoint.cacheEpoch
    );
    registerEvalBrokerRecoveryParticipant(
      getServicesCacheOwner(activeServices),
      this
    );
    const telemetry = hasEvalTelemetryReporter(activeServices.eventEmitter)
      ? beginEvalTelemetry(activeServices.eventEmitter, this, () => ({
          entrypoint: entrypoint.name,
        }))
      : undefined;
    return new Promise<EvaluateResult>((resolve, reject) => {
      const pendingEval: PendingEval = {
        cacheGeneration: this.getCacheGeneration(
          getServicesCacheOwner(activeServices)
        ),
        entrypoint,
        services: activeServices,
        telemetry,
        resolve,
        reject,
      };
      this.pendingEvals.push(pendingEval);
      this.unsettledEvals.add(pendingEval);
      this.scheduleEvalFlush();
    });
  }

  private scheduleEvalFlush() {
    if (this.evalFlushScheduled) return;
    this.evalFlushScheduled = true;
    queueMicrotask(() => {
      this.evalFlushScheduled = false;
      if (this.pendingEvals.length === 0) return;
      const batch = this.pendingEvals;
      this.pendingEvals = [];
      this.evalQueue = this.evalQueue.then(() => this.runEvalBatch(batch));
    });
  }

  private startPendingEval(
    member: PendingEval,
    batchIndex: number,
    batchSize: number
  ): void {
    if (this.evalsWithStartedTelemetry.has(member)) return;
    this.evalsWithStartedTelemetry.add(member);
    member.telemetry?.start({ batchIndex, batchSize });
  }

  private resolvePendingEval(
    member: PendingEval,
    result: EvaluateResult
  ): void {
    if (!this.unsettledEvals.delete(member)) return;
    member.telemetry?.finish(
      result.values ? 'success' : 'no-values',
      this.loadMirror.snapshot()
    );
    member.resolve(result);
  }

  private rejectPendingEval(member: PendingEval, error: unknown): void {
    if (!this.unsettledEvals.delete(member)) return;
    member.telemetry?.finish('error', this.loadMirror.snapshot());
    member.reject(error);
  }

  private async runEvalBatch(batch: PendingEval[]): Promise<void> {
    try {
      for (const [batchIndex, member] of batch.entries()) {
        if (!this.unsettledEvals.has(member)) continue;
        const { telemetry } = member;
        this.startPendingEval(member, batchIndex, batch.length);
        this.activeEvalTelemetry = telemetry;
        try {
          if (this.disposed) {
            throw new Error('[wyw-in-js] Eval broker has been disposed');
          }
          this.assertCacheGeneration(
            getServicesCacheOwner(member.services),
            member.cacheGeneration,
            member.entrypoint
          );
          this.currentServices = member.services;
          const result = await this.runOneEntrypoint(
            member.entrypoint,
            member.services,
            member.cacheGeneration
          );
          this.resolvePendingEval(member, result);
        } catch (error) {
          this.rejectPendingEval(member, error);
        } finally {
          if (this.activeEvalTelemetry === telemetry) {
            this.activeEvalTelemetry = undefined;
          }
        }
      }
    } finally {
      this.detachCurrentServices();
    }
  }

  private async runOneEntrypoint(
    entrypoint: Entrypoint,
    activeServices: EpochServices,
    cacheGeneration: CacheGeneration
  ): Promise<EvaluateResult> {
    this.assertCacheGeneration(
      getServicesCacheOwner(activeServices),
      cacheGeneration,
      entrypoint
    );
    const resolveRootId = getEntrypointResolveRoot(entrypoint);
    this.currentServices = activeServices;
    // configureEvalSession always provides a hash. Direct EvalBroker users
    // predate that API, so fall back to the per-invocation Services identity
    // instead of treating every missing key as one reusable semantic scope.
    const nextSemanticSessionKey =
      activeServices.evalCacheKey ?? activeServices;
    const nextSemanticSessionCacheToken = getTransformCacheSessionToken(
      activeServices.cache
    );
    const reuseModules =
      this.hasSemanticSession &&
      this.semanticSessionKey === nextSemanticSessionKey &&
      this.semanticSessionCacheToken === nextSemanticSessionCacheToken &&
      this.semanticSessionCacheGeneration === cacheGeneration;
    if (!reuseModules) {
      this.resetSemanticSessionState();
    }
    // INIT may mutate/reset the runner before failing. Until it succeeds the
    // next job must conservatively start a new semantic VM session.
    this.hasSemanticSession = false;
    this.semanticSessionKey = undefined;
    this.semanticSessionCacheToken = undefined;
    this.semanticSessionCacheGeneration = undefined;
    this.activeResolveRootId = resolveRootId;
    this.activeEntrypoint = entrypoint;
    this.resetPerEntrypointState(entrypoint);
    this.evalSeq += 1;
    this.evalFileDebugLines = activeServices.eventEmitter.enabled ? [] : null;

    if (debugEvalEnabled) {
      debugAction({
        type: 'eval:start',
        evalSeq: this.evalSeq,
        entrypoint: entrypoint.name,
        ts: performance.now(),
      });
    }

    try {
      // Mark this cache as active before waiting for a runner. A reset from
      // the previous batch member must not retire a runner that this member is
      // already preparing to reinitialize for its own semantic session.
      await this.ensureRunner();
      this.assertCacheGeneration(
        getServicesCacheOwner(activeServices),
        cacheGeneration,
        entrypoint
      );
      await this.initRunner(entrypoint, reuseModules, cacheGeneration);
      this.assertCacheGeneration(
        getServicesCacheOwner(activeServices),
        cacheGeneration,
        entrypoint
      );
      this.hasSemanticSession = true;
      this.semanticSessionKey = nextSemanticSessionKey;
      this.semanticSessionCacheToken = nextSemanticSessionCacheToken;
      this.semanticSessionCacheGeneration = cacheGeneration;

      const payload = await this.request<EvalResultPayload>(
        'EVAL',
        { id: entrypoint.name },
        EVAL_TIMEOUT_MS
      );

      // The cache can be invalidated while the runner is evaluating. Do not
      // let a response from the superseded generation publish module exports
      // into the replacement entrypoint's shared cache.
      this.assertCacheGeneration(
        getServicesCacheOwner(activeServices),
        cacheGeneration,
        entrypoint
      );

      this.flushEvalFileDebugLines(payload.debugEvalFiles);

      if (debugEvalEnabled) {
        debugAction({
          type: 'eval:finish',
          evalSeq: this.evalSeq,
          entrypoint: entrypoint.name,
          hasValues: Boolean(payload.values),
          ts: performance.now(),
        });
      }

      if (payload.modules) {
        this.applyModuleExports(payload.modules);
      }

      if (!payload.values) {
        return { values: null, dependencies: [] };
      }

      const values = new Map<string, unknown>();
      Object.entries(payload.values).forEach(([key, serialized]) => {
        values.set(key, deserializeValue(serialized));
      });

      return {
        values,
        dependencies: this.collectEntrypointDependencies(entrypoint.name),
      };
    } catch (error) {
      // A failed EVAL can leave arbitrary async work running in its VM. Stop
      // that child so no continuation can mutate the next semantic session.
      this.hasSemanticSession = false;
      this.semanticSessionKey = undefined;
      this.semanticSessionCacheToken = undefined;
      this.semanticSessionCacheGeneration = undefined;
      const failedRunner = this.runner;
      if (failedRunner) {
        this.retireRunner(
          failedRunner,
          'eval-error',
          error instanceof Error ? error : new Error(String(error))
        );
      }
      throw error;
    } finally {
      this.evalFileDebugLines = null;
      if (this.activeResolveRootId === resolveRootId) {
        this.activeResolveRootId = null;
      }
      if (this.activeEntrypoint === entrypoint) {
        this.activeEntrypoint = null;
      }
    }
  }

  private recordEvalFileDebugLine(
    payload: LoadRequestPayload,
    prepared: PreparedCacheEntry,
    shouldShipCode: boolean
  ) {
    if (!this.evalFileDebugLines) {
      return;
    }

    if (shouldShipCode && prepared.code) {
      this.evalFileDebugLines.push({
        contentBase64: toBase64(prepared.code),
        evalSeq: this.evalSeq,
        hash: prepared.hash ?? null,
        id: payload.id,
        importer: payload.importerId ?? null,
        only: prepared.only,
        payloadKind: 'code',
        request: payload.request ?? null,
        type: 'eval-file',
        valueStatus: 'none',
        valuesBase64: null,
      });
      return;
    }

    if (prepared.exports) {
      const values = serializedExportsToDebugValues(prepared.exports);
      this.evalFileDebugLines.push({
        contentBase64: null,
        evalSeq: this.evalSeq,
        hash: prepared.hash ?? null,
        id: payload.id,
        importer: payload.importerId ?? null,
        only: prepared.only,
        payloadKind: 'serialized-exports',
        request: payload.request ?? null,
        type: 'eval-file',
        valueStatus: getDebugValuesStatus(values),
        valuesBase64: toJsonBase64(values),
      });
    }
  }

  private flushEvalFileDebugLines(
    valuesById: Record<string, DebugEvalFileValues> | undefined
  ) {
    const lines = this.evalFileDebugLines;
    if (!lines) {
      return;
    }

    for (const line of lines) {
      this.currentServices.eventEmitter.single({
        ...line,
        valueStatus:
          line.valueStatus === 'none'
            ? getDebugValuesStatus(valuesById?.[line.id])
            : line.valueStatus,
        valuesBase64:
          line.valuesBase64 ?? toJsonBase64(valuesById?.[line.id] ?? {}),
      });
    }
  }

  private resetPerEntrypointState(entrypoint: Entrypoint) {
    this.requestEpoch += 1;
    // A completed EVAL may leave a fire-and-forget dynamic import preparing
    // in the background. Its per-id predecessor belongs to the old request
    // epoch and must not block a fresh LOAD for the next entrypoint. The old
    // task's identity-checked finally cannot remove a newer replacement.
    this.loadInFlight.clear();
    this.runtimeDependenciesByModule.clear();
    this.emittedDependencies.clear();
    this.importsByModule.clear();
    this.onlyByModule.clear();
    this.resolveCache.clear();
    this.resolveInFlight.clear();
    this.sessionLinkGraph.clear();
    this.sessionLinkGraph.add(entrypoint.name);
    this.onlyByModule.set(entrypoint.name, ['__wywPreval']);
  }

  private resetSemanticSessionState() {
    this.requestEpoch += 1;
    this.loadCache.clear();
    this.loadInFlight.clear();
    this.resolveCache.clear();
    this.resolveInFlight.clear();
    this.importsByModule.clear();
    this.onlyByModule.clear();
    this.runtimeDependenciesByModule.clear();
    this.emittedDependencies.clear();
    this.loadMirror.clear();
    this.sessionLinkGraph.clear();
    this.lastInitKey = null;
    this.stableInitHashCache = null;
  }

  private applyModuleExports(
    modules: Record<string, Record<string, SerializedValue>>
  ) {
    Object.entries(modules).forEach(([id, serializedExports]) => {
      if (!serializedExports || Object.keys(serializedExports).length === 0) {
        return;
      }

      const cached = this.currentServices.cache.get('entrypoints', id);
      if (!cached || cached.ignored) {
        return;
      }

      const existingEvaluatedOnly = cached.evaluatedOnly ?? [];
      const target =
        cached.evaluated || !('createEvaluated' in cached)
          ? cached
          : cached.createEvaluated(this.currentServices);

      const exportsProxy = target.exports;
      Object.entries(serializedExports).forEach(([key, serialized]) => {
        exportsProxy[key] = deserializeValue(serialized);
      });

      const knownExports = collectKnownExportNames(
        this.currentServices,
        id,
        target
      );
      const serializedKeys = Object.keys(serializedExports);
      const coversAllKnownExports =
        Array.isArray(knownExports) &&
        knownExports.filter((key) => !isEvalOnlyKey(key)).length > 0 &&
        knownExports
          .filter((key) => !isEvalOnlyKey(key))
          .every((key) => serializedKeys.includes(key));
      const coversModule = coversAllKnownExports;
      const merged = mergeOnly(
        existingEvaluatedOnly,
        coversModule ? ['*'] : serializedKeys
      );
      if (target.evaluatedOnly) {
        target.evaluatedOnly.splice(0, target.evaluatedOnly.length, ...merged);
      }

      this.currentServices.cache.publish(
        this.currentServices.cacheEpoch,
        'entrypoints',
        id,
        target
      );
    });
  }

  private retireRunner(
    runner: ChildProcessWithoutNullStreams,
    reason: string,
    error: Error
  ): void {
    if (this.runner !== runner) return;

    this.recordBrokerLifecycle('runner-stop-requested', reason, true);
    this.rejectAllPending(error);
    this.runner = null;
    this.runnerReady = null;
    this.runnerInputQueue = null;
    this.lastInitKey = null;
    this.lastHappyDomEnabled = false;
    this.hasSemanticSession = false;
    this.semanticSessionKey = undefined;
    this.semanticSessionCacheToken = undefined;
    this.semanticSessionCacheGeneration = undefined;
    this.activeRunnerSessionId = 0;
    this.requestEpoch += 1;
    this.runnerOutputBuffer = '';
    this.loadMirror.clear();
    this.pendingModuleResets.clear();
    this.sessionLinkGraph.clear();
    runner.removeAllListeners();
    runner.kill();
  }

  public dispose(reason = 'explicit') {
    if (this.disposed) return;
    this.disposed = true;
    this.recordBrokerLifecycle('broker-dispose-observed', reason, true);
    const error = new Error('[wyw-in-js] Eval broker has been disposed');
    this.pendingEvals = [];
    const unsettled = [...this.unsettledEvals];
    for (const [batchIndex, member] of unsettled.entries()) {
      this.startPendingEval(member, batchIndex, unsettled.length);
      this.rejectPendingEval(member, error);
    }
    if (this.runner) {
      this.retireRunner(this.runner, reason, error);
    } else {
      this.requestEpoch += 1;
      this.rejectAllPending(error);
    }
    this.stopIsolatedRunners();
    this.clearEvaluationState();
    flushDebugStreams();
  }

  public resetAfterCacheInvalidation(
    cache: TransformCacheEpoch['owner'],
    error: Error,
    reason: CacheRecoveryReason
  ): void {
    const invalidatedGeneration = this.getCacheGeneration(cache);
    invalidatedGeneration.invalidationError = error;
    this.cacheGenerations.set(cache, { invalidationError: null });

    // Reject every unsettled evaluation from the discarded generation,
    // including members already captured by runEvalBatch. Preserve work owned
    // by other cache lifecycles: a scoped broker may serve several at once.
    const invalidated = [...this.unsettledEvals].filter(
      (member) => member.cacheGeneration === invalidatedGeneration
    );
    this.pendingEvals = this.pendingEvals.filter((member) =>
      this.unsettledEvals.has(member)
    );
    for (const [batchIndex, member] of invalidated.entries()) {
      this.startPendingEval(member, batchIndex, invalidated.length);
      this.rejectPendingEval(member, error);
    }

    // A reset from cache A must not interrupt an active evaluation owned by
    // cache B. An idle runner still owned by A is retired so asynchronous VM
    // continuations from its old generation cannot reach A's replacement.
    const ownsActiveEvaluation =
      this.activeEntrypoint !== null &&
      getServicesCacheOwner(this.currentServices) === cache;
    const ownsIdleSemanticSession =
      this.activeEntrypoint === null &&
      this.semanticSessionCacheGeneration === invalidatedGeneration;
    if (!ownsActiveEvaluation && !ownsIdleSemanticSession) {
      return;
    }

    // Do not wait behind evalQueue: a custom loader or resolver can remain
    // pending far longer than the transform that invalidated it. Advance the
    // runner generation first, then reject EVAL/INIT and stop the process so
    // the active batch settles immediately. Async LOAD/RESOLVE continuations
    // capture their generation and response queue; they cannot commit state or
    // write a late response into the replacement runner.
    this.requestEpoch += 1;
    this.recordBrokerLifecycle(
      'broker-dispose-observed',
      `cache-invalidation:${reason}`,
      true
    );
    this.rejectAllPending(error);
    this.stopRunner(`cache-invalidation:${reason}`);
    this.stopIsolatedRunners();
    this.clearEvaluationState();
    flushDebugStreams();
  }

  private stopRunner(reason: string): void {
    const { runner } = this;
    if (!runner) return;
    this.recordBrokerLifecycle('runner-stop-requested', reason, true);
    this.runner = null;
    this.runnerReady = null;
    this.runnerInputQueue = null;
    this.activeRunnerSessionId = 0;
    runner.removeAllListeners();
    runner.kill();
  }

  private stopIsolatedRunners(): void {
    for (const runner of this.isolatedRunners) {
      runner.kill();
    }
    this.isolatedRunners.clear();
  }

  private assertCacheGeneration(
    cache: TransformCacheEpoch['owner'],
    generation: CacheGeneration,
    entrypoint?: Entrypoint | null
  ): void {
    if (generation !== this.getCacheGeneration(cache)) {
      throw (
        generation.invalidationError ??
        new Error('[wyw-in-js] Evaluation cache generation was invalidated')
      );
    }
    entrypoint?.assertNotSuperseded();
  }

  private getCacheGeneration(
    cache: TransformCacheEpoch['owner']
  ): CacheGeneration {
    const current = this.cacheGenerations.get(cache);
    if (current) return current;
    const created = { invalidationError: null };
    this.cacheGenerations.set(cache, created);
    return created;
  }

  private clearEvaluationState(): void {
    this.lastInitKey = null;
    this.lastHappyDomEnabled = false;
    this.hasSemanticSession = false;
    this.semanticSessionKey = undefined;
    this.semanticSessionCacheToken = undefined;
    this.semanticSessionCacheGeneration = undefined;
    this.activeRunnerSessionId = 0;
    this.activeResolveRootId = null;
    this.activeEntrypoint = null;
    this.resolveCache.clear();
    this.resolveInFlight.clear();
    this.loadCache.clear();
    this.loadInFlight.clear();
    this.importsByModule.clear();
    this.onlyByModule.clear();
    this.runtimeDependenciesByModule.clear();
    this.emittedDependencies.clear();
    this.loadMirror.clear();
    this.pendingModuleResets.clear();
    this.sessionLinkGraph.clear();
    this.stableInitHashCache = null;
    this.runnerOutputBuffer = '';
  }

  private createRunnerProcess(reason: string): ChildProcessWithoutNullStreams {
    this.recordBrokerLifecycle('runner-spawn-attempt', reason);
    const runnerPath = buildRunnerPath();
    const nodeBinary =
      process.env.WYW_NODE_BINARY ||
      (process.execPath.includes('bun') ? 'node' : process.execPath);

    const runner = spawn(
      nodeBinary,
      ['--experimental-vm-modules', runnerPath],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.currentServices.options.root ?? process.cwd(),
        env: {
          ...process.env,
          WYW_EVAL_RUNNER: '1',
          NODE_NO_WARNINGS: '1',
        },
      }
    );

    runner.stdout.setEncoding('utf8');

    return runner;
  }

  private attachRunnerListeners(runner: ChildProcessWithoutNullStreams) {
    this.runnerOutputBuffer = '';
    runner.stdout.on('data', (chunk) => this.onData(runner, String(chunk)));
    runner.stderr.on('data', (chunk: Buffer) => {
      if (this.runner === runner) {
        this.handleRunnerStderr(chunk);
      }
    });
    runner.on('exit', (code, signal) => {
      if (this.runner !== runner) {
        return;
      }
      const reason = `Eval runner exited (${code ?? 'null'} / ${
        signal ?? 'null'
      })`;
      this.recordBrokerLifecycle('runner-exit-observed', reason, true);
      this.rejectAllPending(new Error(reason));
      this.runner = null;
      this.runnerInputQueue = null;
      this.runnerReady = null;
      this.lastInitKey = null;
      this.lastHappyDomEnabled = false;
      this.hasSemanticSession = false;
      this.semanticSessionKey = undefined;
      this.semanticSessionCacheToken = undefined;
      this.semanticSessionCacheGeneration = undefined;
      this.activeRunnerSessionId = 0;
      this.requestEpoch += 1;
      this.runnerOutputBuffer = '';
      this.loadMirror.clear();
      this.pendingModuleResets.clear();
      this.sessionLinkGraph.clear();
    });
  }

  private async ensureRunner() {
    for (;;) {
      if (this.disposed) {
        throw new Error('[wyw-in-js] Eval broker has been disposed');
      }

      const existingReady = this.runnerReady;
      if (existingReady) {
        const existingRunner = this.runner;
        const existingInputQueue = this.runnerInputQueue;
        await existingReady;
        if (this.disposed) {
          throw new Error('[wyw-in-js] Eval broker has been disposed');
        }
        if (
          existingReady === this.runnerReady &&
          existingRunner !== null &&
          existingRunner === this.runner &&
          existingInputQueue !== null &&
          existingInputQueue === this.runnerInputQueue
        ) {
          return;
        }
        continue;
      }

      const runner = this.createRunnerProcess('ensure');
      const inputQueue = createWriteQueue(runner.stdin, 'eval runner stdin');
      this.runner = runner;
      this.runnerInputQueue = inputQueue;
      this.attachRunnerListeners(runner);
      const runnerReady = Promise.resolve();
      this.runnerReady = runnerReady;
      await runnerReady;
      if (this.disposed) {
        throw new Error('[wyw-in-js] Eval broker has been disposed');
      }
      if (
        runnerReady !== this.runnerReady ||
        runner !== this.runner ||
        inputQueue !== this.runnerInputQueue
      ) {
        continue;
      }
      this.recordBrokerLifecycle('runner-activated', 'ensure');
      return;
    }
  }

  private async initIsolatedRunner(
    payload: EvalRunnerInitPayload,
    timeoutMs: number
  ): Promise<ChildProcessWithoutNullStreams> {
    const runner = this.createRunnerProcess('happy-dom-candidate');
    this.isolatedRunners.add(runner);
    const requestId = `candidate-init-${++this.nextId}`;
    let buffer = '';

    return new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        this.isolatedRunners.delete(runner);
        runner.stdout.off('data', onStdout);
        runner.stderr.off('data', onStderr);
        runner.off('exit', onExit);
      };

      const finalizeResolve = (value: ChildProcessWithoutNullStreams) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        cleanup();
        resolve(value);
      };

      const finalizeReject = (
        value: Error | { message: string; stack?: string }
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        cleanup();
        reject(value);
      };

      const onStderr = (chunk: Buffer) => {
        this.handleRunnerStderr(chunk);
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finalizeReject(
          new Error(
            `Eval runner exited during init (${code ?? 'null'} / ${
              signal ?? 'null'
            })`
          )
        );
      };

      const onStdout = (chunk: string | Buffer) => {
        const next = `${buffer}${chunk.toString()}`;
        const lines = next.split('\n');
        buffer = lines.pop() ?? '';

        lines.forEach((line) => {
          if (!line.trim()) return;

          let message: RunnerToMainMessage;
          try {
            message = JSON.parse(line);
          } catch {
            emitWarning(
              this.currentServices,
              `[wyw-eval-runner] Failed to parse message: ${line}`
            );
            return;
          }

          if (message.type === 'WARN') {
            this.handleWarn(message.payload);
            return;
          }

          if (message.type !== 'INIT_ACK' || message.id !== requestId) {
            return;
          }

          if (message.error) {
            runner.kill();
            finalizeReject(message.error);
            return;
          }

          finalizeResolve(runner);
        });
      };

      const timeout = setTimeout(() => {
        const error = new Error(`[wyw-in-js] Eval runner timed out for INIT`);
        (error as { code?: string }).code = 'WYW_EVAL_TIMEOUT';
        runner.kill();
        finalizeReject(error);
      }, timeoutMs);

      runner.stdout.on('data', onStdout);
      runner.stderr.on('data', onStderr);
      runner.on('exit', onExit);

      const message: MainToRunnerMessage = {
        type: 'INIT',
        id: requestId,
        payload,
      };
      writeToStream(
        runner.stdin,
        `${JSON.stringify(message)}\n`,
        'eval runner stdin'
      ).catch((error) => {
        runner.kill();
        finalizeReject(
          error instanceof Error ? error : new Error(String(error))
        );
      });
    });
  }

  private replaceRunner(nextRunner: ChildProcessWithoutNullStreams) {
    if (this.runner) {
      this.recordBrokerLifecycle(
        'runner-stop-requested',
        'happy-dom-replacement',
        true
      );
      this.runner.removeAllListeners();
      this.runner.kill();
    }

    this.requestEpoch += 1;
    this.runner = nextRunner;
    this.runnerInputQueue = createWriteQueue(
      nextRunner.stdin,
      'eval runner stdin'
    );
    this.attachRunnerListeners(nextRunner);
    this.runnerReady = Promise.resolve();
    // New process ⇒ runner's moduleCache/moduleHashes are empty, so our mirror
    // of "what we already shipped" is stale.
    this.loadMirror.clear();
    this.pendingModuleResets.clear();
    this.sessionLinkGraph.clear();
    this.recordBrokerLifecycle('runner-activated', 'happy-dom-replacement');
  }

  private getStableInitHash(
    services: Services,
    features: FeatureFlags<'happyDOM'>
  ): string {
    const pluginOptionsRef = services.options.pluginOptions;
    const evalOptionsRef = pluginOptionsRef.eval;
    const rootRef = services.options.root;
    if (
      this.stableInitHashCache !== null &&
      this.stableInitHashCache.pluginOptionsRef === pluginOptionsRef &&
      this.stableInitHashCache.evalOptionsRef === evalOptionsRef &&
      this.stableInitHashCache.featuresRef === features &&
      this.stableInitHashCache.rootRef === rootRef
    ) {
      return this.stableInitHashCache.hash;
    }
    // Build a sample payload (entrypoint name doesn't affect stable hash; we
    // pass any name and strip it inside getStableInitPayloadHash).
    // encodeGlobals is memoized so this is the only place it actually runs
    // per config change.
    const samplePayload = buildRunnerInitPayload(
      services,
      { name: '\0stable-init-sample\0' } as Entrypoint,
      features
    );
    samplePayload.reuseModules = true;
    const hash = getStableInitPayloadHash(samplePayload);
    this.stableInitHashCache = {
      pluginOptionsRef,
      evalOptionsRef,
      featuresRef: features,
      rootRef,
      hash,
    };
    return hash;
  }

  private async initRunner(
    entrypoint: Entrypoint,
    reuseModules = true,
    cacheGeneration = this.getCacheGeneration(
      getServicesCacheOwner(this.currentServices)
    )
  ) {
    const cacheOwner = getServicesCacheOwner(this.currentServices);
    this.assertCacheGeneration(cacheOwner, cacheGeneration, entrypoint);
    const features = this.getRunnerFeatures();
    const stableHash = this.getStableInitHash(this.currentServices, features);
    const debugEvalFiles = this.currentServices.eventEmitter.enabled;
    const debugEvalFilesKeyPart = debugEvalFiles ? '1' : '0';
    const initKey = `${stableHash}::${entrypoint.name}::debugEvalFiles:${debugEvalFilesKeyPart}`;
    const nextHappyDomEnabled = isFeatureEnabled(
      features,
      'happyDOM',
      entrypoint.name
    );
    const payload = buildRunnerInitPayload(
      this.currentServices,
      entrypoint,
      features
    );
    payload.reuseModules = reuseModules;
    if (debugEvalFiles) {
      payload.debugEvalFiles = true;
    }
    const timeoutMs = this.getInitTimeoutMs(entrypoint, features);

    if (
      this.runner &&
      this.lastInitKey !== null &&
      nextHappyDomEnabled &&
      !this.lastHappyDomEnabled &&
      !this.happyDomDisabled
    ) {
      try {
        const candidateSession = this.beginIsolatedRunnerSession(payload);
        const nextRunner = await this.initIsolatedRunner(
          candidateSession.payload,
          timeoutMs
        );
        try {
          this.assertCacheGeneration(cacheOwner, cacheGeneration, entrypoint);
          if (this.disposed) {
            throw new Error('[wyw-in-js] Eval broker has been disposed');
          }
        } catch (error) {
          nextRunner.kill();
          throw error;
        }
        this.replaceRunner(nextRunner);
        this.activeRunnerSessionId = candidateSession.sessionId;
        this.lastInitKey = initKey;
        this.lastHappyDomEnabled = true;
        return;
      } catch (error) {
        this.assertCacheGeneration(cacheOwner, cacheGeneration, entrypoint);
        if (isEvalTimeoutError(error)) {
          this.happyDomDisabled = true;
          this.warnHappyDomDisabledOnce(timeoutMs);
          const fallbackFeatures = this.getRunnerFeatures();
          const fallbackPayload = buildRunnerInitPayload(
            this.currentServices,
            entrypoint,
            fallbackFeatures
          );
          fallbackPayload.reuseModules = reuseModules;
          if (debugEvalFiles) {
            fallbackPayload.debugEvalFiles = true;
          }
          await this.initActiveRunner(fallbackPayload, INIT_TIMEOUT_MS);
          this.assertCacheGeneration(cacheOwner, cacheGeneration, entrypoint);
          this.lastInitKey = `${this.getStableInitHash(
            this.currentServices,
            fallbackFeatures
          )}::${entrypoint.name}::debugEvalFiles:${debugEvalFilesKeyPart}`;
          this.lastHappyDomEnabled = false;
          return;
        }

        throw error;
      }
    }

    try {
      await this.initActiveRunner(payload, timeoutMs);
      this.assertCacheGeneration(cacheOwner, cacheGeneration, entrypoint);
      this.lastInitKey = initKey;
      this.lastHappyDomEnabled = nextHappyDomEnabled;
    } catch (error) {
      if (
        isEvalTimeoutError(error) &&
        !this.happyDomDisabled &&
        isFeatureEnabled(features, 'happyDOM', entrypoint.name)
      ) {
        this.happyDomDisabled = true;
        this.warnHappyDomDisabledOnce(timeoutMs);
        const timedOutRunner = this.runner;
        if (timedOutRunner) {
          this.retireRunner(
            timedOutRunner,
            'happy-dom-timeout-recovery',
            error instanceof Error ? error : new Error(String(error))
          );
        }
        await this.ensureRunner();
        this.assertCacheGeneration(cacheOwner, cacheGeneration, entrypoint);
        const fallbackFeatures = this.getRunnerFeatures();
        const fallbackPayload = buildRunnerInitPayload(
          this.currentServices,
          entrypoint,
          fallbackFeatures
        );
        fallbackPayload.reuseModules = reuseModules;
        if (debugEvalFiles) {
          fallbackPayload.debugEvalFiles = true;
        }
        await this.initActiveRunner(fallbackPayload, INIT_TIMEOUT_MS);
        this.assertCacheGeneration(cacheOwner, cacheGeneration, entrypoint);
        this.lastInitKey = `${this.getStableInitHash(
          this.currentServices,
          fallbackFeatures
        )}::${entrypoint.name}::debugEvalFiles:${debugEvalFilesKeyPart}`;
        this.lastHappyDomEnabled = false;
        return;
      }
      throw error;
    }
  }

  private getRunnerFeatures(): FeatureFlags<'happyDOM'> {
    const base = this.currentServices.options.pluginOptions.features;
    if (!this.happyDomDisabled) return base;
    return { ...base, happyDOM: false };
  }

  private getInitTimeoutMs(
    entrypoint: Entrypoint,
    features: FeatureFlags<'happyDOM'>
  ) {
    if (
      this.happyDomDisabled ||
      !HAPPYDOM_INIT_TIMEOUT_MS ||
      HAPPYDOM_INIT_TIMEOUT_MS <= 0
    ) {
      return INIT_TIMEOUT_MS;
    }

    if (isFeatureEnabled(features, 'happyDOM', entrypoint.name)) {
      return Math.min(INIT_TIMEOUT_MS, HAPPYDOM_INIT_TIMEOUT_MS);
    }

    return INIT_TIMEOUT_MS;
  }

  private warnHappyDomDisabledOnce(timeoutMs: number) {
    if (this.happyDomDisableWarned) return;
    this.happyDomDisableWarned = true;
    emitWarning(
      this.currentServices,
      [
        `[wyw-in-js] DOM emulation initialization exceeded ${timeoutMs}ms and will be disabled for this run.`,
        `WyW will continue without DOM emulation (as if features.happyDOM:false).`,
        ``,
        `To silence this warning: set features: { happyDOM: false }.`,
        `To restore DOM emulation, ensure "happy-dom" can be imported in the build-time runtime.`,
        `You can tune the timeout with WYW_EVAL_HAPPYDOM_INIT_TIMEOUT_MS.`,
      ].join('\n')
    );
  }

  private onData(runner: ChildProcessWithoutNullStreams, chunk: string) {
    if (this.runner !== runner) {
      return;
    }
    const next = `${this.runnerOutputBuffer}${chunk}`;
    const lines = next.split('\n');
    this.runnerOutputBuffer = lines.pop() ?? '';
    lines.forEach((line) => {
      if (!line.trim()) return;
      let message: RunnerToMainMessage;
      try {
        message = JSON.parse(line);
      } catch (error) {
        emitWarning(
          this.currentServices,
          `[wyw-eval-runner] Failed to parse message: ${line}`
        );
        return;
      }

      this.handleMessage(message, runner);
    });
  }

  private handleMessage(
    message: RunnerToMainMessage,
    runner: ChildProcessWithoutNullStreams | null = this.runner
  ) {
    switch (message.type) {
      case 'INIT_ACK':
        if (message.error) {
          this.rejectPending(message.id, message.error);
          const failedRunner = runner ?? this.runner;
          if (failedRunner) {
            this.retireRunner(
              failedRunner,
              'init-error',
              new Error(message.error.message)
            );
          }
          return;
        }
        if (message.modulesReset) {
          // Runner just cleared its moduleCache during this INIT (full
          // context rebuild or reuseModules:false). Drop our shipped-code
          // mirror so handleLoad ships fresh code on the next LOAD.
          this.loadMirror.clear();
          this.pendingModuleResets.clear();
          this.sessionLinkGraph.clear();
          this.activeEvalTelemetry?.recordRunnerSignal({
            type: 'modules-reset',
          });
        }
        this.resolvePending(message.id, {});
        return;
      case 'EVAL_RESULT': {
        // Runner reports any ids it dropped from its caches during this
        // session (e.g. modules whose link errored after a transient missing
        // import). Mirror those evictions here — otherwise loadMirror
        // would keep claiming the runner has them and handleLoad would ship
        // empty `code` on the next session, leaving the runner stuck.
        const evictedIds = (
          message.payload as { evictedIds?: readonly string[] } | null
        )?.evictedIds;
        if (evictedIds && evictedIds.length > 0) {
          this.activeEvalTelemetry?.recordRunnerSignal({
            ids: evictedIds,
            type: 'poison-ids',
          });
          for (const evictedId of evictedIds) {
            this.loadMirror.delete(evictedId);
            this.pendingModuleResets.delete(evictedId);
          }
        }
        if (message.error) {
          this.rejectPending(message.id, message.error);
          return;
        }
        this.resolvePending(message.id, message.payload);
        return;
      }
      case 'RESOLVE': {
        const context = runner
          ? this.captureRequestContext(runner, message.sessionId) ?? undefined
          : undefined;
        if (runner && !context) return;
        this.handleResolve(message.id, message.payload, context).catch(
          (error) => {
            if (!this.isRequestContextActive(context)) return;
            void this.sendMessageForRequest(
              context,
              {
                type: 'RESOLVE_RESULT',
                id: message.id,
                payload: {
                  resolvedId: null,
                  error: toSerializedError(error),
                },
              },
              undefined,
              true
            ).catch((sendError) => {
              if (this.isRequestContextActive(context)) {
                this.handleSendMessageError(sendError);
              }
            });
          }
        );
        return;
      }
      case 'LOAD': {
        const context = runner
          ? this.captureRequestContext(runner, message.sessionId) ?? undefined
          : undefined;
        if (runner && !context) return;
        const telemetry = this.activeEvalTelemetry;
        this.handleLoad(message.id, message.payload, telemetry, context).catch(
          (error) => {
            if (!this.isRequestContextActive(context)) return;
            void this.sendLoadResultForRequest(
              context,
              message.id,
              {
                id: message.payload.id,
                error: toSerializedError(error),
              },
              telemetry
                ? { details: { mode: 'error' }, token: telemetry }
                : undefined,
              true
            ).catch((sendError) => {
              if (this.isRequestContextActive(context)) {
                this.handleSendMessageError(sendError);
              }
            });
          }
        );
        return;
      }
      case 'WARN':
        this.handleWarn(message.payload);
        break;
      default:
        break;
    }
  }

  private captureRequestContext(
    runner: ChildProcessWithoutNullStreams,
    sessionId: number | undefined
  ): EvalRequestContext | null {
    const inputQueue = this.runnerInputQueue;
    if (
      this.runner !== runner ||
      !inputQueue ||
      sessionId !== this.activeRunnerSessionId
    ) {
      return null;
    }

    return {
      cacheGeneration: this.getCacheGeneration(
        getServicesCacheOwner(this.currentServices)
      ),
      entrypoint: this.activeEntrypoint,
      epoch: this.requestEpoch,
      inputQueue,
      runner,
      sessionId,
      services: this.currentServices,
    };
  }

  private isRequestContextActive(
    context: EvalRequestContext | undefined
  ): boolean {
    if (!context) return true;
    // Liveness is scoped by the semantic session (runner, session id, request
    // epoch, services and cache generation), not by the entrypoint that was
    // active when the request arrived. A fire-and-forget dynamic import may
    // send RESOLVE right before EVAL_RESULT; when both land in one stdout
    // chunk the EVAL finishes (and clears activeEntrypoint) before the async
    // resolve completes. Dropping that RESOLVE_RESULT would leave the runner
    // awaiting forever and block the following LOAD. The next entrypoint bumps
    // requestEpoch, so stale continuations are still rejected there.
    return (
      context.epoch === this.requestEpoch &&
      context.cacheGeneration ===
        this.getCacheGeneration(getServicesCacheOwner(context.services)) &&
      context.runner === this.runner &&
      context.sessionId === this.activeRunnerSessionId &&
      context.services === this.currentServices &&
      context.inputQueue === this.runnerInputQueue
    );
  }

  private assertRequestContextActive(
    context: EvalRequestContext | undefined
  ): void {
    if (!this.isRequestContextActive(context)) {
      if (context?.cacheGeneration.invalidationError) {
        throw context.cacheGeneration.invalidationError;
      }
      const error = new Error(
        '[wyw-in-js] Ignoring a stale eval runner request'
      );
      error.name = 'StaleEvalRequestError';
      throw error;
    }
    context?.entrypoint?.assertNotSuperseded();
  }

  private handleRunnerStderr(chunk: Buffer) {
    const evalConsole =
      this.currentServices.options.pluginOptions.evalConsole ?? 'pipe';
    if (evalConsole === 'warning') {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          emitWarning(this.currentServices, trimmed);
        }
      }
    } else if (evalConsole === 'pipe') {
      process.stderr.write(chunk);
    }
  }

  private handleWarn(warning: EvalWarning) {
    if (warning.importer && warning.specifier) {
      this.trackRuntimeDependency(warning.importer, warning.specifier);
    }
    emitEvalWarning(this.currentServices, warning);
  }

  private async handleResolve(
    id: string,
    payload: ResolveRequestPayload,
    context?: EvalRequestContext
  ) {
    this.assertRequestContextActive(context);
    const result = await this.resolveImport(payload, context);
    this.assertRequestContextActive(context);

    if (debugEvalEnabled) {
      debugAction({
        type: 'resolve',
        evalSeq: this.evalSeq,
        specifier: payload.specifier,
        importer: payload.importerId,
        kind: payload.kind,
        resolvedId: result.resolvedId ?? null,
        external: result.external ?? false,
        ts: performance.now(),
      });
    }

    await this.sendMessageForRequest(context, {
      type: 'RESOLVE_RESULT',
      id,
      payload: {
        resolvedId: result.resolvedId,
        external: result.external,
      },
    });
  }

  private normalizeResolvedId(
    resolvedId: string,
    specifier: string,
    importerId: string | undefined,
    kind: ResolveRequestPayload['kind']
  ): string {
    const stripped = stripQueryAndHash(resolvedId);
    if (!stripped) return resolvedId;
    if (path.extname(stripped)) return resolvedId;

    const isFileSpecifier =
      specifier.startsWith('.') || path.isAbsolute(specifier);
    if (!isFileSpecifier && !path.isAbsolute(stripped)) {
      return resolvedId;
    }

    let candidate = stripped;
    if (!path.isAbsolute(candidate)) {
      if (!importerId) {
        return resolvedId;
      }
      const importerFile = stripQueryAndHash(importerId);
      candidate = path.resolve(path.dirname(importerFile), candidate);
    }

    const suffix = resolvedId.slice(stripped.length);
    for (const ext of this.currentServices.options.pluginOptions.extensions) {
      const fileCandidate = `${candidate}${ext}`;
      if (fs.existsSync(fileCandidate)) {
        return `${fileCandidate}${suffix}`;
      }

      const indexCandidate = path.join(candidate, `index${ext}`);
      if (fs.existsSync(indexCandidate)) {
        return `${indexCandidate}${suffix}`;
      }
    }

    if (importerId) {
      try {
        const importerFile = stripQueryAndHash(importerId);
        const { conditionNames, extensions, oxcOptions } =
          this.currentServices.options.pluginOptions;
        const resolved = resolveWithNativeResolver({
          conditionNames,
          extensions,
          importer: importerFile,
          kind,
          oxcOptions,
          specifier: resolvedId,
        });
        if (resolved && resolved !== stripped) {
          return resolved;
        }
      } catch (error) {
        if (process.env.WYW_DEBUG_EVAL_RESOLVE) {
          // eslint-disable-next-line no-console
          console.warn('[wyw-eval:resolve:native-normalize-miss]', {
            specifier,
            importerId,
            kind,
            error,
          });
        }
      }
    }

    return resolvedId;
  }

  private async resolveImport(
    { specifier, importerId, kind }: ResolveRequestPayload,
    context?: EvalRequestContext
  ): Promise<ResolveResult> {
    this.assertRequestContextActive(context);
    const services = context?.services ?? this.currentServices;
    return services.eventEmitter.action(
      'eval:resolveImport',
      `${importerId}\0${kind}\0${specifier}`,
      importerId,
      () => this.resolveImportImpl({ specifier, importerId, kind }, context)
    );
  }

  private getResolveStack(importerId: string): string[] {
    if (!this.activeResolveRootId || this.activeResolveRootId === importerId) {
      return [importerId];
    }

    return [importerId, this.activeResolveRootId];
  }

  private async resolveImportImpl(
    { specifier, importerId, kind }: ResolveRequestPayload,
    context?: EvalRequestContext
  ): Promise<ResolveResult> {
    this.assertRequestContextActive(context);
    if (process.env.WYW_DEBUG_EVAL_RESOLVE) {
      // eslint-disable-next-line no-console
      console.warn('[wyw-eval:resolve]', { specifier, importerId, kind });
    }
    const key = `${kind}:${importerId}:${specifier}`;
    const services = context?.services ?? this.currentServices;
    const evalOptions = getEvalOptions(services);
    const stack = this.getResolveStack(importerId);
    const importsOnly = this.importsByModule.get(importerId)?.get(specifier);
    const only = this.getImportOnly(importerId, specifier);
    if (process.env.WYW_DEBUG_EVAL_RESOLVE && !importsOnly) {
      // eslint-disable-next-line no-console
      console.warn('[wyw-eval:resolve:only-miss]', {
        specifier,
        importerId,
        kind,
      });
    }
    const strippedSpecifier = stripQueryAndHash(specifier);
    if (path.isAbsolute(strippedSpecifier)) {
      const normalized = this.normalizeResolvedId(
        specifier,
        specifier,
        importerId,
        kind
      );
      const overridden = this.applyImportOverrides(
        {
          source: specifier,
          resolved: normalized,
          only,
          external: false,
        },
        importerId,
        stack
      );
      this.resolveCache.set(key, { resolvedId: normalized, external: false });
      return this.finalizeResolvedImport(importerId, specifier, overridden);
    }

    const cached = this.resolveCache.get(key);
    if (cached) {
      if (!cached.resolvedId) {
        return this.finalizeResolvedImport(importerId, specifier, {
          resolvedId: null,
          only: ['*'],
        });
      }

      const normalized = this.normalizeResolvedId(
        cached.resolvedId,
        specifier,
        importerId,
        kind
      );
      const overridden = this.applyImportOverrides(
        {
          source: specifier,
          resolved: normalized,
          only,
          external: cached.external,
        },
        importerId,
        stack
      );
      if (cached.usedNativeFallback) {
        this.maybeWarnNativeFallback({
          importerId,
          specifier,
          resolvedId: normalized,
          kind,
        });
      }
      return this.finalizeResolvedImport(importerId, specifier, overridden);
    }

    const inFlight = this.resolveInFlight.get(key);
    if (inFlight) {
      const cachedResult = await inFlight;
      this.assertRequestContextActive(context);
      if (!cachedResult.resolvedId) {
        return this.finalizeResolvedImport(importerId, specifier, {
          resolvedId: null,
          only: ['*'],
        });
      }
      const normalized = this.normalizeResolvedId(
        cachedResult.resolvedId,
        specifier,
        importerId,
        kind
      );
      const overridden = this.applyImportOverrides(
        {
          source: specifier,
          resolved: normalized,
          only,
          external: cachedResult.external,
        },
        importerId,
        stack
      );
      if (cachedResult.usedNativeFallback) {
        this.maybeWarnNativeFallback({
          importerId,
          specifier,
          resolvedId: normalized,
          kind,
        });
      }
      return this.finalizeResolvedImport(importerId, specifier, overridden);
    }

    const task: Promise<ResolveCacheEntry> = (async () => {
      if (evalOptions.customResolver) {
        const customResolved = await evalOptions.customResolver(
          specifier,
          importerId,
          kind
        );
        this.assertRequestContextActive(context);
        if (customResolved) {
          const normalized = this.normalizeResolvedId(
            customResolved.id,
            specifier,
            importerId,
            kind
          );
          if (process.env.WYW_DEBUG_EVAL_RESOLVE) {
            // eslint-disable-next-line no-console
            console.warn('[wyw-eval:resolve:custom]', {
              specifier,
              importerId,
              resolved: customResolved.id,
              normalized,
              external: customResolved.external,
            });
          }
          return {
            resolvedId: normalized,
            external: customResolved.external,
          };
        }

        if (evalOptions.resolver === 'custom') {
          return { resolvedId: null };
        }
      }

      if (evalOptions.resolver === 'hybrid') {
        try {
          const nativeResolved = this.resolveWithNativeFallback(
            specifier,
            importerId,
            kind
          );
          if (process.env.WYW_DEBUG_EVAL_RESOLVE) {
            // eslint-disable-next-line no-console
            console.warn('[wyw-eval:resolve:native]', {
              specifier,
              importerId,
              resolved: nativeResolved.resolvedId,
            });
          }
          return nativeResolved;
        } catch (error) {
          if (process.env.WYW_DEBUG_EVAL_RESOLVE) {
            // eslint-disable-next-line no-console
            console.warn('[wyw-eval:resolve:native-miss]', {
              specifier,
              importerId,
              kind,
              error,
            });
          }
          // Hybrid mode lets the bundler resolver handle aliases, virtual IDs,
          // and other specifiers that the native resolver cannot resolve.
        }
      }

      if (evalOptions.resolver === 'native') {
        const nativeResolved = this.resolveWithNativeFallback(
          specifier,
          importerId,
          kind
        );
        if (process.env.WYW_DEBUG_EVAL_RESOLVE) {
          // eslint-disable-next-line no-console
          console.warn('[wyw-eval:resolve:native]', {
            specifier,
            importerId,
            resolved: nativeResolved.resolvedId,
          });
        }
        return nativeResolved;
      }

      if (
        evalOptions.resolver === 'bundler' ||
        evalOptions.resolver === 'hybrid'
      ) {
        let resolved: string | null = null;
        try {
          const asyncResolve =
            services.asyncResolve ?? this.fallbackAsyncResolve;
          resolved = await asyncResolve(specifier, importerId, stack);
          this.assertRequestContextActive(context);
        } catch {
          this.assertRequestContextActive(context);
          resolved = null;
        }
        if (resolved) {
          const normalized = this.normalizeResolvedId(
            resolved,
            specifier,
            importerId,
            kind
          );
          if (process.env.WYW_DEBUG_EVAL_RESOLVE) {
            // eslint-disable-next-line no-console
            console.warn('[wyw-eval:resolve:async]', {
              specifier,
              importerId,
              resolved,
              normalized,
            });
          }
          return {
            resolvedId: normalized,
          };
        }
      }

      if (evalOptions.resolver === 'bundler' && evalOptions.require !== 'off') {
        const nativeResolved = this.resolveWithNativeFallback(
          specifier,
          importerId,
          kind
        );
        if (process.env.WYW_DEBUG_EVAL_RESOLVE) {
          // eslint-disable-next-line no-console
          console.warn('[wyw-eval:resolve:native-fallback]', {
            specifier,
            importerId,
            resolved: nativeResolved.resolvedId,
          });
        }
        return {
          ...nativeResolved,
          usedNativeFallback: true,
        };
      }

      if (process.env.WYW_DEBUG_EVAL_RESOLVE) {
        // eslint-disable-next-line no-console
        console.warn('[wyw-eval:resolve:none]', {
          specifier,
          importerId,
        });
      }
      return { resolvedId: null };
    })();

    this.resolveInFlight.set(key, task);

    try {
      const result = await task;
      this.assertRequestContextActive(context);
      this.resolveCache.set(key, result);

      if (!result.resolvedId) {
        return this.finalizeResolvedImport(importerId, specifier, {
          resolvedId: null,
          only: ['*'],
        });
      }

      const overridden = this.applyImportOverrides(
        {
          source: specifier,
          resolved: result.resolvedId,
          only,
          external: result.external,
        },
        importerId,
        stack
      );

      if (result.usedNativeFallback && result.resolvedId) {
        this.maybeWarnNativeFallback({
          importerId,
          specifier,
          resolvedId: result.resolvedId,
          kind,
        });
      }

      return this.finalizeResolvedImport(importerId, specifier, overridden);
    } finally {
      if (this.resolveInFlight.get(key) === task) {
        this.resolveInFlight.delete(key);
      }
    }
  }

  private finalizeResolvedImport(
    importerId: string,
    specifier: string,
    result: ResolveResult
  ): ResolveResult {
    this.trackImporterDependency(
      importerId,
      specifier,
      result.resolvedId,
      result.only
    );
    this.emitDependency(importerId, specifier, result.resolvedId, result.only);
    return result;
  }

  private emitDependency(
    importerId: string,
    specifier: string,
    resolvedId: string | null,
    only: string[]
  ) {
    if (resolvedId === null) {
      return;
    }

    const key = `${importerId}\0${specifier}\0${resolvedId}\0${only.join(',')}`;
    if (this.emittedDependencies.has(key)) {
      return;
    }
    this.emittedDependencies.add(key);

    this.currentServices.eventEmitter.single({
      type: 'dependency',
      file: importerId,
      only,
      imports: [{ from: resolvedId, what: only }],
      fileIdx: getFileIdx(importerId),
    });
  }

  private trackRuntimeDependency(importerId: string, specifier: string) {
    if (isBuiltinSpecifier(specifier) || isVirtualSpecifier(specifier)) {
      return;
    }

    const dependencies =
      this.runtimeDependenciesByModule.get(importerId) ?? new Set<string>();
    dependencies.add(specifier);
    this.runtimeDependenciesByModule.set(importerId, dependencies);
  }

  private trackImporterDependency(
    importerId: string,
    source: string,
    resolved: string | null,
    only: string[]
  ) {
    const importerEntrypoint = this.currentServices.cache.get(
      'entrypoints',
      importerId
    ) as
      | {
          dependencies?: Map<
            string,
            {
              source: string;
              resolved: string | null;
              only: string[];
            }
          >;
        }
      | undefined;

    const dependencies = importerEntrypoint?.dependencies;
    if (!dependencies) return;

    if (resolved === null) {
      dependencies.delete(source);
      return;
    }

    const cached = dependencies.get(source);
    dependencies.set(source, {
      source,
      resolved,
      only: cached ? mergeOnly(cached.only, only) : [...only],
    });
  }

  private collectEntrypointDependencies(entrypointId: string): string[] {
    const collected = new Set(
      this.runtimeDependenciesByModule.get(entrypointId) ?? []
    );
    const cachedEntrypoint = this.currentServices.cache.get(
      'entrypoints',
      entrypointId
    ) as
      | {
          dependencies?: Map<
            string,
            {
              source: string;
              resolved: string | null;
              only: string[];
            }
          >;
        }
      | undefined;
    cachedEntrypoint?.dependencies?.forEach((dependency, specifier) => {
      if (
        dependency.resolved !== null &&
        !isBuiltinSpecifier(specifier) &&
        !isVirtualSpecifier(specifier)
      ) {
        collected.add(specifier);
      }
    });
    return Array.from(collected);
  }

  private applyImportOverrides(
    resolved: {
      source: string;
      resolved: string;
      only: string[];
      external?: boolean;
    },
    importerId: string,
    stack: string[]
  ): ResolveResult {
    const { root } = this.currentServices.options;
    const keyInfo = toImportKey({
      source: resolved.source,
      resolved: resolved.resolved,
      root,
    });
    const override = getImportOverride(
      this.currentServices.options.pluginOptions.importOverrides,
      keyInfo.key
    );

    let nextResolved = resolved.resolved;
    let nextExternal = resolved.external;
    if (override?.mock) {
      nextResolved = resolveMockSpecifier({
        mock: override.mock,
        importer: importerId,
        root,
        stack,
      });
      nextExternal = false;
    }

    let nextOnly = applyImportOverrideToOnly(resolved.only, override);
    const cached = this.currentServices.cache.get(
      'entrypoints',
      nextResolved
    ) as CachedEntrypointLike | undefined;
    if (
      nextOnly.includes('__wywPreval') &&
      cached?.evaluated &&
      !cached.ignored &&
      !hasCachedWywPrevalExport(this.currentServices, nextResolved, cached)
    ) {
      nextOnly = nextOnly.filter((item) => item !== '__wywPreval');
    }
    const storedOnly = this.onlyByModule.get(nextResolved);
    this.onlyByModule.set(
      nextResolved,
      storedOnly ? mergeOnly(storedOnly, nextOnly) : nextOnly
    );
    return {
      resolvedId: nextResolved,
      external: nextExternal,
      only: nextOnly,
    };
  }

  private resolveWithNativeFallback(
    specifier: string,
    importerId: string,
    kind: ResolveRequestPayload['kind']
  ): ResolveCacheEntry {
    const { conditionNames, extensions, oxcOptions } =
      this.currentServices.options.pluginOptions;

    try {
      const resolved = resolveWithNativeResolver({
        conditionNames,
        extensions,
        importer: importerId,
        kind,
        oxcOptions,
        specifier,
      });
      return {
        resolvedId: this.normalizeResolvedId(
          resolved,
          specifier,
          importerId,
          kind
        ),
      };
    } catch (error) {
      throw new Error(
        [
          `[wyw-in-js] Native resolver failed during eval.`,
          ``,
          `importer: ${importerId}`,
          `source:   ${specifier}`,
          ``,
          `error: ${error instanceof Error ? error.message : String(error)}`,
        ].join('\n')
      );
    }
  }

  private maybeWarnNativeFallback({
    importerId,
    specifier,
    resolvedId,
    kind,
  }: {
    importerId: string;
    specifier: string;
    resolvedId: string;
    kind: ResolveRequestPayload['kind'];
  }) {
    const evalOptions = getEvalOptions(this.currentServices);
    const { root } = this.currentServices.options;
    const keyInfo = toImportKey({
      source: specifier,
      resolved: resolvedId,
      root,
    });

    const override = getImportOverride(
      this.currentServices.options.pluginOptions.importOverrides,
      keyInfo.key
    );

    if (override && override.unknown === undefined) {
      return;
    }

    const basePolicy: 'warn' | 'error' =
      evalOptions.require === 'warn-and-run' ? 'warn' : 'error';
    let policy = override?.unknown ?? basePolicy;
    if (evalOptions.require === 'off' && policy !== 'error') {
      policy = 'error';
    }

    if (policy === 'error') {
      throw new Error(
        [
          `[wyw-in-js] Unknown import reached during eval (native resolver fallback)`,
          ``,
          `importer: ${importerId}`,
          `source:   ${specifier}`,
          `resolved: ${resolvedId}`,
          ``,
          `config key: ${keyInfo.key}`,
          `docs: https://wyw-in-js.dev/troubleshooting`,
        ]
          .filter(Boolean)
          .join('\n')
      );
    }

    const warnedUnknownImports = getWarnedUnknownImports(this.currentServices);
    if (policy === 'warn' && !warnedUnknownImports.has(keyInfo.key)) {
      warnedUnknownImports.add(keyInfo.key);
      const warningMessage = [
        `[wyw-in-js] Unknown import reached during eval (native resolver fallback)`,
        ``,
        `importer: ${importerId}`,
        `source:   ${specifier}`,
        `resolved: ${resolvedId}`,
        ``,
        `config key: ${keyInfo.key}`,
        `hint: add { importOverrides: { ${JSON.stringify(
          keyInfo.key
        )}: { unknown: 'allow' } } } to silence warnings, or use { mock } / { noShake: true } overrides.`,
        `docs: https://wyw-in-js.dev/troubleshooting`,
      ]
        .filter(Boolean)
        .join('\n');

      emitEvalWarning(this.currentServices, {
        code: kind === 'require' ? 'require-fallback' : 'resolve-fallback',
        message: warningMessage,
        importer: importerId,
        specifier,
        resolved: resolvedId ?? null,
        callstack: [importerId],
        hint: `Use importOverrides or eval.require settings to avoid fallback.`,
      });
    }
  }

  private async handleLoad(
    id: string,
    payload: LoadRequestPayload,
    telemetry = this.activeEvalTelemetry,
    context?: EvalRequestContext
  ) {
    this.assertRequestContextActive(context);
    telemetry?.recordLoadRequest();
    const prepared = await this.loadModule(payload, telemetry, context);
    this.assertRequestContextActive(context);
    const resetModule =
      prepared.resetModule === true || this.pendingModuleResets.has(payload.id);

    // Decide once whether the runner already has this exact prepared variant.
    // The runner caches by id and short-circuits when the LoadResult hash
    // matches `moduleHashes.get(id)` (runner.js:1834). So when our prior
    // shipment under the same hash already covered the requested `only`,
    // re-shipping the code is pure waste — both over IPC and to the dump dir.
    const previouslySent = prepared.hash
      ? this.loadMirror.get(payload.id)
      : undefined;
    if (resetModule) this.loadMirror.delete(payload.id);
    // Legacy broker dedup and telemetry use separate shape classifiers because
    // the runner stores `only=[]` as a variant, not as wildcard coverage.
    const sameStorageShape = Boolean(
      previouslySent &&
        hasSameBrokerStorageShape(previouslySent.only, prepared.only)
    );
    const sameRunnerStorageShape = Boolean(
      previouslySent &&
        hasSameRunnerStorageShape(previouslySent.only, prepared.only)
    );
    const runnerHasCachedVariant = Boolean(
      !resetModule &&
        prepared.hash &&
        previouslySent &&
        previouslySent.hash === prepared.hash &&
        sameStorageShape &&
        isSuperSet(previouslySent.only, prepared.only)
    );
    // Empty prepared code is a legitimate payload. Ship it unless the runner
    // has an equivalent variant; only an omitted field means cache reuse.
    const shouldShipCode = Boolean(
      !prepared.exports && !runnerHasCachedVariant
    );
    const shippedCodeBytes =
      telemetry && shouldShipCode
        ? Buffer.byteLength(prepared.code)
        : undefined;
    const transmissionTelemetry = telemetry
      ? createLoadTransmissionTelemetry({
          code: prepared.code,
          codeBytes: shippedCodeBytes,
          hash: prepared.hash,
          hasSerializedExports: Boolean(prepared.exports),
          previouslySent,
          resetModule,
          sameStorageShape: sameRunnerStorageShape,
          shouldShipCode,
          token: telemetry,
        })
      : undefined;

    if (debugEvalEnabled) {
      if (shouldShipCode) {
        dumpEvalCode(
          payload.id,
          prepared.code!,
          prepared.only,
          prepared.hash ? `cache:${prepared.hash}` : 'fresh',
          this.evalSeq
        );
      }

      debugAction({
        type: 'load',
        evalSeq: this.evalSeq,
        id: payload.id,
        importer: payload.importerId ?? null,
        only: prepared.only,
        hasCode: Boolean(prepared.code),
        hasExports: Boolean(prepared.exports),
        hash: prepared.hash ?? null,
        shipped: shouldShipCode,
        ts: performance.now(),
      });
    }

    this.recordEvalFileDebugLine(payload, prepared, shouldShipCode);

    await this.sendLoadResultForRequest(
      context,
      id,
      {
        id: payload.id,
        // Omit `code` entirely — rather than sending '' — when we're not
        // shipping. '' is a legitimate LoadResult for a runtime-empty module;
        // only an *absent* field means "reuse what you already have".
        ...(shouldShipCode ? { code: prepared.code } : {}),
        map: null,
        hash: prepared.hash,
        only: prepared.only,
        exports: prepared.exports,
        ...(resetModule ? { resetModule: true } : {}),
      },
      transmissionTelemetry
    );
    this.assertRequestContextActive(context);
    if (resetModule) {
      this.pendingModuleResets.delete(payload.id);
    }

    if (shouldShipCode && prepared.hash) {
      const merged =
        !resetModule && previouslySent?.hash === prepared.hash
          ? mergeOnly(previouslySent.only, prepared.only)
          : [...prepared.only];
      this.loadMirror.set(payload.id, {
        ...(shippedCodeBytes === undefined
          ? {}
          : { codeBytes: shippedCodeBytes }),
        hash: prepared.hash,
        only: merged,
      });
      if (
        telemetry &&
        previouslySent &&
        previouslySent.hash !== prepared.hash
      ) {
        telemetry.recordPressureProxy({
          store: getRunnerStorage(prepared.only),
          type: 'shipment-hash-change',
        });
      }
    }
    // Session link graph tracks every module that's been admitted into
    // the current runner's VM. mergeKnownDependencyOnly uses this to
    // narrow its consumer-set to entrypoints actually linking against
    // the same module instance.
    this.sessionLinkGraph.add(payload.id);
    if (payload.importerId) {
      this.sessionLinkGraph.add(payload.importerId);
    }
  }

  private async loadModule(
    { id, importerId, request }: LoadRequestPayload,
    telemetry = this.activeEvalTelemetry,
    context?: EvalRequestContext
  ): Promise<PreparedCacheEntry & { resetModule?: true }> {
    this.assertRequestContextActive(context);
    const services = context?.services ?? this.currentServices;
    const actionEntrypoint = importerId ?? id;
    return services.eventEmitter.action(
      'eval:loadModule',
      `${actionEntrypoint}\0${id}`,
      actionEntrypoint,
      () => {
        this.assertRequestContextActive(context);
        const predecessor = this.loadInFlight.get(id);
        if (!predecessor) {
          // Cache and serialized-export hits have no asynchronous critical
          // section. A real preparation registers itself below before this
          // call yields, so only successors need the outer strict chain.
          return this.loadModuleImpl(
            { id, importerId, request },
            telemetry,
            context
          );
        }

        telemetry?.recordLoadCacheOutcome('inflight-wait');
        const task = (async () => {
          try {
            await predecessor;
          } catch {
            // The request that owns the predecessor receives its own error.
            // A queued request must retry, especially when it follows an
            // invalidation that may have fixed the failed source.
          }
          this.assertRequestContextActive(context);
          return this.loadModuleImpl(
            { id, importerId, request },
            telemetry,
            context,
            true,
            false
          );
        })();
        this.loadInFlight.set(id, task);
        return task.finally(() => {
          if (this.loadInFlight.get(id) === task) {
            this.loadInFlight.delete(id);
          }
        });
      }
    );
  }

  private async loadModuleImpl(
    { id, importerId, request }: LoadRequestPayload,
    telemetry = this.activeEvalTelemetry,
    context?: EvalRequestContext,
    waitedForInflight = false,
    registerPreparation = true
  ): Promise<PreparedCacheEntry & { resetModule?: true }> {
    this.assertRequestContextActive(context);
    const services = context?.services ?? this.currentServices;
    const evaluatedEntrypoint = context?.entrypoint ?? this.activeEntrypoint;
    let cached = this.loadCache.get(id);
    const invalidated = services.cache.consumeInvalidation(id);
    if (invalidated) {
      this.pendingModuleResets.add(id);
      if (telemetry && cached) {
        telemetry.recordPreparedCacheEviction({
          id,
          knownCodeBytes: Buffer.byteLength(cached.code),
          reason: 'invalidation',
        });
      }
      this.loadCache.delete(id);
      cached = undefined;
    }

    const loadRequestOnly = this.getLoadRequestOnly(id, importerId, request);
    if (loadRequestOnly) {
      const storedOnly = this.onlyByModule.get(id);
      this.onlyByModule.set(
        id,
        storedOnly ? mergeOnly(storedOnly, loadRequestOnly) : loadRequestOnly
      );
      this.trackImporterDependency(importerId!, request!, id, loadRequestOnly);
      this.emitDependency(importerId!, request!, id, loadRequestOnly);
    }

    let requiredOnly = this.mergeKnownDependencyOnly(id);

    // Merge the specific exports the importer needs from this module.
    // The broker's onlyByModule is populated by RESOLVE handlers, but
    // concurrent message processing can cause a LOAD to arrive before
    // all pending RESOLVEs are complete. Directly consulting the
    // importer's imports map ensures we never serve a module with
    // fewer exports than the requesting importer actually imports.
    if (importerId && request) {
      const importerImports = this.importsByModule.get(importerId);
      if (importerImports) {
        const specifierOnly = importerImports.get(request);
        if (specifierOnly && specifierOnly.length > 0) {
          requiredOnly = requiredOnly.includes('*')
            ? requiredOnly
            : mergeOnly(requiredOnly, specifierOnly);
        }
      }
    }
    const cachedEntrypoint = services.cache.get('entrypoints', id) as
      | {
          evaluated?: boolean;
          evaluatedOnly?: string[];
          exports?: Record<string | symbol, unknown>;
          ignored?: boolean;
          initialCode?: string;
          originalCode?: string;
        }
      | undefined;
    if (
      !this.pendingModuleResets.has(id) &&
      cachedEntrypoint &&
      cachedEntrypoint.evaluated &&
      !cachedEntrypoint.ignored &&
      cachedEntrypoint.exports &&
      !requiredOnly.includes('*') &&
      !requiredOnly.some(isEvalOnlyKey) &&
      isSuperSet(cachedEntrypoint.evaluatedOnly ?? [], requiredOnly)
    ) {
      const serializeOnly = getSerializableStaticImportKeys(
        services,
        id,
        cachedEntrypoint,
        requiredOnly,
        request,
        importerId
      );
      if (serializeOnly) {
        const serialized = serializeCachedExports(
          cachedEntrypoint.exports,
          serializeOnly
        );
        if (serialized) {
          const hash = hashContent(`exports:${JSON.stringify(serialized)}`);
          telemetry?.recordLoadCacheOutcome('serialized-exports');
          return {
            code: '',
            imports: null,
            only: serializeOnly,
            hash,
            exports: serialized,
          };
        }
      }
    }
    // prepareModuleOnDemand is deterministic given (id, requiredOnly): the
    // shaker output depends only on source bytes (invalidated via
    // consumeInvalidation when the file changes) and the requested `only`.
    // Side effects from __wywPreval happen at runtime in the runner, not at
    // preparation time — so caching prepared bytes is safe even for self-loads
    // with __wywPreval. This lets incremental rebuilds reuse the prepared
    // entrypoint when its source is unchanged; my IPC dedup mirror then
    // suppresses re-shipping to the runner.
    if (cached && isPreparedCacheHit(cached, requiredOnly)) {
      telemetry?.recordLoadCacheOutcome(
        waitedForInflight ? 'inflight-hit' : 'hit'
      );
      this.ensureImportsMapping(id, cached.imports);
      return cached;
    }

    if (waitedForInflight) {
      telemetry?.recordLoadCacheOutcome('inflight-wait-miss');
    }

    telemetry?.recordLoadCacheOutcome(
      invalidated ? 'invalidation-miss' : cached ? 'promotion' : 'miss'
    );

    const slowImportWarningsEnabled = isWarningEnabled(
      process.env.WYW_WARN_SLOW_IMPORTS
    );
    const slowImportThresholdMs = slowImportWarningsEnabled
      ? getSlowImportThresholdMs()
      : 0;
    const warnedSlowImports = slowImportWarningsEnabled
      ? getWarnedSlowImports(services)
      : null;
    const shouldWarnSlowImport = Boolean(
      slowImportWarningsEnabled &&
        warnedSlowImports &&
        slowImportThresholdMs > 0 &&
        request &&
        importerId &&
        importerId !== id
    );
    const slowImportStartedAt = shouldWarnSlowImport ? performance.now() : 0;

    const task = (async () => {
      const evalOptions = getEvalOptions(services);

      if (evalOptions.customLoader) {
        const loaded = await evalOptions.customLoader(id);
        this.assertRequestContextActive(context);
        if (loaded) {
          const code = formatLoaderResult(loaded.code, loaded.loader);
          return {
            code,
            imports: null,
            only: requiredOnly,
            hash: hashContent(code),
          };
        }
      }

      if (request && importerId) {
        const loaded = loadByImportLoaders(services, request, id, importerId);
        if (loaded.handled) {
          const code = `export default ${JSON.stringify(loaded.value)};`;
          return {
            code,
            imports: null,
            only: requiredOnly,
            hash: hashContent(code),
          };
        }
      }

      const strippedId = stripQueryAndHash(id);
      const extension = path.extname(strippedId);
      if (extension === '.json') {
        const jsonSource = fs.readFileSync(strippedId, 'utf-8');
        const code = `export default ${JSON.stringify(
          JSON.parse(jsonSource)
        )};`;
        return {
          code,
          imports: null,
          only: requiredOnly,
          hash: hashContent(code),
        };
      }

      if (
        extension &&
        !services.options.pluginOptions.extensions.includes(extension)
      ) {
        const code = `export default ${JSON.stringify(id)};`;
        return {
          code,
          imports: null,
          only: requiredOnly,
          hash: hashContent(code),
        };
      }

      const directBarrelProxy = buildDirectBarrelProxy(
        services,
        id,
        requiredOnly
      );
      if (directBarrelProxy) {
        return {
          ...directBarrelProxy,
          hash: hashContent(directBarrelProxy.code),
        };
      }

      // Widening the evaluated entrypoint from __wywPreval to `*` would
      // supersede the caller while its EVAL is in flight. Dependencies can
      // still take this static fast path, but the active entrypoint must retain
      // the generation whose result is about to be published and checked.
      if (id !== evaluatedEntrypoint?.name && !requiredOnly.includes('*')) {
        const loadedAndParsed = services.loadAndParseFn(
          services,
          id,
          undefined,
          services.log
        );

        if (
          loadedAndParsed.evaluator !== 'ignored' &&
          loadedAndParsed.evaluator === oxcShaker &&
          isStaticallyEvaluatableModule(loadedAndParsed.code, id)
        ) {
          requiredOnly = ['*'];
          this.onlyByModule.set(id, requiredOnly);
        }
      }

      const prepareOnly =
        requiredOnly.includes('__wywPreval') || !cached
          ? requiredOnly
          : mergeOnly(cached.only, requiredOnly);
      const preparationTelemetry = telemetry?.beginPreparation(id, prepareOnly);
      let prepared: PreparedModule;
      try {
        prepared = preparationTelemetry
          ? preparationTelemetry.measureStage('prepare', () =>
              prepareModuleOnDemand(
                services,
                id,
                prepareOnly,
                preparationTelemetry,
                evaluatedEntrypoint?.graphTraversalToken,
                evaluatedEntrypoint ?? undefined
              )
            )
          : prepareModuleOnDemand(
              services,
              id,
              prepareOnly,
              undefined,
              evaluatedEntrypoint?.graphTraversalToken,
              evaluatedEntrypoint ?? undefined
            );
      } catch (error) {
        preparationTelemetry?.fail();
        throw error;
      }
      const hash = hashContent(prepared.code);
      preparationTelemetry?.finish({
        code: prepared.code,
        imports: prepared.imports,
        only: prepared.only,
        outputRevision: hash,
      });

      this.ensureImportsMapping(id, prepared.imports);

      if (shouldWarnSlowImport && request && importerId) {
        const durationMs = performance.now() - slowImportStartedAt;
        if (durationMs >= slowImportThresholdMs) {
          const { root } = services.options;
          const resolvedKey = stripQueryAndHash(id);
          const { key: importKey } = toImportKey({
            source: request,
            resolved: resolvedKey,
            root,
          });
          const dedupeKey = `${importerId}::${importKey}`;
          if (warnedSlowImports && !warnedSlowImports.has(dedupeKey)) {
            warnedSlowImports.add(dedupeKey);
            const warning = [
              `[wyw-in-js] Slow import during prepare stage`,
              ``,
              `file: ${importerId}`,
              `import: ${request}`,
              `resolved: ${resolvedKey}`,
              `duration: ${durationMs.toFixed(1)}ms`,
              ``,
              `tip: if this import is runtime-only or heavy, mock it during evaluation via importOverrides:`,
              `  importOverrides: {`,
              `    '${importKey}': { mock: './path/to/mock' },`,
              `  }`,
              ``,
              `note: importOverrides affects only build-time evaluation (it does not change your bundler runtime behavior)`,
              ``,
              `note: configure threshold with WYW_WARN_SLOW_IMPORTS_MS (current: ${slowImportThresholdMs}ms)`,
            ].join('\n');
            emitWarning(services, warning);
          }
        }
      }

      return { ...prepared, hash };
    })();

    if (registerPreparation) {
      this.loadInFlight.set(id, task);
    }

    try {
      const result = await task;
      this.assertRequestContextActive(context);
      // Register imports for ALL code paths (barrel proxy, prepareModuleOnDemand,
      // custom loaders). Without this, the barrel proxy path skips
      // ensureImportsMapping, so getLoadRequestOnly can't determine what a barrel
      // module imports from its sub-dependencies.
      this.ensureImportsMapping(id, result.imports);
      const replaced = telemetry ? this.loadCache.peek(id) : undefined;
      if (replaced) {
        telemetry?.recordPreparedCacheEviction({
          id,
          knownCodeBytes: Buffer.byteLength(replaced.code),
          reason: 'replacement',
        });
      }
      this.loadCache.set(
        id,
        result,
        telemetry
          ? (evictedId, evicted) => {
              telemetry.recordPreparedCacheEviction({
                id: evictedId,
                knownCodeBytes: Buffer.byteLength(evicted.code),
                reason: 'capacity',
              });
            }
          : undefined
      );
      return invalidated ? { ...result, resetModule: true } : result;
    } finally {
      if (registerPreparation && this.loadInFlight.get(id) === task) {
        this.loadInFlight.delete(id);
      }
    }
  }

  private sendLoadResultForRequest(
    context: EvalRequestContext | undefined,
    id: string,
    payload: Omit<LoadResultPayload, 'chunkIndex' | 'chunkCount' | 'codeChunk'>,
    telemetry?: LoadTransmissionTelemetry,
    allowSuperseded = false
  ): Promise<void> {
    if (!context) return this.sendLoadResult(id, payload, telemetry);
    return sendEvalLoadResult(id, payload, telemetry, (message, onSerialized) =>
      this.sendMessageForRequest(
        context,
        message,
        onSerialized,
        allowSuperseded
      )
    );
  }

  private sendMessageForRequest(
    context: EvalRequestContext | undefined,
    message: MainToRunnerMessage,
    onSerialized?: (bytes: number) => void,
    allowSuperseded = false
  ): Promise<void> {
    if (!context) return this.sendMessage(message, onSerialized);
    if (allowSuperseded) {
      if (!this.isRequestContextActive(context)) {
        if (context.cacheGeneration.invalidationError) {
          throw context.cacheGeneration.invalidationError;
        }
        const error = new Error(
          '[wyw-in-js] Ignoring a stale eval runner response'
        );
        error.name = 'StaleEvalRequestError';
        throw error;
      }
    } else {
      this.assertRequestContextActive(context);
    }
    return sendEvalMessage(context.inputQueue, message, onSerialized);
  }

  private sendLoadResult(
    id: string,
    payload: Omit<LoadResultPayload, 'chunkIndex' | 'chunkCount' | 'codeChunk'>,
    telemetry?: LoadTransmissionTelemetry
  ): Promise<void> {
    return sendEvalLoadResult(id, payload, telemetry, this.sendLoadMessage);
  }

  private sendMessage(
    message: MainToRunnerMessage,
    onSerialized?: (bytes: number) => void
  ): Promise<void> {
    return sendEvalMessage(this.runnerInputQueue, message, onSerialized);
  }

  private handleSendMessageError(
    error: unknown,
    id?: string,
    runner: ChildProcessWithoutNullStreams | null = this.runner
  ) {
    const runnerError =
      error instanceof Error ? error : new Error(String(error));
    const serialized =
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { message: String(error) };

    if (id) {
      this.rejectPending(id, serialized);
    }

    if (runner && this.runner === runner) {
      this.retireRunner(runner, 'send-error', runnerError);
      this.clearEvaluationState();
    }
  }

  private request<TPayload>(
    type: MainToRunnerMessage['type'],
    payload: unknown,
    timeoutMs: number = REQUEST_TIMEOUT_MS
  ): Promise<TPayload> {
    this.nextId += 1;
    const id = `${this.nextId}`;
    const message: MainToRunnerMessage = {
      type: type as MainToRunnerMessage['type'],
      id,
      payload: payload as never,
    } as MainToRunnerMessage;
    const requestRunner = this.runner;
    const requestContext = requestRunner
      ? this.captureRequestContext(requestRunner, this.activeRunnerSessionId) ??
        undefined
      : undefined;

    return new Promise<TPayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(
          `[wyw-in-js] Eval runner timed out for ${type}`
        );
        (error as { code?: string }).code = 'WYW_EVAL_TIMEOUT';
        if (requestRunner) {
          this.retireRunner(requestRunner, `request-timeout:${type}`, error);
        }
        reject(error);
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as PendingRequest['resolve'],
        reject,
        timeout,
      });

      this.sendMessageForRequest(requestContext, message).catch((error) => {
        if (requestContext && !this.isRequestContextActive(requestContext)) {
          return;
        }
        this.handleSendMessageError(error, id, requestRunner);
      });
    });
  }

  private resolvePending(id: string, payload: unknown) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    pending.resolve(payload);
  }

  private rejectPending(
    id: string,
    error: {
      message: string;
      stack?: string;
      cause?: { message: string; stack?: string };
    }
  ) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    const cause = error.cause
      ? Object.assign(new Error(error.cause.message), {
          stack: error.cause.stack,
        })
      : undefined;
    const err = cause
      ? new Error(error.message, { cause })
      : new Error(error.message);
    if (error.stack) {
      err.stack = error.stack;
    }
    pending.reject(err);
  }

  private rejectAllPending(error: Error) {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(error);
    });
    this.pending.clear();
  }

  private mergeKnownDependencyOnly(id: string): string[] {
    const storedOnly = this.onlyByModule.get(id) ?? ['*'];
    if (storedOnly.includes('*')) {
      return storedOnly;
    }

    let mergedOnly = storedOnly;
    for (const cachedEntrypoint of this.currentServices.cache.entrypoints.values() as Iterable<CachedDependencyOwner>) {
      // Scope the union to entrypoints that are part of the CURRENT
      // session's link graph. Cached entrypoints from prior transforms
      // already evaluated against their own VMs; their imports must not
      // widen this load. Empty session graph (initial load) falls back
      // to project-wide for safety.
      if (
        this.sessionLinkGraph.size > 0 &&
        !this.sessionLinkGraph.has(cachedEntrypoint.name)
      ) {
        continue;
      }
      const { dependencies } = cachedEntrypoint;
      if (!dependencies) {
        continue;
      }

      for (const dependency of dependencies.values()) {
        if (dependency.resolved !== id || !dependency.only) {
          continue;
        }

        mergedOnly = mergeOnly(mergedOnly, dependency.only);
        if (mergedOnly.includes('*')) {
          this.onlyByModule.set(id, mergedOnly);
          return mergedOnly;
        }
      }
    }

    this.onlyByModule.set(id, mergedOnly);
    return mergedOnly;
  }
}

const evalBrokers = new WeakMap<object, { key: string; broker: EvalBroker }>();

const missingScopedAsyncResolve = async (): Promise<null> => {
  throw new Error(
    '[wyw-in-js] A scoped eval broker requires a per-session async resolver'
  );
};

export const disposeEvalBroker = (scope: object) => {
  const cached = evalBrokers.get(scope);
  if (!cached) return;
  cached.broker.dispose('registry-dispose');
  evalBrokers.delete(scope);
};

export const getEvalBroker = (
  services: Services,
  asyncResolve: (
    what: string,
    importer: string,
    stack: string[]
  ) => Promise<string | null>,
  cacheKey: string
) => {
  const epochServices = bindServicesToEpoch(services);
  const scope = epochServices.evalBrokerScope ?? epochServices.cache;
  let cached = evalBrokers.get(scope);
  if (cached?.broker.isDisposed) {
    evalBrokers.delete(scope);
    cached = undefined;
  }
  if (cached) {
    registerEvalBrokerRecoveryParticipant(
      getServicesCacheOwner(epochServices),
      cached.broker
    );
    if (hasEvalTelemetryReporter(services.eventEmitter)) {
      recordEvalBrokerLifecycle(services.eventEmitter, cached.broker, () => ({
        event: 'broker-reused',
        reason:
          cached.key === cacheKey ? 'stable-cache-key' : 'shared-runner-scope',
      }));
    }
    cached.key = cacheKey;
    return cached.broker;
  }

  // A shared process scope can outlive the loader invocation that creates it.
  // Never retain that invocation's resolver closure (and its LoaderContext)
  // as the broker's permanent fallback; every configured transform supplies
  // its resolver through the current Services object.
  const broker = new EvalBroker(
    epochServices,
    epochServices.evalBrokerScope ? missingScopedAsyncResolve : asyncResolve,
    Boolean(epochServices.evalBrokerScope)
  );
  evalBrokers.set(scope, { key: cacheKey, broker });
  return broker;
};
