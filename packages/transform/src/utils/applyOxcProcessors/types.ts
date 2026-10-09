import type { BaseProcessor } from '@wyw-in-js/processor-utils';
import type {
  CallExpression,
  Expression,
  Node,
  Program,
  TaggedTemplateExpression,
} from 'oxc-parser';

import type {
  OxcPureCallHint,
  OxcStaticValue,
  OxcStaticValueCandidate,
} from '../collectOxcTemplateDependencies';
import type { TemplateExtractionResult } from '../collectOxcTemplateDependencies/types';
import type { OxcAstService } from '../oxcAstService';
import type { OxcLocationLookup } from '../oxc/sourceLocations';
import type { ProcessorClass } from '../../processors/processorLookup';
import type { DeclarativeProcessorSemantics } from '../../processors/declarativeSemantics';

export type DefinedProcessor = [
  ProcessorClass,
  { imported: string; source: string },
  { declarativeSemantics: DeclarativeProcessorSemantics | null }?,
];

export type StaticPlanFacts = {
  importedNeeds: Array<{ name: string; source: string }>;
  staticValueCount: number;
  unresolvedCount: number;
  usageCount: number;
};

export type OxcProcessorAnalysisPlan = {
  code: string;
  extracted: TemplateExtractionResult;
  filename: string;
  processorUsages: ProcessorUsage[];
  program: Program;
  removableImportLocals: Set<string>;
  usedNames: Set<string>;
};

export type ApplyOxcProcessorsResult = {
  code: string;
  finalizeProcessorCallbacks?: (
    staticValueCache?: Map<string, unknown>
  ) => ApplyOxcProcessorsResult;
  processorManagedExpressionSpans: ExpressionSpan[];
  // Selector-only processor class names (css`...`-style). Safe to use as
  // a class-name fallback in cross-file static-export resolution because
  // the runtime value of the binding IS this string.
  processorClassNamesByLocal: Map<string, string>;
  processors: BaseProcessor[];
  pureCallHints: OxcPureCallHint[];
  runtimeProcessorPlan?: OxcProcessorAnalysisPlan;
  staticPlanFacts: StaticPlanFacts;
  staticValueCandidates: OxcStaticValueCandidate[];
  staticValues: OxcStaticValue[];
};

export type AnyNode = Node & Record<string, unknown>;

export type OxcIdentifier = Expression & {
  name: string;
  type: 'Identifier';
};

export type ProcessorUsage =
  | {
      ancestors: Node[];
      callee: Expression;
      collapseQualifiedCallee: boolean;
      definedProcessor: DefinedProcessor;
      kind: 'call';
      replacementTarget: Expression;
      target: CallExpression;
    }
  | {
      ancestors: Node[];
      callee: Expression;
      collapseQualifiedCallee: boolean;
      definedProcessor: DefinedProcessor;
      kind: 'template';
      replacementTarget: Expression;
      target: TaggedTemplateExpression;
    };

export type ExpressionSpan = {
  end: number;
  start: number;
};

export type CreatedProcessor = {
  astService: OxcAstService;
  evaltimeLive: boolean;
  processor: BaseProcessor;
};

export type QualifiedExpression = Expression & {
  expressions?: Expression[];
};

export type CallExpressionLike = Expression & {
  arguments: Node[];
  callee: Expression;
  type: 'CallExpression';
};

export type SequenceExpressionLike = Expression & {
  expressions: Expression[];
  type: 'SequenceExpression';
};

export type LocationLookup = OxcLocationLookup;

export type TopLevelStatementInfo = {
  bindings: Set<string>;
  node: Node;
  references: Set<string>;
};

export type ScopedBindingKind = 'function' | 'import' | 'param' | 'variable';

export type ScopedBindingInfo = {
  declaration: Node;
  dependencies: Set<string>;
  externalReferences: number;
  id: string;
  incomingFromBindings: Set<string>;
  kind: ScopedBindingKind;
  name: string;
};

export type ScopedCleanupScope = {
  bindings: Map<string, string>;
  parent: ScopedCleanupScope | null;
};

export type SameFileProcessorObject = {
  properties: Map<string, BaseProcessor>;
  propertyNames: Set<string>;
};
