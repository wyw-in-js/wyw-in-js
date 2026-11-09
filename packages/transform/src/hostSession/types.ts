/**
 * The interface of the long-lived host session: one per compiler, plugin
 * instance or bundler environment. A session loads the options and computes
 * the evaluation cache key once, owns the transform cache and the eval runner,
 * and projects every `Result` into one normalized output, so that bundler
 * integrations stop re-implementing these rules around `transform()`.
 *
 * Types only: the implementation and the package export come later. Until
 * then nothing here is part of the public API.
 */
import type { RawSourceMap } from 'source-map';

import type { EvalResolverKind, NativeResolverAlias } from '@wyw-in-js/shared';

import type { ResolveRequest } from '../resolve/resolvePolicy';
import type { PartialOptions } from '../transform/helpers/loadWywOptions';
import type { Options, Result } from '../types';
import type { EventEmitter } from '../utils/EventEmitter';
import type { WYWTransformDiagnostic } from '../utils/TransformDiagnostics';
import type { WYWTransformResultMetadata } from '../utils/TransformMetadata';

/* ------------------------------------------------------------------------ */
/* Input of a session                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Raw user options as the integration received them, minus its own keys. The
 * session normalizes them once; plugin options win over the config file.
 */
export type HostOptions = PartialOptions &
  Pick<Options, 'keepComments' | 'prefixer' | 'preprocessor'>;

/**
 * An import the engine asks the bundler to resolve. `kind` is absent while the
 * engine cannot report it; the session never invents a value.
 */
export type HostResolveRequest = Pick<
  ResolveRequest,
  'importer' | 'specifier' | 'stack'
> & {
  kind?: EvalResolverKind;
};

/**
 * Resolves through the bundler. `null` is a miss; a thrown error keeps the
 * meaning it has today in each phase (prepare fails, evaluation may fall back).
 * `context` is the value of the call that issued the request.
 */
export type HostResolve<TContext> = (
  request: HostResolveRequest,
  context: TContext
) => Promise<string | null>;

export type HostLoadRequest = {
  /** The resolved id of the dependency. */
  id: string;
  importer: string;
  specifier: string;
};

/**
 * Loads a dependency's code as the bundler sees it. `undefined` reads the file
 * from disk. Code only: parsing stays in the engine.
 */
export type HostLoad<TContext> = (
  request: HostLoadRequest,
  context: TContext
) => Promise<string | undefined>;

/**
 * What the session needs from the bundler: its capabilities and its facts,
 * fixed for the life of the session. Facts only fill what the user left unset.
 */
export type HostBundler<TContext> = {
  /** Alias in any form the native resolver alias helper accepts. */
  alias?: unknown;
  /** Resolve conditions of the bundler, e.g. `['import', 'browser']`. */
  conditions?: readonly string[];
  /** Resolve extensions of the bundler. */
  extensions?: readonly string[];
  /**
   * Globals added to the evaluation context of every module, e.g. the values
   * of `import.meta.env`. Structured-cloneable data.
   */
  globals?: Readonly<Record<string, unknown>>;
  load?: HostLoad<TContext>;
  resolve: HostResolve<TContext>;
  /** Project root: part of the cache key and of class name hashing. */
  root?: string;
};

/** A warning of one call, or of no call when it arrived after the call settled. */
export type HostWarning =
  | ({ source: 'processor' } & WYWTransformDiagnostic)
  | {
      filename: string | null;
      message: string;
      severity: 'warning';
      source: 'pipeline';
    };

export type HostSessionInput<TContext> = {
  bundler: HostBundler<TContext>;
  /** Default: an in-process engine of this session, released by `close()`. */
  engine?: HostEngine;
  /** Passed through to the pipeline unchanged; it never affects identity. */
  eventEmitter?: EventEmitter;
  /** Warnings that belong to no pending call. Default: `console.warn`. */
  onWarning?: (warning: HostWarning) => void;
  options?: HostOptions;
  /**
   * Sessions of one engine with the same runner name share one eval runner
   * process. Without it the session has a runner of its own.
   */
  runner?: string;
};

/* ------------------------------------------------------------------------ */
/* Operations and output                                                     */
/* ------------------------------------------------------------------------ */

