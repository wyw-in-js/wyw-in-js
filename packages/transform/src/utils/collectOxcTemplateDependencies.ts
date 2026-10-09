export type {
  OxcStaticImportReference,
  OxcPureCallHint,
  OxcStaticValue,
  OxcStaticValueCandidate,
  StaticBindings,
} from './collectOxcTemplateDependencies/types';
export { lookupStaticBinding } from './collectOxcTemplateDependencies/staticBindings';
export { createOxcStaticCallableValue } from './collectOxcTemplateDependencies/staticEvaluator';
export {
  collectOxcExpressionDependencies,
  collectOxcTemplateDependencies,
  isOxcStaticSerializableValue,
} from './collectOxcTemplateDependencies/expressionExtraction';
export {
  evaluateOxcStaticExpression,
  evaluateOxcStaticExpressionAt,
  evaluateOxcStaticOutcome,
  evaluateOxcStaticOutcomeAt,
} from './collectOxcTemplateDependencies/staticExpressionEvaluation';
export {
  OpaqueReason,
  UnknownReason,
  type StaticOutcome,
} from './collectOxcTemplateDependencies/staticOutcome';
