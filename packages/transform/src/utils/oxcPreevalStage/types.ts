import type { StrictOptions } from '@wyw-in-js/shared';

import type { EventEmitter } from '../EventEmitter';
import type { WYWTransformMetadata } from '../TransformMetadata';
import type {
  ExpressionSpan,
  OxcProcessorAnalysisPlan,
  StaticPlanFacts,
} from '../applyOxcProcessors/types';
import type {
  OxcPureCallHint,
  OxcStaticValueCandidate,
} from '../collectOxcTemplateDependencies';

export type OxcPreevalOptions = Pick<
  StrictOptions,
  | 'classNameSlug'
  | 'codeRemover'
  | 'displayName'
  | 'eval'
  | 'extensions'
  | 'features'
  | 'processors'
  | 'staticBindings'
  | 'tagResolver'
> & { eventEmitter?: EventEmitter };

export type OxcPreevalResult = {
  baseCode: string;
  /** Executable source is serialized and memoized when first read. */
  code: string;
  dependencyNames: string[];
  finalizeEvaltimeReplacements?: (
    staticValueCache?: Map<string, unknown>
  ) => void;
  metadata: WYWTransformMetadata | null;
  processorManagedExpressionSpans: ExpressionSpan[];
  processorClassNames: Record<string, string>;
  pureCallHints: OxcPureCallHint[];
  runtimeProcessorPlan?: OxcProcessorAnalysisPlan;
  staticDependencies: string[];
  staticPlanFacts: StaticPlanFacts;
  staticValueCache: Map<string, unknown>;
  staticValueCandidates: OxcStaticValueCandidate[];
};

export type StaticPreevalOverlay = {
  evalDependencyNames: string[];
  staticValueCache: Map<string, unknown>;
  staticValueCandidates: OxcStaticValueCandidate[];
};
