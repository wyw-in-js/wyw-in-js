/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { ExpressionValue } from '@wyw-in-js/shared';
import { ValueType } from '@wyw-in-js/shared';
import type { Expression, Node } from 'oxc-parser';
import { createExpressionExtractor } from './expressionBatch';

import { collectOxcPatternRuntimeExpressions } from '../oxc/patterns';
import { createOxcLocationLookup } from '../oxc/sourceLocations';
import { findResolvedReferences as getReferences } from './bindingResolution';
import * as timeline from './mutationTimeline';
import {
  analyzeProgram,
  containsTaggedTemplateExpression,
  createSpanLookup,
  getSourceLocation,
  isBindingDeclaredWithin,
  parseOxc,
  resolveBindingAt,
  toMutationBindingKey,
  unknownAliasMutationBinding,
} from './scopeAnalysis';
import {
  applyExpressionReplacements,
  collectEagerIdentifierMutationTargets,
  collectEagerNodeStarts,
  collectIdentifierMutationTargets,
  collectStaticNamespaceMemberReferences,
  getConstantReplacement,
  replaceIdentifierReferences,
} from './expressionReplacements';
import { evaluateStatic } from './staticEvaluator';
import {
  cloneStaticValue,
  isStaticSerializableValue,
  literalCode,
} from './staticValues';
import { memoizeBindingFact, toOxcBindingIdentity } from './bindingIdentity';
import {
  addHoistedCode,
  addHoistedSnapshotReplay,
  countPatternBindingNames,
  expressionSpanKey,
  hasDestructuringIntrinsicMutationBefore,
  OxcSnapshotWriteUnsupportedError,
  snapshotReplayError,
} from './snapshotReplay';
import {
  collectBindingMutationGuardsBefore,
  collectStaticBindingExpression,
  collectStaticMutationGuardExpressions,
  containsProcessorManagedExpression,
  declarationInitCode,
  declarationPatternCode,
  expressionHasNestedCallTimeUncertainty,
  getHoistedBindingName,
  hasOpaqueDestructuringHazardBefore,
  hasReferencedRootMutationBefore,
  nestedDestructuringHasCallTimeUncertainty,
  replaceStaticLocalReferences,
} from './staticLocalPlanning';
import { inferSnapshotExpressionKind } from './snapshotValueAnalysis';
import * as recursiveProof from './recursiveProof';
import { collectPureAnnotatedInvocationSpans } from './pureAnnotations';
import type {
  Binding,
  ExtractedExpression,
  ExpressionSpan,
  ExtractionContext,
  OxcPureCallHint,
  OxcStaticImportReference,
  StaticBindings,
  StaticLocalExpression,
  TemplateExtractionResult,
} from './types';

export { OxcSnapshotWriteUnsupportedError };

const declarationCode = (binding: Binding, ctx: ExtractionContext): string => {
  const { declarator } = binding;
  if (!declarator) {
    return '';
  }

  const { id } = declarator;
  if (id.type !== 'Identifier') {
    const idCode = declarationPatternCode(binding, ctx);
    if (!declarator.init) {
      return `let ${idCode};`;
    }

    return `let ${idCode} = ${declarationInitCode(declarator.init, ctx)};`;
  }

  const hoistedName = getHoistedBindingName(binding, ctx);
  if (!declarator.init) {
    return `let ${hoistedName};`;
  }

  return `let ${hoistedName} = ${declarationInitCode(declarator.init, ctx)};`;
};

const dependsOnLocalDestructuring = (
  binding: Binding,
  ctx: ExtractionContext,
  visited = new Set<string>()
): boolean => {
  const { declarator } = binding;
  if (!declarator || binding.importedFrom || binding.isRoot) {
    return false;
  }

  const bindingKey = toOxcBindingIdentity(binding);
  if (visited.has(bindingKey)) {
    return false;
  }
  visited.add(bindingKey);

  if (
    declarator.id.type === 'ObjectPattern' ||
    declarator.id.type === 'ArrayPattern'
  ) {
    return true;
  }

  if (!declarator.init) {
    return false;
  }

  return getReferences(declarator.init, ctx.bindingIndex).some(
    ({ binding: dependency }) => {
      return (
        !!dependency &&
        dependency.declarator !== declarator &&
        dependsOnLocalDestructuring(dependency, ctx, visited)
      );
    }
  );
};

