/**
 * The resolve policy: which resolver answers an import, in which order, and
 * what its answer means. Both the prepare stage (`resolveImports`) and the
 * eval broker resolve through `resolveWithPolicy`; the bundler resolver and
 * the native Oxc resolver are adapters behind its seam.
 *
 * The policy computes a cache miss. Memoization stays with each consumer
 * (Entrypoint dependencies/resolve tasks, the broker resolve cache) because
 * their lifetimes differ; import overrides are applied by the consumer after
 * its memo with `applyImportOverride` from `utils/importOverrides`.
 */
import fs from 'fs';
import path from 'path';

import type {
  EvalOptionsV2,
  EvalRequireMode,
  EvalResolverKind,
  EvalResolverMode,
  ImportOverride,
  StrictOptions,
} from '@wyw-in-js/shared';

import { resolveWithNativeResolver } from '../utils/nativeResolver';
import { stripQueryAndHash } from '../utils/parseRequest';

/**
 * `prepare` builds the dependency graph: a miss means the import is ignored.
 * `eval` serves the runner: ids are normalized to files on disk, and in
 * `bundler` mode an unknown import falls back to the native resolver
 * (unless `eval.require` is `off`).
 */
export type ResolvePhase = 'prepare' | 'eval';

export type ResolveRequest = {
  importer: string;
  kind: EvalResolverKind;
  specifier: string;
  stack: string[];
};

export type NativeResolveRequest = Pick<
  ResolveRequest,
  'importer' | 'kind' | 'specifier'
>;

export type ResolveStep = 'custom' | 'native' | 'bundler' | 'native-fallback';

/**
 * - `file`: an absolute path on disk (query/hash allowed);
 * - `virtual`: an id that is not a path on disk (`\0…`, `virtual:…`, `/@…`,
 *   builtins and other bare ids a resolver chose to return);
 * - `external`: the custom resolver asked to load the id as an external
 *   package instead of evaluating it;
 * - `not-found`: no resolver produced an id.
 */
export type ResolveOutcome =
  | {
      id: string;
      kind: 'external' | 'file' | 'virtual';
      via: ResolveStep;
    }
  | { kind: 'not-found' };

/** `eval.customResolver`, as the policy calls it. */
export type CustomResolverAdapter = (
  specifier: string,
  importer: string,
  kind: EvalResolverKind
) => Promise<{ external?: boolean; id: string } | null | undefined>;

/** Resolves synchronously or throws when the specifier cannot be resolved. */
export type NativeResolverAdapter = (request: NativeResolveRequest) => string;

/**
 * Resolves through the bundler; `null` (or an empty id) is a miss. Errors
 * propagate: the adapter owner decides whether a failure is a miss.
 */
export type BundlerResolverAdapter = (
  request: ResolveRequest
) => Promise<string | null>;

export type ResolverAdapters = {
  bundler: BundlerResolverAdapter;
  custom?: CustomResolverAdapter;
  native: NativeResolverAdapter;
};

export type ResolveTraceEvent =
  | { external: boolean; id: string; normalized: string; step: 'custom' }
  | { id: string; normalized: string; step: 'bundler' }
  | { id: string; step: 'native' | 'native-fallback' }
  | { error: unknown; step: 'native-miss' | 'normalize-miss' }
  | { step: 'none' };

export type ResolveTrace = (
  request: NativeResolveRequest,
  event: ResolveTraceEvent
) => void;

export type ResolvePolicySettings = {
  /** Extensions probed by eval-phase id normalization. */
  extensions?: readonly string[];
  mode: EvalResolverMode | undefined;
  phase: ResolvePhase;
  /** `eval.require`; only the eval phase reads it. */
  require?: EvalRequireMode;
  trace?: ResolveTrace;
};

export type NormalizeContext = {
  extensions: readonly string[];
  native: NativeResolverAdapter;
  trace?: ResolveTrace;
};

export const isVirtualModuleId = (id: string): boolean =>
  id.startsWith('/@') || id.startsWith('virtual:') || id.startsWith('\0');

export const classifyResolvedId = (id: string): 'file' | 'virtual' => {
  if (isVirtualModuleId(id)) return 'virtual';
  return path.isAbsolute(stripQueryAndHash(id)) ? 'file' : 'virtual';
};

/**
 * Turns an extensionless id into a file on disk: probes the configured
 * extensions and index files next to it, then asks the native resolver.
 * Ids that already have an extension, and package ids, are kept as is.
 */
export function normalizeResolvedId(
  resolvedId: string,
  request: NativeResolveRequest,
  { extensions, native, trace }: NormalizeContext
): string {
  const { importer, kind, specifier } = request;
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
    if (!importer) {
      return resolvedId;
    }
    const importerFile = stripQueryAndHash(importer);
    candidate = path.resolve(path.dirname(importerFile), candidate);
  }

  const suffix = resolvedId.slice(stripped.length);
  for (const ext of extensions) {
    const fileCandidate = `${candidate}${ext}`;
    if (fs.existsSync(fileCandidate)) {
      return `${fileCandidate}${suffix}`;
    }

    const indexCandidate = path.join(candidate, `index${ext}`);
    if (fs.existsSync(indexCandidate)) {
      return `${indexCandidate}${suffix}`;
    }
  }

  if (importer) {
    try {
      const resolved = native({
        importer: stripQueryAndHash(importer),
        kind,
        specifier: resolvedId,
      });
      if (resolved && resolved !== stripped) {
        return resolved;
      }
    } catch (error) {
      trace?.(request, { error, step: 'normalize-miss' });
    }
  }

  return resolvedId;
}

