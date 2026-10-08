import type {
  Debugger,
  Evaluator,
  TransformEngineOptions,
} from '@wyw-in-js/shared';

import type { Services } from './types';
import type { WYWTransformMetadata } from '../utils/TransformMetadata';
import type {
  OxcProcessorAnalysisPlan,
  StaticPlanFacts,
} from '../utils/applyOxcProcessors/types';
import type { OxcPureCallHint } from '../utils/collectOxcTemplateDependencies';

export type ParsedAst = unknown;

export interface IEntrypointCode {
  /** Not produced by the Oxc pipeline; custom `loadAndParseFn` may set it. */
  readonly ast?: ParsedAst;
  code: string;
  evalConfig: TransformEngineOptions;
  evaluator: Evaluator;
}

export interface IIgnoredEntrypoint {
  readonly ast?: ParsedAst;
  readonly code?: string;
  evaluator: 'ignored';
  reason: 'extension' | 'rule';
}

export interface IEntrypointDependency {
  loadedCode?: string;
  only: string[];
  resolved: string | null;
  source: string;
}

export interface IPreevalResult {
  /** Not produced by the Oxc pipeline. */
  ast?: ParsedAst | null;
  baseCode?: string;
  code: string;
  dependencyNames?: string[];
  evalCode?: string;
  executeSideEffectDependencies?: string[];
  executeSideEffectProvenanceResolved?: boolean;
  finalizeEvaltimeReplacements?: (
    staticValueCache?: Map<string, unknown>
  ) => void;
  metadata: WYWTransformMetadata | null;
  processorClassNames?: Record<string, string>;
  pureCallHints?: OxcPureCallHint[];
  runtimeProcessorPlan?: OxcProcessorAnalysisPlan;
  staticImportLocals?: string[];
  staticSideEffectImportLocals?: string[];
  staticDependencies?: string[];
  staticNullWYWMetaExtendsHelpers?: string[];
  staticPlanFacts?: StaticPlanFacts;
  staticValuesApplied?: boolean;
  staticValueCache?: Map<string, unknown>;
  runtimeOnlyStaticValueNames?: string[];
  staticValueCandidates?: Array<{
    imports: Array<{
      imported: 'default' | string;
      importLocal?: string;
      local: string;
      source: string;
    }>;
    mutationGuards?: Array<{
      importedFrom: string[];
      imports: Array<{
        imported: 'default' | string;
        importLocal?: string;
        local: string;
        source: string;
      }>;
      pureCallHintSpan?: {
        end: number;
        start: number;
      };
      source: string;
    }>;
    name: string;
    source: string;
  }>;
}

export type LoadAndParseFn = (
  services: Services,
  name: string,
  loadedCode: string | undefined,
  log: Debugger
) => IEntrypointCode | IIgnoredEntrypoint;