const requiresSnapshotReplay = (
  binding: Binding,
  ctx: ExtractionContext
): boolean => {
  const { declarator } = binding;
  if (!declarator || binding.importedFrom || binding.isRoot) {
    return false;
  }

  // A destructuring declaration can execute user code or throw even when its
  // initializer looks static (nullish object patterns, custom iterators,
  // getters, defaults, and computed keys). Keep it, and aliases derived from
  // it, dormant until the original local expression is reached.
  if (dependsOnLocalDestructuring(binding, ctx)) {
    return true;
  }

  if (nestedDestructuringHasCallTimeUncertainty(binding, ctx)) {
    return true;
  }

  const bindingKey = toMutationBindingKey(binding);
  if (
    timeline.hasTimelineStartBefore(
      timeline.getMutationTimeline(ctx.rootMutationsByBinding, bindingKey),
      ctx.currentExpressionStart
    ) ||
    hasOpaqueDestructuringHazardBefore(
      bindingKey,
      ctx.currentExpressionStart,
      ctx
    )
  ) {
    return true;
  }

  if (!declarator.init) {
    return false;
  }

  const localBindingNames = new Set(
    countPatternBindingNames(declarator.id).keys()
  );
  if (
    hasReferencedRootMutationBefore(
      declarator.init,
      ctx.currentExpressionStart,
      ctx,
      localBindingNames,
      declarator
    )
  ) {
    return true;
  }

  if (
    declarator.id.type !== 'ObjectPattern' &&
    declarator.id.type !== 'ArrayPattern'
  ) {
    return false;
  }

  return (
    hasDestructuringIntrinsicMutationBefore(
      declarator.id,
      declarator.start,
      ctx
    ) ||
    hasOpaqueDestructuringHazardBefore(
      unknownAliasMutationBinding,
      ctx.currentExpressionStart,
      ctx
    ) ||
    getReferences(declarator.init, ctx.bindingIndex).some(
      ({ binding: dependency }) => {
        return (
          !!dependency &&
          hasOpaqueDestructuringHazardBefore(
            toMutationBindingKey(dependency),
            declarator.start,
            ctx
          )
        );
      }
    )
  );
};

const assertHoistable = (
  binding: Binding,
  ctx: ExtractionContext,
  stack: string[] = []
): void => {
  if (!binding.declarator?.init || binding.importedFrom || binding.isRoot) {
    return;
  }

  const bindingKey = toOxcBindingIdentity(binding);
  if (stack.includes(bindingKey)) {
    return;
  }

  const hoistSources = [
    binding.declarator.init,
    ...collectOxcPatternRuntimeExpressions(binding.declarator.id),
  ];
  hoistSources.forEach((source) => {
    getReferences(source, ctx.bindingIndex).forEach(
      ({ binding: nextBinding }) => {
        if (!nextBinding || nextBinding.declarator === binding.declarator) {
          return;
        }

        if (nextBinding.kind === 'param') {
          throw new Error(
            `This identifier cannot be used in the template, because it is a function parameter.`
          );
        }

        assertHoistable(nextBinding, ctx, [...stack, bindingKey]);
      }
    );
  });
};

const addHoistedDeclaration = (
  binding: Binding,
  ctx: ExtractionContext,
  stack: string[] = []
): void => {
  const bindingKey = toOxcBindingIdentity(binding);
  if (
    !binding.declaration ||
    !binding.declarator ||
    binding.importedFrom ||
    binding.isRoot ||
    stack.includes(bindingKey)
  ) {
    return;
  }

  const hoistSources = [
    ...(binding.declarator.init ? [binding.declarator.init] : []),
    ...collectOxcPatternRuntimeExpressions(binding.declarator.id),
  ];
  hoistSources.forEach((source) => {
    getReferences(source, ctx.bindingIndex).forEach(
      ({ binding: dependency }) => {
        if (dependency && dependency.declarator !== binding.declarator) {
          addHoistedDeclaration(dependency, ctx, [...stack, bindingKey]);
        }
      }
    );
  });

  if (!ctx.hoistedDeclarations.has(bindingKey)) {
    addHoistedCode(bindingKey, declarationCode(binding, ctx), ctx);
  }
};

