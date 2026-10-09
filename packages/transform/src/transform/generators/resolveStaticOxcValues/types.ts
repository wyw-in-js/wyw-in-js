import type { Expression, Node, Program } from 'oxc-parser';

import type { runOxcPreevalStage } from '../../../utils/oxcPreevalStage';
import type { ITransformAction, SyncScenarioFor } from '../../types';

export type AnyNode = Node & Record<string, unknown>;

export type ImportBinding = {
  imported: '*' | 'default' | string;
  local: string;
  source: string;
};

export type CollectImportBindingsOptions = {
  includeNamespace?: boolean;
};

export type ExportTarget =
  | {
      expression: Expression;
      kind: 'expression';
      localName?: string;
    }
  | {
      imported: 'default' | string;
      kind: 'import';
      source: string;
    };

export type StaticExportResult = {
  callable?: 'zero-arg';
  dependencies: string[];
  // True when the candidate's value is a runtime callback (function)
  // already represented in the bundle as the locally-defined `_exp =
  // () => ...` arrow. The file does not need evalFile because of this
  // candidate, but the helper declaration must NOT be pruned — the
  // runtime call site relies on it.
  runtimeOnly?: boolean;
  sideEffectDependencies?: string[];
  sideEffectImportLocals?: string[];
  value: unknown;
};

export type StaticFileAnalysis = {
  code: string;
  codeHash: string;
  program: Program;
};

export type StaticFileHashCacheEntry = {
  hash: string;
  mtimeMs: number;
  size: number;
};

export type StaticMetadataPreevalCacheEntry =
  | {
      result: null;
    }
  | {
      result: ReturnType<typeof runOxcPreevalStage>;
    };

// Null entries carry an attempt counter so we can retry a bounded number of
// times before accepting the failure as stable. This avoids both:
// (a) poisoning the cache forever from a transient resolver failure
// (b) thundering-herd retries where every consumer re-walks a stable miss
export type StaticExportCacheEntry =
  | {
      attempts: number;
      result: null;
    }
  | {
      dependencyHashes: Map<string, string>;
      result: StaticExportResult;
    };

export const STATIC_EXPORT_MAX_NULL_ATTEMPTS = 2;
export const GENERATED_HELPER_NAME_RE = /^_exp\d*$/;

export type StaticExpressionOptions = {
  allowMetadataCalls?: boolean;
  ignoredMutableCallArgumentNames?: Set<string>;
  // Names of same-file locals whose value the resolver already knows
  // out-of-band (e.g. processor className strings from
  // applyOxcProcessors). Skip walking into their inits during
  // dependency collection — `const x = css`...`` has a
  // TaggedTemplateExpression init that fails isSafeStaticExpression,
  // but we don't need to walk it because `x`'s value is already
  // resolved.
  preResolvedLocals?: ReadonlySet<string>;
  // Local names of imports registered as pure helpers via
  // pluginOptions.staticBindings (e.g. `cx` from '@linaria/core',
  // `isFlagPresent` from './flags'). CallExpressions whose callee is
  // in this set are admitted by isSafeStaticExpression provided every
  // arg is itself safe-static. The actual invocation happens in
  // evaluateStatic via the env-bound function.
  staticHelperLocals?: ReadonlySet<string>;
};

export type StaticResolveDebugPhase =
  | 'candidate'
  | 'entrypoint'
  | 'export'
  | 'import'
  | 'processor-metadata';

export type StaticResolveDebugStatus = 'rejected' | 'resolved' | 'skipped';

export type StaticResolveDebugEvent = {
  candidate?: string;
  dependency?: string;
  exported?: string;
  filename: string;
  imported?: string;
  importer?: string;
  phase: StaticResolveDebugPhase;
  reason?: string;
  source?: string;
  status: StaticResolveDebugStatus;
};

export type Range = {
  end: number;
  start: number;
};

export type StaticExpressionDependencies = {
  imports: ImportBinding[];
};

export type PreparedProcessorTarget = {
  dependencies: StaticExpressionDependencies;
  evaluationCode?: string;
  evaluationSpan?: Range;
  expression: Expression;
  opaqueRuntimeBase: boolean;
};

export type OpaqueRuntimeImportProof = {
  dependencies: string[];
  names: Set<string>;
};

export type ResolveStaticImportValue = (
  action: ITransformAction,
  importer: string,
  binding: Pick<ImportBinding, 'imported' | 'source'>,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>
) => SyncScenarioFor<StaticExportResult | null>;

export type ResolveStaticExportValue = (
  action: ITransformAction,
  filename: string,
  exportedName: string,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>
) => SyncScenarioFor<StaticExportResult | null>;

export type StaticExportResolverContext = {
  resolveImportValue: ResolveStaticImportValue;
  resolveStaticExport: ResolveStaticExportValue;
};
