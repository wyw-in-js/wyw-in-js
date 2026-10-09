/**
 * Data contract of the freshness characterization table.
 *
 * A scenario is plain data: an initial project, named sessions (the bundler
 * configuration a transform runs with) and a list of steps. Steps either change
 * the world (files on disk, explicit cache invalidation) or run transforms and
 * state what the engine is expected to observe:
 *
 * - `css`       — the extracted CSS of every call (rule bodies, class names
 *                 stripped, so the expectation does not depend on slugs);
 * - `error`     — a substring of the error a call rejects with;
 * - `prepared`  — files that published a new prepared (shaken) module, i.e.
 *                 were recomputed instead of being taken from the cache
 *                 (preparation the eval broker does on demand for its own
 *                 loads is not published and shows up only as `evaluated`);
 * - `evaluated` — files whose code was shipped to the eval runner again;
 * - `reset`     — whether the step discarded the whole cache: `salt` (the
 *                 cache key salt changed) or `recovery` (fail-closed
 *                 recovery of the cache lifecycle).
 *
 * Adapters execute a scenario and report one {@link StepObservation} per
 * observing step. The current adapter drives `transform()` and
 * `TransformCacheCollection`; a module-graph or native engine can provide its
 * own adapter and reuse the same table.
 */

/** How the code of a file reaches the engine. */
export type SourceMode =
  /** The bytes on disk. */
  | 'disk'
  /**
   * Bundler-loaded code: the disk bytes with every `-disk` marker rewritten
   * to `-loaded`, so the extracted CSS reveals which source was evaluated.
   */
  | 'loaded'
  /** The loader declines to provide code; the engine falls back to disk. */
  | 'none';

export interface SessionSpec {
  /**
   * Stable semantic key of the resolver (`asyncResolveKey`). `null` leaves it
   * out, so the cache salt depends on the resolver function identity.
   */
  resolverKey?: string | null;
  /** Create a new resolver function for every transform call. */
  freshResolverPerCall?: boolean;
  /** Bundler dependency loader (`loadDependencyCode`). */
  loader?: {
    /** `loadDependencyCodeKey` — the stable identity of the loader. */
    key: string;
    /** Per-file behaviour; files that are not listed are not loaded. */
    files: Record<string, SourceMode>;
  };
  /** Plugin options merged over the base options of the table. */
  pluginOptions?: Record<string, unknown>;
  /** Create a new (equal) plugin options object for every transform call. */
  freshPluginOptionsPerCall?: boolean;
  /** Named eval runner scope (`evalBrokerScope`). */
  evalBrokerScope?: string;
}

export interface TransformCall {
  /** Project-relative path; may carry a `?query` / `#hash` suffix. */
  file: string;
  /** Label of the call in expectations; defaults to `file`. */
  id?: string;
  /** Session name; defaults to `default`. */
  session?: string;
  /** Code handed to `transform()`; defaults to `disk`. */
  source?: Exclude<SourceMode, 'none'>;
}

export type Hold =
  /** Block the resolver call `request` made by `importer` (first match). */
  | { at: 'resolve'; importer: string; request: string }
  /** Block the call right before its evaluation stage. */
  | { at: 'eval' };

export interface StepExpectation {
  /** Call label → CSS rule bodies in output order. */
  css?: Record<string, string[]>;
  /** Call label → substring of the error message. */
  error?: Record<string, string>;
  /** Files that published a new prepared module during the step. */
  prepared?: string[];
  /** Files whose code was executed by the eval runner during the step. */
  evaluated?: string[];
  /** Whole-cache reset during the step; `none` is checked by default. */
  reset?: 'none' | 'salt' | 'recovery';
  /** `consumeInvalidation` result (only for `consumeInvalidation` steps). */
  consumed?: boolean;
}

export interface KnownBug {
  /** What is wrong with the current behaviour (in Russian, like the plan). */
  description: string;
  /** `correctness` — wrong or stale output; `performance` — wasted work. */
  impact: 'correctness' | 'performance';
  /** The intended observation; replaces the matching keys of `expect`. */
  intended: StepExpectation;
}

interface ObservingStep {
  expect: StepExpectation;
  /** The current behaviour diverges from the intended one. */
  knownBug?: KnownBug;
  /** Why the step exists; shown in assertion diffs. */
  note?: string;
}

export type Step =
  | {
      do: 'write';
      files: Record<string, string>;
      /** `preserve` keeps the previous mtime (an edit hidden from mtime). */
      mtime?: 'advance' | 'preserve';
    }
  | { do: 'touch'; files: string[] }
  | { do: 'remove'; files: string[] }
  | { do: 'rename'; from: string; to: string }
  /** `TransformCacheCollection.invalidateForFile` for every file. */
  | { do: 'invalidate'; files: string[] }
  /**
   * Start a transform in the background. With `hold`, wait until the call
   * reaches it; without, return right away (the call runs until it blocks).
   */
  | { do: 'start'; id: string; call: TransformCall; hold?: Hold }
  /** Let a held background transform continue. */
  | { do: 'release'; id: string }
  /** Run the calls concurrently and wait for all of them. */
  | (ObservingStep & { do: 'transform'; calls: TransformCall[] })
  /** Wait for every background transform that was started. */
  | (ObservingStep & { do: 'join' })
  /** `TransformCacheCollection.consumeInvalidation(file)`. */
  | (ObservingStep & { do: 'consumeInvalidation'; file: string });

export type ObservingStepKind = 'consumeInvalidation' | 'join' | 'transform';

export type ObservedStep = Extract<Step, { do: ObservingStepKind }>;

export interface FreshnessScenario {
  /** Stable identifier, used as the test name. */
  id: string;
  /** One-line description (Russian, like the plan). */
  title: string;
  /** Historical fixes the scenario pins (PR numbers such as `#263`). */
  refs: string[];
  /** Initial project files (project-relative path → content). */
  files: Record<string, string>;
  sessions?: Record<string, SessionSpec>;
  steps: Step[];
}

export interface StepObservation {
  css: Record<string, string[]>;
  error: Record<string, string>;
  prepared: string[];
  evaluated: string[];
  reset: 'none' | 'salt' | 'recovery';
  consumed?: boolean;
}

export const isObservingStep = (step: Step): step is ObservedStep =>
  step.do === 'transform' ||
  step.do === 'join' ||
  step.do === 'consumeInvalidation';