const literalExpressionValue = (
  expression: Expression,
  ctx: ExtractionContext
): Omit<ExpressionValue, 'buildCodeFrameError'> | null => {
  if (expression.type !== 'Literal') {
    return null;
  }

  if (
    expression.value !== null &&
    typeof expression.value !== 'string' &&
    typeof expression.value !== 'number' &&
    typeof expression.value !== 'boolean'
  ) {
    return null;
  }

  let type:
    | 'BooleanLiteral'
    | 'NullLiteral'
    | 'NumericLiteral'
    | 'StringLiteral';
  if (expression.value === null) {
    type = 'NullLiteral';
  } else if (typeof expression.value === 'string') {
    type = 'StringLiteral';
  } else if (typeof expression.value === 'number') {
    type = 'NumericLiteral';
  } else {
    type = 'BooleanLiteral';
  }

  const loc = getSourceLocation(expression.start, expression.end, ctx);
  const ex =
    expression.value === null
      ? { loc, type }
      : {
          loc,
          type,
          value: expression.value,
        };

  return {
    ex,
    kind: ValueType.CONST,
    source: ctx.code.slice(expression.start, expression.end),
    value: expression.value,
  } as unknown as Omit<ExpressionValue, 'buildCodeFrameError'>;
};

const extractExpression = (
  expression: Expression,
  ctx: ExtractionContext,
  evaluate: boolean,
  snapshotWriteFallbackBindings: ReadonlySet<Binding>
): ExtractedExpression => {
  const source = ctx.code.slice(expression.start, expression.end);
  const expressionReferences = getReferences(expression, ctx.bindingIndex);
  const requiresSnapshotReplayForExpression = memoizeBindingFact((binding) =>
    requiresSnapshotReplay(binding, ctx)
  );
  const eagerNodeStarts = collectEagerNodeStarts(expression);
  const eagerMutationTargetStarts = new Set(
    collectEagerIdentifierMutationTargets(expression).map(
      (target) => target.start
    )
  );
  const snapshotMutationTargets = collectIdentifierMutationTargets(
    expression
  ).filter((target) => {
    const binding = resolveBindingAt(ctx, target.name, target.start);
    return !!binding && requiresSnapshotReplayForExpression(binding);
  });
  if (
    snapshotMutationTargets.some(
      (target) => !eagerMutationTargetStarts.has(target.start)
    )
  ) {
    throw snapshotReplayError();
  }
  if (
    expressionReferences.some(({ binding, start }) => {
      if (eagerNodeStarts.has(start)) {
        return false;
      }

      return !!binding && snapshotWriteFallbackBindings.has(binding);
    })
  ) {
    throw snapshotReplayError();
  }
  if (
    snapshotMutationTargets.some((target) => {
      const binding = resolveBindingAt(ctx, target.name, target.start);
      return !!binding && !snapshotWriteFallbackBindings.has(binding);
    })
  ) {
    throw new OxcSnapshotWriteUnsupportedError();
  }

  const snapshotBindings = expressionReferences.flatMap(({ binding }) => {
    return binding &&
      requiresSnapshotReplayForExpression(binding) &&
      !snapshotWriteFallbackBindings.has(binding)
      ? [binding]
      : [];
  });
  if (snapshotBindings.length > 0) {
    const snapshotKind = inferSnapshotExpressionKind(expression, ctx);
    if (snapshotKind === 'identity' || snapshotKind === 'unknown') {
      throw snapshotReplayError();
    }
  }

  const identityReferencesAreRootVisible =
    expressionReferences.length > 0 &&
    expressionReferences.every(({ binding }) => {
      return !binding || !!binding.importedFrom || binding.isRoot;
    });
  let preserveRuntimeIdentity = false;
  let preservedStaticValue: unknown;
  // Only inline function expressions are function-valued here. A bare
  // identifier that points to a local function may be a styled runtime
  // component, so it has to stay as a lazy `_exp()` reference.
  const isFunction =
    expression.type === 'FunctionExpression' ||
    expression.type === 'ArrowFunctionExpression';

  if (evaluate && !expressionHasNestedCallTimeUncertainty(expression, ctx)) {
    const evaluated = evaluateStatic(expression, ctx);
    const literal = literalCode(evaluated);
    preserveRuntimeIdentity =
      evaluated !== null &&
      ((typeof evaluated === 'object' && evaluated !== null) ||
        typeof evaluated === 'function') &&
      identityReferencesAreRootVisible;
    if (preserveRuntimeIdentity && isStaticSerializableValue(evaluated)) {
      preservedStaticValue = cloneStaticValue(evaluated);
    }
    if (literal && !preserveRuntimeIdentity) {
      expressionReferences.forEach(({ name }) => ctx.dependencyNames.add(name));
      return {
        expressionCode: literal,
        importedFrom: [],
        kind: isFunction ? ValueType.FUNCTION : ValueType.LAZY,
        staticImports: [],
        staticMutationGuards: [],
        staticValue: isStaticSerializableValue(evaluated)
          ? cloneStaticValue(evaluated)
          : undefined,
      };
    }
  }

  const identifierReplacements = new Map<number, string>();
  const importedFrom: string[] = [];
  const namespaceStatic = collectStaticNamespaceMemberReferences(
    expression,
    ctx
  );
  const staticIdentifierReplacements = new Map<number, string>();
  const staticImports: OxcStaticImportReference[] = [
    ...namespaceStatic.imports,
  ];
  const staticMutationGuards: StaticLocalExpression[] = [];
  const pureCallHints = new Map<
    string,
    Omit<OxcPureCallHint, 'expressionName' | 'expressionSource'>
  >();
  const localPureCallHints = new Map<
    string,
    {
      guarded: boolean;
      hint: Omit<OxcPureCallHint, 'expressionName' | 'expressionSource'>;
    }
  >();
  const pureCallHintSpansByMutationGuard = new WeakMap<
    Expression,
    ExpressionSpan
  >();
  const collectMutationGuards = (
    binding: Binding,
    referenceStart: number,
    guardedHazards?: Set<Node>
  ): readonly Expression[] | null =>
    collectBindingMutationGuardsBefore(
      binding,
      referenceStart,
      ctx,
      (hazard, guards) => {
        const key = `${hazard.start}:${hazard.end}`;
        const location = ctx.loc(hazard.start);
        const hint =
          pureCallHints.get(key) ??
          ({
            callColumn: location.column,
            callEnd: hazard.end,
            callFilename: ctx.filename,
            callLine: location.line,
            callSource: ctx.code.slice(hazard.start, hazard.end),
            callStart: hazard.start,
          } satisfies Omit<
            OxcPureCallHint,
            'expressionName' | 'expressionSource'
          >);
        const guarded = !!guards && guards.length > 0;
        if (guarded) {
          guardedHazards?.add(hazard);
        }
        if (!guarded && binding.importedFrom) {
          hint.actionableWithoutRejection = true;
        }
        pureCallHints.set(key, hint);
        if (!binding.importedFrom) {
          const existing = localPureCallHints.get(key);
          localPureCallHints.set(key, {
            guarded: existing ? existing.guarded && guarded : guarded,
            hint,
          });
        }
        guards?.forEach((guard) => {
          pureCallHintSpansByMutationGuard.set(guard, {
            end: hazard.end,
            start: hazard.start,
          });
        });
      }
    );
  const resolveMutationGuards = (
    mutationGuardExpressions: readonly Expression[],
    guardedHazards: ReadonlySet<Node> = new Set()
  ): StaticLocalExpression[] | null => {
    const resolved: StaticLocalExpression[] = [];
    for (const guardExpression of mutationGuardExpressions) {
      const guards = collectStaticMutationGuardExpressions(
        guardExpression,
        ctx,
        guardedHazards
      );
      if (!guards) {
        return null;
      }
      const pureCallHintSpan =
        pureCallHintSpansByMutationGuard.get(guardExpression);
      resolved.push(
        ...guards.map((guard) =>
          pureCallHintSpan ? { ...guard, pureCallHintSpan } : guard
        )
      );
    }

    return resolved;
  };
  let hasNonStaticLocalReference = preserveRuntimeIdentity;
  let hasInlinableLocalReference = false;
  let hasSnapshotReplay = preserveRuntimeIdentity;

  expressionReferences.forEach(({ binding, name, start }) => {
    if (!binding) {
      return;
    }

    if (isFunction && isBindingDeclaredWithin(binding, expression)) {
      return;
    }

    if (binding.kind === 'param') {
      throw new Error(
        `This identifier cannot be used in the template, because it is a function parameter.`
      );
    }

    const isIterationBinding = binding.isIteration === true;
    const isDynamicScopedBinding =
      !binding.isRoot &&
      !binding.importedFrom &&
      !binding.declarator &&
      !binding.functionNode;
    if (isIterationBinding || isDynamicScopedBinding) {
      throw snapshotReplayError();
    }

    ctx.dependencyNames.add(name);

    if (binding.importedFrom) {
      importedFrom.push(binding.importedFrom);
      const mutationGuardExpressions = collectMutationGuards(binding, start);
      if (mutationGuardExpressions === null) {
        hasNonStaticLocalReference = true;
        return;
      }
      const resolvedMutationGuards = resolveMutationGuards(
        mutationGuardExpressions
      );
      if (!resolvedMutationGuards) {
        hasNonStaticLocalReference = true;
        return;
      }
      staticMutationGuards.push(...resolvedMutationGuards);

      if (binding.imported && binding.imported !== '*') {
        staticImports.push({
          imported: binding.imported,
          local: binding.name,
          source: binding.importedFrom,
        });
      } else if (
        binding.imported === '*' &&
        namespaceStatic.coveredReferenceStarts.has(start)
      ) {
        // The static candidate source gets a synthetic named import alias,
        // while the eval fallback keeps the original namespace expression.
      } else {
        hasNonStaticLocalReference = true;
      }
      return;
    }

    if (preserveRuntimeIdentity && binding.isRoot) {
      hasNonStaticLocalReference = true;
      return;
    }

    const replacement =
      binding.declarationKind === 'const'
        ? getConstantReplacement(binding, ctx)
        : null;
    if (evaluate && replacement) {
      identifierReplacements.set(start, replacement);
      return;
    }

    const guardedHazards = new Set<Node>();
    const localMutationGuardExpressions = collectMutationGuards(
      binding,
      start,
      guardedHazards
    );

    const init = binding.declarator?.init;
    // Processor-managed bindings (`const x = css```, or object literals
    // containing processor tags) carry values that only become known after
    // processors run. Leave the identifier free in the candidate source so
    // the resolver can supply it via inlineConstants at evaluation time.
    const isProcessorManagedLocal =
      !!evaluate &&
      !!init &&
      (containsTaggedTemplateExpression(init) ||
        containsProcessorManagedExpression(init, ctx));
    const staticLocalExpression =
      evaluate &&
      init &&
      !isProcessorManagedLocal &&
      localMutationGuardExpressions !== null
        ? collectStaticBindingExpression(
            binding,
            start,
            ctx,
            [],
            guardedHazards
          )
        : null;
    const localStaticMutationGuards = localMutationGuardExpressions
      ? resolveMutationGuards(localMutationGuardExpressions, guardedHazards)
      : null;
    if (staticLocalExpression && localStaticMutationGuards) {
      staticIdentifierReplacements.set(start, staticLocalExpression.source);
      importedFrom.push(...staticLocalExpression.importedFrom);
      staticImports.push(...staticLocalExpression.imports);
      staticMutationGuards.push(...localStaticMutationGuards);
    } else if (isProcessorManagedLocal) {
      hasInlinableLocalReference = true;
    } else {
      hasNonStaticLocalReference = true;
    }

    if (!isProcessorManagedLocal) {
      if (
        requiresSnapshotReplayForExpression(binding) &&
        !snapshotWriteFallbackBindings.has(binding)
      ) {
        if (!staticLocalExpression) {
          hasSnapshotReplay = true;
          hasNonStaticLocalReference = true;
        }
        identifierReplacements.set(
          start,
          addHoistedSnapshotReplay(binding, ctx)
        );
      } else {
        assertHoistable(binding, ctx);
        addHoistedDeclaration(binding, ctx);
        if (!binding.isRoot && binding.declarator) {
          identifierReplacements.set(
            start,
            getHoistedBindingName(binding, ctx)
          );
        }
      }
    }
  });

  // Merge literal-const inlines (e.g. `const A = 32` -> "32") with
  // local-to-imported substitutions (e.g. `const X = imp.y` -> "imp.y").
  // Both must reach the candidate source so the resolver's evaluator
  // can fold every Identifier in the expression; env only carries
  // imported bindings, never same-file locals.
  const mergedReplacements = new Map(staticIdentifierReplacements);
  identifierReplacements.forEach((value, key) => {
    if (!mergedReplacements.has(key)) {
      mergedReplacements.set(key, value);
    }
  });

  let staticExpressionCode: string | undefined;
  if (!hasSnapshotReplay && mergedReplacements.size > 0) {
    staticExpressionCode = replaceStaticLocalReferences(
      expression,
      new Map(),
      ctx,
      namespaceStatic.replacements,
      mergedReplacements
    );
  } else if (!hasSnapshotReplay && namespaceStatic.replacements.length > 0) {
    staticExpressionCode = applyExpressionReplacements(
      expression,
      namespaceStatic.replacements,
      ctx.code
    );
  }

  const hasStaticCandidatePlan =
    !isFunction &&
    !hasNonStaticLocalReference &&
    (staticImports.length > 0 ||
      hasInlinableLocalReference ||
      staticExpressionCode !== undefined);
  if (evaluate && !hasStaticCandidatePlan && localPureCallHints.size > 0) {
    const localHints = [...localPureCallHints.values()];
    const unconditionalHints = localHints.filter((item) => !item.guarded);
    const hintsToProbe =
      unconditionalHints.length > 0 ? unconditionalHints : localHints;
    const pureAnnotatedInvocationSpans = new Set(
      ctx.pureAnnotatedInvocationSpans
    );
    hintsToProbe.forEach(({ hint }) => {
      pureAnnotatedInvocationSpans.add(`${hint.callStart}:${hint.callEnd}`);
    });
    const probeCtx: ExtractionContext = {
      ...ctx,
      pureAnnotatedInvocationSpans,
      staticCallProof: recursiveProof.create(),
    };
    if (
      !expressionHasNestedCallTimeUncertainty(expression, probeCtx) &&
      literalCode(evaluateStatic(expression, probeCtx)) !== null
    ) {
      for (const item of hintsToProbe) {
        const { hint } = item;
        hint.actionableWithoutRejection = true;
      }
    }
  }

  return {
    expressionCode:
      identifierReplacements.size > 0
        ? replaceIdentifierReferences(
            expression,
            new Map(),
            ctx.code,
            identifierReplacements
          )
        : source,
    importedFrom,
    kind: isFunction ? ValueType.FUNCTION : ValueType.LAZY,
    pureCallHints: [...pureCallHints.values()],
    staticExpressionCode,
    hasInlinableLocalReference:
      !hasNonStaticLocalReference && hasInlinableLocalReference,
    staticImports: hasNonStaticLocalReference ? [] : staticImports,
    staticMutationGuards: hasNonStaticLocalReference
      ? []
      : staticMutationGuards,
    staticValue: preservedStaticValue,
  };
};

