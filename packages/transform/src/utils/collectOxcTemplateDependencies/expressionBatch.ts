import type { ExpressionValue } from '@wyw-in-js/shared';
import { ValueType } from '@wyw-in-js/shared';
import type { Expression, Program } from 'oxc-parser';
import { applyOxcReplacements } from '../oxc/replacements';
import { createOxcLocationLookup } from '../oxc/sourceLocations';
import { collectEagerIdentifierMutationTargets } from './expressionReplacements';
import { resolveBindingAt, getSourceLocation } from './scopeAnalysis';
import { addHoistedCode, expressionSpanKey } from './snapshotReplay';
import { allocateExpressionName } from './staticLocalPlanning';
import * as recursiveProof from './recursiveProof';
import { collectPureAnnotatedInvocationSpans } from './pureAnnotations';
import type {
  Binding,
  ExtractedExpression,
  ExpressionSpan,
  ExtractionContext,
  OxcPureCallHint,
  OxcStaticImportReference,
  ProgramAnalysis,
  StaticBindings,
  StaticLocalExpression,
  TemplateExtractionResult,
} from './types';

const getInsertionPoints = (
  program: Program,
  expressions: Expression[]
): number[] => {
  if (expressions.length === 0) {
    return [];
  }

  if (program.body.length === 0) {
    return expressions.map(() => 0);
  }

  const insertionPoints: number[] = [];
  let ownerIndex = 0;

  expressions.forEach((expression) => {
    const { end, start } = expression;
    while (
      ownerIndex < program.body.length - 1 &&
      program.body[ownerIndex]!.end < start
    ) {
      ownerIndex += 1;
    }

    let owner: Program['body'][number] | undefined = program.body[ownerIndex];
    if (!owner || owner.start > start || owner.end < end) {
      owner = program.body.find(
        (statement) => statement.start <= start && statement.end >= end
      );
    }

    insertionPoints.push(owner?.start ?? 0);
  });

  return insertionPoints;
};

export const createExpressionExtractor = ({
  extractExpression,
  literalExpressionValue,
  requiresSnapshotReplay,
}: {
  extractExpression: (
    expression: Expression,
    ctx: ExtractionContext,
    evaluate: boolean,
    fallbackBindings: ReadonlySet<Binding>
  ) => ExtractedExpression;
  literalExpressionValue: (
    expression: Expression,
    ctx: ExtractionContext
  ) => Omit<ExpressionValue, 'buildCodeFrameError'> | null;
  requiresSnapshotReplay: (binding: Binding, ctx: ExtractionContext) => boolean;
}) => {
  return (
    code: string,
    filename: string,
    evaluate: boolean,
    program: Program,
    analysis: Pick<
      ProgramAnalysis,
      | 'bindingIndex'
      | 'rootMutationHazardGuardsByBinding'
      | 'rootMutationHazardsByBinding'
      | 'rootMutationsByBinding'
      | 'usedNames'
    >,
    expressions: Expression[],
    staticBindings?: StaticBindings,
    processorManagedExpressionSpans: ExpressionSpan[] = [],
    allowSnapshotWriteFallback = false
  ): TemplateExtractionResult => {
    if (expressions.length === 0) {
      return {
        code,
        dependencyNames: [],
        expressionValues: [],
        pureCallHints: [],
        replacements: [],
        staticValueCandidates: [],
        staticValues: [],
      };
    }

    const insertionPoints = getInsertionPoints(program, expressions);
    const ctx: ExtractionContext = {
      bindingIndex: analysis.bindingIndex,
      code,
      currentInsertionPoint: insertionPoints[0] ?? 0,
      currentExpressionStart: expressions[0].start,
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

    const snapshotWriteFallbackBindings = new Set<Binding>();
    const pureCallHints: OxcPureCallHint[] = [];
    if (allowSnapshotWriteFallback) {
      expressions.forEach((expression, index) => {
        ctx.currentInsertionPoint = insertionPoints[index] ?? 0;
        ctx.currentExpressionStart = expression.start;
        collectEagerIdentifierMutationTargets(expression).forEach((target) => {
          const binding = resolveBindingAt(ctx, target.name, target.start);
          if (binding && requiresSnapshotReplay(binding, ctx)) {
            snapshotWriteFallbackBindings.add(binding);
          }
        });
      });
    }

    expressions.forEach((expression, index) => {
      ctx.currentInsertionPoint = insertionPoints[index] ?? 0;
      ctx.currentExpressionStart = expression.start;

      const literal = literalExpressionValue(expression, ctx);
      if (literal) {
        ctx.expressionValues.push(literal);
        return;
      }

      const {
        expressionCode,
        hasInlinableLocalReference,
        importedFrom,
        kind,
        pureCallHints: expressionPureCallHints = [],
        staticExpressionCode,
        staticImports,
        staticMutationGuards,
        staticValue,
      } = extractExpression(
        expression,
        ctx,
        evaluate,
        snapshotWriteFallbackBindings
      );
      const expName = allocateExpressionName(ctx);
      pureCallHints.push(
        ...expressionPureCallHints.map((hint) => ({
          ...hint,
          expressionName: expName,
          expressionSource: ctx.code.slice(expression.start, expression.end),
        }))
      );

      addHoistedCode(
        expName,
        `const ${expName} = () => (${expressionCode});`,
        ctx
      );
      if (staticValue !== undefined && kind !== ValueType.FUNCTION) {
        ctx.staticValues.push({
          name: expName,
          value: staticValue,
        });
      } else if (
        (staticImports.length > 0 ||
          hasInlinableLocalReference ||
          staticExpressionCode !== undefined) &&
        kind !== ValueType.FUNCTION
      ) {
        const uniqueImports = new Map<string, OxcStaticImportReference>();
        staticImports.forEach((item) => {
          uniqueImports.set(
            `${item.local}\0${item.importLocal ?? ''}\0${item.source}\0${
              item.imported
            }`,
            item
          );
        });
        const uniqueMutationGuards = new Map<string, StaticLocalExpression>();
        staticMutationGuards.forEach((guard) => {
          const hintSpan = guard.pureCallHintSpan;
          const key = hintSpan
            ? `${guard.source}\0${hintSpan.start}:${hintSpan.end}`
            : guard.source;
          uniqueMutationGuards.set(key, guard);
        });
        ctx.staticValueCandidates.push({
          imports: [...uniqueImports.values()],
          ...(uniqueMutationGuards.size > 0
            ? { mutationGuards: [...uniqueMutationGuards.values()] }
            : {}),
          name: expName,
          source: staticExpressionCode ?? expressionCode,
        });
      }
      ctx.replacements.push({
        start: expression.start,
        end: expression.end,
        value: `${expName}()`,
      });
      ctx.expressionValues.push({
        ex: {
          loc: getSourceLocation(expression.start, expression.end, ctx),
          name: expName,
          type: 'Identifier',
        },
        importedFrom,
        kind,
        source: ctx.code.slice(expression.start, expression.end),
      } as unknown as Omit<ExpressionValue, 'buildCodeFrameError'>);
    });

    ctx.hoistedDeclarationsByInsertionPoint.forEach((declarations, point) => {
      ctx.replacements.push({
        start: point,
        end: point,
        value: `${declarations.join('\n')}\n`,
      });
    });

    return {
      code: applyOxcReplacements(code, ctx.replacements),
      dependencyNames: [...ctx.dependencyNames],
      expressionValues: ctx.expressionValues,
      pureCallHints,
      replacements: ctx.replacements,
      staticValueCandidates: ctx.staticValueCandidates,
      staticValues: ctx.staticValues,
    };
  };
};
