import { createOxcLocationLookup } from '../oxc/sourceLocations';
import * as recursiveProof from './recursiveProof';
import { collectPureAnnotatedInvocationSpans } from './pureAnnotations';
import { analyzeProgram, createSpanLookup, parseOxc } from './scopeAnalysis';
import { expressionSpanKey } from './snapshotReplay';
import { evaluateStatic } from './staticEvaluator';
import {
  toLegacyStaticValue,
  toStaticOutcome,
  unknownOutcome,
  UnknownReason,
  type StaticOutcome,
  type StaticResult,
} from './staticOutcome';
import type {
  ExpressionSpan,
  ExtractionContext,
  StaticBindings,
} from './types';

// Evaluates one expression of a source file. The `*Outcome*` functions are the
// evaluator's interface; the `*Expression*` functions keep the pre-outcome
// value contract for callers that are not migrated yet.

const evaluateOxcStaticResultAt = (
  code: string,
  filename: string,
  expressionSpan: ExpressionSpan,
  env: Map<string, unknown>,
  staticBindings: StaticBindings | undefined,
  processorManagedExpressionSpans: ExpressionSpan[]
): StaticResult => {
  const program = parseOxc(code, filename);
  const analysis = analyzeProgram(program, {
    collectTargetExpressions: true,
    expressionSpanLookup: createSpanLookup([expressionSpan]),
    mutationHazardIgnoreLookup: createSpanLookup(
      processorManagedExpressionSpans
    ),
  });
  const [expression] = analysis.targetExpressions;
  if (!expression) {
    return unknownOutcome(UnknownReason.UnsupportedSyntax);
  }

  const ctx: ExtractionContext = {
    bindingIndex: analysis.bindingIndex,
    code,
    currentInsertionPoint: 0,
    currentExpressionStart: expression.start,
    dependencyNames: new Set(),
    expressionValues: [],
    filename,
    hoistedBindingNames: new Map(),
    hoistedDeclarations: new Map(),
    hoistedDeclarationsByInsertionPoint: new Map(),
    loc: createOxcLocationLookup(code),
    processorManagedExpressionSpans: new Set(
      processorManagedExpressionSpans.map(expressionSpanKey)
    ),
    program,
    pureAnnotatedInvocationSpans: collectPureAnnotatedInvocationSpans(
      code,
      filename,
      program
    ),
    replacements: [],
    rootMutationHazardGuardsByBinding:
      analysis.rootMutationHazardGuardsByBinding,
    rootMutationHazardsByBinding: analysis.rootMutationHazardsByBinding,
    rootMutationsByBinding: analysis.rootMutationsByBinding,
    staticBindings,
    staticCallProof: recursiveProof.create(),
    staticImportAliases: new Map(),
    staticValueCandidates: [],
    staticValues: [],
    usedNames: new Set(analysis.usedNames),
  };

  return evaluateStatic(expression, ctx, new Map(env));
};

/** Pre-outcome value interface; `undefined` also stands for "unknown". */
export const evaluateOxcStaticExpressionAt = (
  code: string,
  filename: string,
  expressionSpan: ExpressionSpan,
  env: Map<string, unknown> = new Map(),
  staticBindings?: StaticBindings,
  processorManagedExpressionSpans: ExpressionSpan[] = []
): unknown | undefined =>
  toLegacyStaticValue(
    evaluateOxcStaticResultAt(
      code,
      filename,
      expressionSpan,
      env,
      staticBindings,
      processorManagedExpressionSpans
    )
  );

export const evaluateOxcStaticOutcomeAt = (
  code: string,
  filename: string,
  expressionSpan: ExpressionSpan,
  env: Map<string, unknown> = new Map(),
  staticBindings?: StaticBindings,
  processorManagedExpressionSpans: ExpressionSpan[] = []
): StaticOutcome =>
  toStaticOutcome(
    evaluateOxcStaticResultAt(
      code,
      filename,
      expressionSpan,
      env,
      staticBindings,
      processorManagedExpressionSpans
    )
  );

const evaluateOxcStaticSource = (
  source: string,
  filename: string,
  env: Map<string, unknown>,
  staticBindings: StaticBindings | undefined
): StaticResult => {
  const code = `const __wyw_static_value = ${source};`;
  const program = parseOxc(code, filename);
  const declaration = program.body[0];
  const init =
    declaration?.type === 'VariableDeclaration'
      ? declaration.declarations[0]?.init
      : null;
  if (!init) {
    return unknownOutcome(UnknownReason.UnsupportedSyntax);
  }

  return evaluateOxcStaticResultAt(
    code,
    filename,
    { end: init.end, start: init.start },
    env,
    staticBindings,
    []
  );
};

/** Pre-outcome value interface; `undefined` also stands for "unknown". */
export const evaluateOxcStaticExpression = (
  source: string,
  filename: string,
  env: Map<string, unknown> = new Map(),
  staticBindings?: StaticBindings
): unknown | undefined =>
  toLegacyStaticValue(
    evaluateOxcStaticSource(source, filename, env, staticBindings)
  );

export const evaluateOxcStaticOutcome = (
  source: string,
  filename: string,
  env: Map<string, unknown> = new Map(),
  staticBindings?: StaticBindings
): StaticOutcome =>
  toStaticOutcome(
    evaluateOxcStaticSource(source, filename, env, staticBindings)
  );