const extractExpressions = createExpressionExtractor({
  extractExpression,
  literalExpressionValue,
  requiresSnapshotReplay,
});

export const isOxcStaticSerializableValue = (value: unknown): boolean =>
  isStaticSerializableValue(value);
export const evaluateOxcStaticExpressionAt = (
  code: string,
  filename: string,
  expressionSpan: ExpressionSpan,
  env: Map<string, unknown> = new Map(),
  staticBindings?: StaticBindings,
  processorManagedExpressionSpans: ExpressionSpan[] = []
): unknown | undefined => {
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
    return undefined;
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

export const evaluateOxcStaticExpression = (
  source: string,
  filename: string,
  env: Map<string, unknown> = new Map(),
  staticBindings?: StaticBindings
): unknown | undefined => {
  const code = `const __wyw_static_value = ${source};`;
  const program = parseOxc(code, filename);
  const declaration = program.body[0];
  if (declaration?.type !== 'VariableDeclaration') {
    return undefined;
  }

  const [declarator] = declaration.declarations;
  if (!declarator?.init) {
    return undefined;
  }

  return evaluateOxcStaticExpressionAt(
    code,
    filename,
    {
      end: declarator.init.end,
      start: declarator.init.start,
    },
    env,
    staticBindings
  );
};

export const collectOxcExpressionDependencies = (
  code: string,
  filename: string,
  evaluate = false,
  targetExpressionSpans?: ExpressionSpan[],
  staticBindings?: StaticBindings,
  processorManagedExpressionSpans: ExpressionSpan[] = [],
  removedExpressionSpans: ExpressionSpan[] = []
): TemplateExtractionResult => {
  const program = parseOxc(code, filename);
  const analysis = analyzeProgram(program, {
    collectTargetExpressions: true,
    expressionSpanLookup: createSpanLookup(targetExpressionSpans),
    mutationHazardIgnoreLookup: createSpanLookup(
      processorManagedExpressionSpans
    ),
    mutationHazardIgnoreTreeLookup: createSpanLookup(removedExpressionSpans),
  });

  return extractExpressions(
    code,
    filename,
    evaluate,
    program,
    analysis,
    analysis.targetExpressions,
    staticBindings,
    processorManagedExpressionSpans
  );
};

export const collectOxcExpressionDependenciesForEvalFallback = (
  code: string,
  filename: string,
  targetExpressionSpans?: ExpressionSpan[],
  processorManagedExpressionSpans: ExpressionSpan[] = [],
  removedExpressionSpans: ExpressionSpan[] = []
): TemplateExtractionResult => {
  const program = parseOxc(code, filename);
  const analysis = analyzeProgram(program, {
    collectTargetExpressions: true,
    expressionSpanLookup: createSpanLookup(targetExpressionSpans),
    mutationHazardIgnoreLookup: createSpanLookup(
      processorManagedExpressionSpans
    ),
    mutationHazardIgnoreTreeLookup: createSpanLookup(removedExpressionSpans),
  });
  const extracted = extractExpressions(
    code,
    filename,
    false,
    program,
    analysis,
    analysis.targetExpressions,
    undefined,
    processorManagedExpressionSpans,
    true
  );

  return {
    ...extracted,
    staticValueCandidates: [],
    staticValues: [],
  };
};

export const collectOxcTemplateDependencies = (
  code: string,
  filename: string,
  evaluate = false,
  targetTemplateSpans?: ExpressionSpan[]
): TemplateExtractionResult => {
  const program = parseOxc(code, filename);
  const analysis = analyzeProgram(program, {
    collectTemplateLiterals: true,
    templateSpanLookup: createSpanLookup(targetTemplateSpans),
  });
  const expressions = analysis.templateLiterals.flatMap(
    (template) => template.expressions
  );

  return extractExpressions(
    code,
    filename,
    evaluate,
    program,
    analysis,
    expressions
  );
};
