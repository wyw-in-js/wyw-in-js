import type { ExpressionValue, ValueType } from '@wyw-in-js/shared';
import type {
  AssignmentExpression,
  Expression,
  Node,
  Program,
  TemplateLiteral,
  UpdateExpression,
  VariableDeclaration,
  VariableDeclarator,
} from 'oxc-parser';

import type { OxcEdit } from '../oxc/fileEdits';
import type { OxcFunctionLike } from '../oxc/runtimeSemantics';
import type { OxcLocationLookup } from '../oxc/sourceLocations';
import type { RecursiveProofState } from './recursiveProof';

export type OxcFunctionLikeNode = OxcFunctionLike;
export type BindingKind = 'function' | 'import' | 'param' | 'variable';
export type ScopedDeclarationKind = 'const' | 'let' | 'var';

export type Binding = {
  declarationKind?: ScopedDeclarationKind;
  declaredAt: number;
  declaration: VariableDeclaration | null;
  declarator: VariableDeclarator | null;
  functionNode?: OxcFunctionLikeNode | null;
  imported?: 'default' | '*' | string;
  importedFrom?: string;
  isIteration?: boolean;
  isRoot: boolean;
  kind: BindingKind;
  name: string;
  scope: Scope;
};

export type BindingIndex = {
  readonly bindingsByName: ReadonlyMap<string, readonly Binding[]>;
  readonly referenceScopesByStart: ReadonlyMap<number, Scope>;
};

export type SpanLookup = Set<string> | null;

export type LocationLookup = OxcLocationLookup;

export type ExpressionSpan = {
  end: number;
  start: number;
};

export type MutationSpan = Pick<Node, 'end' | 'start'>;

export type MutationTimeline<T extends MutationSpan = Node> = {
  readonly byEnd: readonly T[];
  readonly byStart: readonly T[];
};

export type MutationTimelineMap<T extends MutationSpan = Node> = ReadonlyMap<
  string,
  MutationTimeline<T>
>;

export type MutationTimelineLookup<T extends MutationSpan = Node> = Pick<
  MutationTimelineMap<T>,
  'get' | 'size'
>;

export type Scope = {
  bindings: Map<string, Binding>;
  deferredFunctionNode?: Node;
  depth: number;
  end: number;
  functionBoundary: boolean;
  params: Set<string>;
  parent: Scope | null;
  root: boolean;
  start: number;
};

export type ReferenceIdentifier = {
  end: number;
  name: string;
  start: number;
};

export type ResolvedReference = Readonly<
  ReferenceIdentifier & { binding: Binding | null }
>;

export type OxcStaticImportReference = {
  imported: 'default' | string;
  importLocal?: string;
  local: string;
  source: string;
};

export type OxcStaticValue = {
  name: string;
  value: unknown;
};

export type OxcStaticValueCandidate = {
  imports: OxcStaticImportReference[];
  inlineConstants?: Record<string, unknown>;
  mutationGuards?: StaticLocalExpression[];
  name: string;
  source: string;
};

export type OxcPureCallHint = {
  /** The hint is useful even when no candidate guard reached the resolver. */
  actionableWithoutRejection?: boolean;
  callEnd: number;
  callColumn: number;
  callFilename: string;
  callLine: number;
  callSource: string;
  callStart: number;
  expressionName: string;
  expressionSource: string;
};

export type TemplateExtractionResult = {
  code: string;
  dependencyNames: string[];
  expressionValues: Omit<ExpressionValue, 'buildCodeFrameError'>[];
  pureCallHints: OxcPureCallHint[];
  replacements: OxcEdit[];
  staticValueCandidates: OxcStaticValueCandidate[];
  staticValues: OxcStaticValue[];
};

export type StaticBindings = Record<string, Record<string, unknown>>;

export type ExtractedExpression = {
  expressionCode: string;
  hasInlinableLocalReference?: boolean;
  importedFrom: string[];
  kind: ValueType.FUNCTION | ValueType.LAZY;
  pureCallHints?: Array<
    Omit<OxcPureCallHint, 'expressionName' | 'expressionSource'>
  >;
  staticExpressionCode?: string;
  staticImports: OxcStaticImportReference[];
  staticMutationGuards: StaticLocalExpression[];
  staticValue?: unknown;
};

export type StaticLocalExpression = {
  importedFrom: string[];
  imports: OxcStaticImportReference[];
  pureCallHintSpan?: ExpressionSpan;
  source: string;
};

export type MutationHazardGuardMap = ReadonlyMap<
  string,
  ReadonlyMap<Node, readonly Expression[] | null>
>;

export type ProgramAnalysis = {
  bindingIndex: BindingIndex;
  rootMutationHazardGuardsByBinding: MutationHazardGuardMap;
  rootMutationHazardsByBinding: MutationTimelineMap;
  rootMutationsByBinding: MutationTimelineMap<
    AssignmentExpression | UpdateExpression
  >;
  targetExpressions: Expression[];
  templateLiterals: TemplateLiteral[];
  usedNames: Set<string>;
};

export type ExtractionContext = {
  bindingIndex: BindingIndex;
  code: string;
  currentInsertionPoint: number;
  currentExpressionStart: number;
  dependencyNames: Set<string>;
  expressionValues: Omit<ExpressionValue, 'buildCodeFrameError'>[];
  filename: string;
  hoistedBindingNames: Map<string, string>;
  hoistedDeclarations: Map<string, string>;
  hoistedDeclarationsByInsertionPoint: Map<number, string[]>;
  loc: LocationLookup;
  processorManagedExpressionSpans: Set<string>;
  program: Program;
  pureAnnotatedInvocationSpans: Set<string>;
  replacements: OxcEdit[];
  rootMutationHazardGuardsByBinding: MutationHazardGuardMap;
  rootMutationHazardsByBinding: MutationTimelineLookup;
  rootMutationsByBinding: MutationTimelineMap<
    AssignmentExpression | UpdateExpression
  >;
  staticBindings?: StaticBindings;
  staticImportAliases: Map<string, string>;
  staticCallProof: RecursiveProofState<Node>;
  staticValueCandidates: OxcStaticValueCandidate[];
  staticValues: OxcStaticValue[];
  usedNames: Set<string>;
};