const nativeFailureDuringEval = (
  { importer, specifier }: NativeResolveRequest,
  error: unknown
): Error =>
  new Error(
    [
      `[wyw-in-js] Native resolver failed during eval.`,
      ``,
      `importer: ${importer}`,
      `source:   ${specifier}`,
      ``,
      `error: ${error instanceof Error ? error.message : String(error)}`,
    ].join('\n')
  );

/**
 * Resolves one import: custom resolver first, then the configured mode
 * (`hybrid`: native, then bundler; `native`: native only; `bundler`: bundler,
 * then native fallback during eval). A throwing native resolver is a miss in
 * `hybrid` mode and an error everywhere else.
 */
export async function resolveWithPolicy(
  request: ResolveRequest,
  settings: ResolvePolicySettings,
  adapters: ResolverAdapters
): Promise<ResolveOutcome> {
  const { mode, phase, trace } = settings;
  const isEval = phase === 'eval';
  const nativeRequest: NativeResolveRequest = {
    importer: request.importer,
    kind: request.kind,
    specifier: request.specifier,
  };
  const normalize = (id: string): string =>
    isEval
      ? normalizeResolvedId(id, nativeRequest, {
          extensions: settings.extensions ?? [],
          native: adapters.native,
          trace,
        })
      : id;
  const found = (
    id: string,
    via: ResolveStep,
    external = false
  ): ResolveOutcome => ({
    id,
    kind: external ? 'external' : classifyResolvedId(id),
    via,
  });
  const resolveNatively = (): string => {
    try {
      return adapters.native(nativeRequest);
    } catch (error) {
      throw isEval ? nativeFailureDuringEval(nativeRequest, error) : error;
    }
  };

  if (adapters.custom) {
    const result = await adapters.custom(
      request.specifier,
      request.importer,
      request.kind
    );
    if (result) {
      const { id } = result;
      const external = Boolean(result.external);
      const normalized = normalize(id);
      trace?.(nativeRequest, { external, id, normalized, step: 'custom' });
      return found(normalized, 'custom', external);
    }

    if (mode === 'custom') {
      return { kind: 'not-found' };
    }
  }

  if (mode === 'hybrid') {
    try {
      const id = normalize(resolveNatively());
      trace?.(nativeRequest, { id, step: 'native' });
      return found(id, 'native');
    } catch (error) {
      // Hybrid mode lets the bundler resolver handle aliases, virtual IDs,
      // and other specifiers that the native resolver cannot resolve.
      trace?.(nativeRequest, { error, step: 'native-miss' });
    }
  }

  if (mode === 'native') {
    const id = normalize(resolveNatively());
    trace?.(nativeRequest, { id, step: 'native' });
    return found(id, 'native');
  }

  // The prepare stage has always sent every other mode (including `custom`
  // without a custom resolver) to the bundler; eval resolves nothing there.
  if (mode === 'bundler' || mode === 'hybrid' || !isEval) {
    const id = await adapters.bundler(request);
    if (id) {
      const normalized = normalize(id);
      trace?.(nativeRequest, { id, normalized, step: 'bundler' });
      return found(normalized, 'bundler');
    }
  }

  if (isEval && mode === 'bundler' && settings.require !== 'off') {
    const id = normalize(resolveNatively());
    trace?.(nativeRequest, { id, step: 'native-fallback' });
    return found(id, 'native-fallback');
  }

  trace?.(nativeRequest, { step: 'none' });
  return { kind: 'not-found' };
}

/**
 * What to do when an eval-time import reached the native fallback: an
 * override that does not set `unknown` already covers the import; otherwise
 * `eval.require` decides, and `require: 'off'` always errors.
 */
export function getNativeFallbackPolicy(
  require: EvalRequireMode | undefined,
  override: ImportOverride | undefined
): 'allow' | 'error' | 'warn' {
  if (override && override.unknown === undefined) {
    return 'allow';
  }

  const basePolicy = require === 'warn-and-run' ? 'warn' : 'error';
  const policy = override?.unknown ?? basePolicy;
  return require === 'off' && policy !== 'error' ? 'error' : policy;
}

export const createNativeResolverAdapter =
  (
    getOptions: () => Pick<
      StrictOptions,
      'conditionNames' | 'extensions' | 'oxcOptions'
    >
  ): NativeResolverAdapter =>
  ({ importer, kind, specifier }) => {
    const { conditionNames, extensions, oxcOptions } = getOptions();
    return resolveWithNativeResolver({
      conditionNames,
      extensions,
      importer,
      kind,
      oxcOptions,
      specifier,
    });
  };

export const getCustomResolverAdapter = (
  evalOptions: EvalOptionsV2
): CustomResolverAdapter | undefined =>
  evalOptions.customResolver
    ? (specifier, importer, kind) =>
        evalOptions.customResolver!(specifier, importer, kind)
    : undefined;