export type HostFile = {
  code: string;
  filename: string;
  inputSourceMap?: RawSourceMap | null;
  outputFilename?: string;
};

export type HostCss = {
  map: string | null;
  /** A hint only: integrations keep their own CSS ids. */
  suggestedId: string;
  /** Never empty: a file without styles has `css: null`. */
  text: string;
};

/**
 * The normalized output of one transform.
 *
 * - `changed: false`: hand the bundler its input back; `code` and `map` are
 *   the input's. A result without CSS metadata is never a change.
 * - `css !== null` implies `changed`.
 */
export type HostOutput = {
  changed: boolean;
  code: string;
  css: HostCss | null;
  /** Resolved compile-time dependencies, without duplicates. */
  dependencies: readonly string[];
  map: RawSourceMap | null;
  /** The body of the transform manifest, when `outputMetadata` is on. */
  metadata: WYWTransformResultMetadata | null;
  /** Dependencies that no resolver could resolve. */
  unresolved: readonly string[];
  /** Every diagnostic and warning of the call; severity `error` included. */
  warnings: readonly HostWarning[];
};

export interface HostSession<TContext = void> {
  /**
   * Final and idempotent: waits for pending calls, then disposes the eval
   * runner, the caches and the processor lookups of the session.
   */
  close(): Promise<void>;
  /**
   * Files changed on disk. Applies to calls that start after it returns.
   * Returns the roots whose last output depended on them, or every root when
   * a config file or a `package.json` changed.
   */
  invalidate(files: Iterable<string>): readonly string[];
  /**
   * Transforms one file. Calls may run concurrently and from inside `resolve`
   * or `load`; `context` reaches those callbacks and never affects identity.
   * Rejects with the pipeline's own error, or with `HostSessionClosedError`.
   */
  transform(file: HostFile, context: TContext): Promise<HostOutput>;
}

export type CreateHostSession = <TContext = void>(
  input: HostSessionInput<TContext>
) => HostSession<TContext>;

export interface HostSessionClosedError extends Error {
  code: 'WYW_HOST_SESSION_CLOSED';
}

/* ------------------------------------------------------------------------ */
/* Engines and the engine seam                                               */
/* ------------------------------------------------------------------------ */

export type HostEngineOptions = {
  /** Reports, once per reason, why a session stays on the calling thread. */
  onFallback?: (message: string) => void;
  /** Worker threads: `true` uses the default count, falsy stays in-process. */
  workers?: boolean | number;
};

export type CreateHostEngine = (options?: HostEngineOptions) => HostEngine;

/**
 * What a session sends to its engine when it opens. Structured-cloneable,
 * except `options` holding functions and `eventEmitter`, which only an
 * in-process engine accepts.
 */
export type EngineScope = {
  alias: NativeResolverAlias | null;
  conditions: readonly string[] | null;
  eventEmitter: EventEmitter | null;
  extensions: readonly string[] | null;
  globals: Readonly<Record<string, unknown>> | null;
  /** Whether the host has a load capability. */
  load: boolean;
  options: HostOptions;
  root: string;
  runner: string | null;
};

/** Requests of the engine to the host; every argument is serializable. */
export interface EngineHost {
  load(callId: number, request: HostLoadRequest): Promise<string | undefined>;
  resolve(callId: number, request: HostResolveRequest): Promise<string | null>;
  warn(callId: number | null, message: string): void;
}

export type EngineResult = {
  /** Config files the options were read from. */
  optionSources: readonly string[];
  result: Result;
  /** The evaluation cache key of the call; stable for the session. */
  salt: string;
};

export interface EngineSession {
  close(): Promise<void>;
  /** `all`: a global input changed, drop every cached entry of the session. */
  invalidate(files: readonly string[], extent: 'files' | 'all'): void;
  /** Deterministic: assigned by the engine in the order sessions open. */
  readonly key: string;
  transform(callId: number, file: HostFile): Promise<EngineResult>;
}

export interface HostEngine {
  open(scope: EngineScope, host: EngineHost): EngineSession;
  /**
   * Disposes every eval runner of the engine; caches stay and runners restart
   * on the next transform. Idempotent.
   */
  release(): Promise<void>;
}
