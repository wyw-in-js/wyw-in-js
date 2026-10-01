/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { Expression, Node } from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import { collectOxcPatternRuntimeExpressions } from '../oxc/patterns';
import {
  isOxcFunctionLike,
  unwrapOxcRuntimeExpression,
} from '../oxc/runtimeSemantics';
import { toOxcBindingIdentity } from './bindingIdentity';
import { findResolvedReferences as getReferences } from './bindingResolution';
import {
  applyExpressionReplacements,
  collectIdentifierReferenceReplacements,
  getConstantReplacement,
} from './expressionReplacements';
import {
  getMutationTimeline,
  hasTimelineStartBefore,
  resolveBindingAt,
  toMutationBindingKey,
  unknownAliasMutationBinding,
} from './scopeAnalysis';
import {
  countPatternBindingNames,
  expressionSpanKey,
  hasAnyBindingChange,
  hasDestructuringIntrinsicMutationBefore,
  isOpaqueDestructuringHazard,
} from './snapshotReplay';
import { isKnownPureStaticCall } from './staticEvaluator';
import {
  getHazardTimelineAt,
  someHazardTimelineEndAtOrBefore,
} from './staticEvaluationSafety';
import type {
  Binding,
  ExtractionContext,
  OxcStaticImportReference,
  Replacement,
  StaticLocalExpression,
} from './types';

export {
  getHoistedBindingName,
  declarationInitCode,
  declarationPatternCode,
} from './hoistedDeclarations';

export const allocateExpressionName = (ctx: ExtractionContext): string => {
  let base = '_exp';
  let idx = 1;
  while (ctx.usedNames.has(base)) {
    idx += 1;
    base = `_exp${idx}`;
  }

  ctx.usedNames.add(base);
  return base;
};

const parenthesizeStaticReplacement = (source: string): string => `(${source})`;

export const replaceStaticLocalReferences = (
  expression: Expression,
  replacements: ReadonlyMap<string, string>,
  ctx: ExtractionContext,
  extraReplacements: Replacement[] = [],
  exactReplacements: ReadonlyMap<number, string> = new Map()
): string => {
  if (expression.type === 'Identifier' && extraReplacements.length === 0) {
    return (
      exactReplacements.get(expression.start) ??
      replacements.get(expression.name) ??
      ctx.code.slice(expression.start, expression.end)
    );
  }

  const parenthesized = new Map<string, string>();
  const parenthesizedExact = new Map<number, string>();
  replacements.forEach((value, key) => {
    parenthesized.set(key, parenthesizeStaticReplacement(value));
  });
  exactReplacements.forEach((value, key) => {
    parenthesizedExact.set(key, parenthesizeStaticReplacement(value));
  });

  return applyExpressionReplacements(
    expression,
    [
      ...extraReplacements,
      ...collectIdentifierReferenceReplacements(
        expression,
        parenthesized,
        parenthesizedExact
      ),
    ],
    ctx.code
  );
};

export const hasReferencedRootMutationBefore = (
  expression: Expression,
  referenceStart: number,
  ctx: ExtractionContext,
  ignoredReferences: ReadonlySet<string> = new Set(),
  ignoredHazard?: Node,
  guardedHazards: ReadonlySet<Node> = new Set()
): boolean =>
  getReferences(expression, ctx.bindingIndex).some(
    ({ binding: dependency, name }) => {
      if (ignoredReferences.has(name)) {
        return false;
      }

      if (!dependency) {
        return false;
      }
      const dependencyKey = toMutationBindingKey(dependency);

      return (
        hasTimelineStartBefore(
          getMutationTimeline(ctx.rootMutationsByBinding, dependencyKey),
          referenceStart
        ) ||
        someHazardTimelineEndAtOrBefore(
          getHazardTimelineAt(dependencyKey, referenceStart, ctx),
          referenceStart,
          ctx,
          (hazard) =>
            !guardedHazards.has(hazard) &&
            !isKnownPureStaticCall(hazard, ctx) &&
            (!ignoredHazard ||
              hazard.start < ignoredHazard.start ||
              ignoredHazard.end < hazard.end)
        )
      );
    }
  );

export const hasBindingMutationBefore = (
  binding: Binding,
  referenceStart: number,
  ctx: ExtractionContext
): boolean => {
  const bindingKey = toMutationBindingKey(binding);
  return (
    hasTimelineStartBefore(
      getMutationTimeline(ctx.rootMutationsByBinding, bindingKey),
      referenceStart
    ) ||
    someHazardTimelineEndAtOrBefore(
      getHazardTimelineAt(bindingKey, referenceStart, ctx),
      referenceStart,
      ctx,
      (hazard) => !isKnownPureStaticCall(hazard, ctx)
    )
  );
};

export const collectBindingMutationGuardsBefore = (
  binding: Binding,
  referenceStart: number,
  ctx: ExtractionContext,
  onOpaqueInvocation?: (
    hazard: Node,
    guards: readonly Expression[] | null
  ) => void
): readonly Expression[] | null => {
  const bindingKey = toMutationBindingKey(binding);
  if (
    hasTimelineStartBefore(
      getMutationTimeline(ctx.rootMutationsByBinding, bindingKey),
      referenceStart
    )
  ) {
    return null;
  }

  const guardedExpressions = new Set<Expression>();
  const hasUnconditionalHazard = someHazardTimelineEndAtOrBefore(
    getHazardTimelineAt(bindingKey, referenceStart, ctx),
    referenceStart,
    ctx,
    (hazard) => {
      if (isKnownPureStaticCall(hazard, ctx)) {
        return false;
      }

      const guards = ctx.rootMutationHazardGuardsByBinding
        .get(bindingKey)
        ?.get(hazard);
      if (hazard.type === 'CallExpression' || hazard.type === 'NewExpression') {
        onOpaqueInvocation?.(hazard, guards ?? null);
      }
      if (!guards || guards.length === 0) {
        return true;
      }

      guards.forEach((expression) => guardedExpressions.add(expression));
      return false;
    }
  );

  return hasUnconditionalHazard ? null : [...guardedExpressions];
};

export const hasOpaqueDestructuringHazardBefore = (
  bindingKey: string,
  referenceStart: number,
  ctx: ExtractionContext,
  guardedHazards: ReadonlySet<Node> = new Set()
): boolean =>
  someHazardTimelineEndAtOrBefore(
    getHazardTimelineAt(bindingKey, referenceStart, ctx),
    referenceStart,
    ctx,
    (hazard) =>
      !guardedHazards.has(hazard) && isOpaqueDestructuringHazard(hazard, ctx)
  );

const hasFunctionContextSyntax = (node: Node): boolean =>
  node.type === 'ThisExpression' ||
  node.type === 'Super' ||
  node.type === 'AwaitExpression' ||
  node.type === 'YieldExpression' ||
  node.type === 'MetaProperty' ||
  getOxcNodeChildren(node).some(hasFunctionContextSyntax);

export const nestedDestructuringHasCallTimeUncertainty = (
  binding: Binding,
  ctx: ExtractionContext
): boolean => {
  const { declarator } = binding;
  if (
    binding.isRoot ||
    !declarator?.init ||
    (declarator.id.type !== 'ObjectPattern' &&
      declarator.id.type !== 'ArrayPattern')
  ) {
    return false;
  }

  let functionScope = binding.scope.parent;
  while (functionScope && !functionScope.functionBoundary) {
    functionScope = functionScope.parent;
  }
  if (!functionScope) {
    return false;
  }

  if (
    hasDestructuringIntrinsicMutationBefore(
      declarator.id,
      Number.POSITIVE_INFINITY,
      ctx,
      ctx.currentExpressionStart
    )
  ) {
    return true;
  }

  const visitedBindings = new Map<Binding, Set<number>>();
  const bindingHasUncertainty = (
    candidate: Binding,
    evaluatedAt: number
  ): boolean => {
    const visitedAt = visitedBindings.get(candidate) ?? new Set<number>();
    if (visitedAt.has(evaluatedAt)) {
      return false;
    }
    visitedAt.add(evaluatedAt);
    visitedBindings.set(candidate, visitedAt);

    if (
      candidate.kind === 'param' ||
      hasBindingMutationBefore(candidate, evaluatedAt, ctx)
    ) {
      return true;
    }

    const candidateDeclarator = candidate.declarator;
    if (!candidateDeclarator) {
      return true;
    }
    if (
      evaluatedAt < candidateDeclarator.end ||
      (candidateDeclarator !== declarator &&
        candidateDeclarator.id.type !== 'Identifier')
    ) {
      return true;
    }

    const candidateExpressions = candidateDeclarator?.init
      ? [
          candidateDeclarator.init,
          ...collectOxcPatternRuntimeExpressions(candidateDeclarator.id),
        ]
      : [];

    return candidateExpressions.some((expression) => {
      if (hasFunctionContextSyntax(expression)) {
        return true;
      }

      return getReferences(expression, ctx.bindingIndex).some(
        ({ binding: dependency, name }) => {
          if (!dependency) {
            return !(
              name === 'undefined' ||
              name === 'NaN' ||
              name === 'Infinity'
            );
          }

          if (dependency.declarator === candidateDeclarator) {
            return false;
          }

          const declaredInsideFunction =
            functionScope.start <= dependency.declaredAt &&
            dependency.declaredAt < functionScope.end;
          if (declaredInsideFunction) {
            return bindingHasUncertainty(dependency, candidateDeclarator.start);
          }

          return (
            hasAnyBindingChange(dependency, ctx) ||
            (!!dependency.declaration &&
              dependency.declaration.end > ctx.currentInsertionPoint)
          );
        }
      );
    });
  };

  if (
    collectOxcPatternRuntimeExpressions(declarator.id).some(
      hasFunctionContextSyntax
    )
  ) {
    return true;
  }

  return bindingHasUncertainty(binding, ctx.currentExpressionStart);
};

export const expressionHasNestedCallTimeUncertainty = (
  expression: Expression,
  ctx: ExtractionContext
): boolean =>
  getReferences(expression, ctx.bindingIndex).some(
    ({ binding }) =>
      !!binding && nestedDestructuringHasCallTimeUncertainty(binding, ctx)
  );

function collectStaticLocalExpression(
  expression: Expression,
  ctx: ExtractionContext,
  stack: string[] = [],
  ignoredReferences: ReadonlySet<string> = new Set(),
  guardedHazards: ReadonlySet<Node> = new Set()
): StaticLocalExpression | null {
  const exactReplacements = new Map<number, string>();
  const importedFrom = new Set<string>();
  const imports: OxcStaticImportReference[] = [];

  for (const { binding, name, start } of getReferences(
    expression,
    ctx.bindingIndex
  )) {
    if (ignoredReferences.has(name)) {
      continue;
    }

    if (!binding) {
      return null;
    }

    if (binding.importedFrom) {
      importedFrom.add(binding.importedFrom);
      if (binding.imported && binding.imported !== '*') {
        imports.push({
          imported: binding.imported,
          local: binding.name,
          source: binding.importedFrom,
        });
        continue;
      }

      return null;
    }

    const replacement =
      binding.declarationKind === 'const'
        ? getConstantReplacement(binding, ctx)
        : null;
    if (replacement) {
      exactReplacements.set(start, replacement);
      continue;
    }

    // Processor-managed bindings (const x = css``) carry their value
    // (the generated className string) via inlineConstants at candidate
    // evaluation time. Walking the TaggedTemplateExpression here would
    // pull the processor's tag import (e.g. `css` from '@linaria/core')
    // into the candidate's static imports, where it fails to resolve.
    // Leave the identifier as a free reference; the candidate-side env
    // supplies the className.
    if (binding.declarator?.init?.type === 'TaggedTemplateExpression') {
      continue;
    }

    const nested = collectStaticBindingExpression(
      binding,
      start,
      ctx,
      stack,
      guardedHazards
    );
    if (!nested) {
      return null;
    }

    exactReplacements.set(start, nested.source);
    nested.importedFrom.forEach((source) => importedFrom.add(source));
    imports.push(...nested.imports);
  }

  return {
    importedFrom: [...importedFrom],
    imports,
    source:
      exactReplacements.size > 0
        ? replaceStaticLocalReferences(
            expression,
            new Map(),
            ctx,
            [],
            exactReplacements
          )
        : ctx.code.slice(expression.start, expression.end),
  };
}

const isStaticMutationGuardProjection = (node: Node): boolean => {
  const expression = unwrapOxcRuntimeExpression(node, false);
  if (expression.type === 'Identifier') {
    return true;
  }
  if (expression.type !== 'MemberExpression' || expression.optional) {
    return false;
  }

  if (!isStaticMutationGuardProjection(expression.object)) {
    return false;
  }
  if (!expression.computed) {
    return expression.property.type === 'Identifier';
  }

  return (
    expression.property.type === 'Literal' &&
    (typeof expression.property.value === 'string' ||
      typeof expression.property.value === 'number')
  );
};

const immutableGlobalPrimitives = new Set(['Infinity', 'NaN', 'undefined']);

const primitiveBinaryOperators = new Set([
  '!=',
  '!==',
  '%',
  '&',
  '*',
  '**',
  '+',
  '-',
  '/',
  '<',
  '<<',
  '<=',
  '==',
  '===',
  '>',
  '>=',
  '>>',
  '>>>',
  '^',
  '|',
]);

const collectStaticPrimitiveMutationGuardExpressions = (
  expression: Expression,
  ctx: ExtractionContext,
  guardedHazards: ReadonlySet<Node>
): StaticLocalExpression[] | null => {
  const unwrapped = unwrapOxcRuntimeExpression(expression, false);
  if (
    unwrapped.type === 'Identifier' &&
    immutableGlobalPrimitives.has(unwrapped.name) &&
    !resolveBindingAt(ctx, unwrapped.name, unwrapped.start)
  ) {
    return [];
  }

  if (isStaticMutationGuardProjection(unwrapped)) {
    const guard = collectStaticLocalExpression(
      unwrapped as Expression,
      ctx,
      [],
      new Set(),
      guardedHazards
    );
    return guard ? [guard] : null;
  }

  if (unwrapped.type === 'Literal') {
    return unwrapped.value === null || typeof unwrapped.value !== 'object'
      ? []
      : null;
  }

  if (unwrapped.type === 'UnaryExpression' && unwrapped.operator !== 'delete') {
    return collectStaticPrimitiveMutationGuardExpressions(
      unwrapped.argument as Expression,
      ctx,
      guardedHazards
    );
  }

  if (unwrapped.type === 'TemplateLiteral') {
    const guards: StaticLocalExpression[] = [];
    for (const substitution of unwrapped.expressions) {
      const substitutionGuards = collectStaticPrimitiveMutationGuardExpressions(
        substitution,
        ctx,
        guardedHazards
      );
      if (!substitutionGuards) {
        return null;
      }
      guards.push(...substitutionGuards);
    }
    return guards;
  }

  if (
    unwrapped.type === 'BinaryExpression' &&
    primitiveBinaryOperators.has(unwrapped.operator)
  ) {
    const leftGuards = collectStaticPrimitiveMutationGuardExpressions(
      unwrapped.left as Expression,
      ctx,
      guardedHazards
    );
    const rightGuards = collectStaticPrimitiveMutationGuardExpressions(
      unwrapped.right as Expression,
      ctx,
      guardedHazards
    );
    return leftGuards && rightGuards ? [...leftGuards, ...rightGuards] : null;
  }

  if (unwrapped.type === 'LogicalExpression') {
    const leftGuards = collectStaticPrimitiveMutationGuardExpressions(
      unwrapped.left,
      ctx,
      guardedHazards
    );
    const rightGuards = collectStaticPrimitiveMutationGuardExpressions(
      unwrapped.right,
      ctx,
      guardedHazards
    );
    return leftGuards && rightGuards ? [...leftGuards, ...rightGuards] : null;
  }

  if (unwrapped.type === 'ConditionalExpression') {
    const testGuards = collectStaticPrimitiveMutationGuardExpressions(
      unwrapped.test,
      ctx,
      guardedHazards
    );
    const consequentGuards = collectStaticPrimitiveMutationGuardExpressions(
      unwrapped.consequent,
      ctx,
      guardedHazards
    );
    const alternateGuards = collectStaticPrimitiveMutationGuardExpressions(
      unwrapped.alternate,
      ctx,
      guardedHazards
    );
    return testGuards && consequentGuards && alternateGuards
      ? [...testGuards, ...consequentGuards, ...alternateGuards]
      : null;
  }

  return null;
};

export const collectStaticMutationGuardExpressions = (
  expression: Expression,
  ctx: ExtractionContext,
  guardedHazards: ReadonlySet<Node> = new Set()
): StaticLocalExpression[] | null => {
  const unwrapped = unwrapOxcRuntimeExpression(expression, false);
  const primitiveGuards = collectStaticPrimitiveMutationGuardExpressions(
    unwrapped as Expression,
    ctx,
    guardedHazards
  );
  if (primitiveGuards) {
    return primitiveGuards;
  }

  // RegExp literals are fresh mutable values rather than primitives, but they
  // still carry no capability back to a source binding when copied into a
  // newly constructed argument.
  if (unwrapped.type === 'Literal') {
    return [];
  }

  // A newly constructed container does not expose its source bindings. The
  // callee can only retain or mutate the projected leaf values copied into it,
  // so validate those leaves as immutable primitives instead of rejecting the
  // entire container guard.
  if (unwrapped.type === 'ObjectExpression') {
    const guards: StaticLocalExpression[] = [];
    for (const property of unwrapped.properties) {
      if (property.type === 'SpreadElement') {
        return null;
      }

      if (property.computed) {
        const keyGuards = collectStaticPrimitiveMutationGuardExpressions(
          property.key as Expression,
          ctx,
          guardedHazards
        );
        if (!keyGuards) {
          return null;
        }
        guards.push(...keyGuards);
      }

      const valueGuards = collectStaticMutationGuardExpressions(
        property.value,
        ctx,
        guardedHazards
      );
      if (!valueGuards) {
        return null;
      }
      guards.push(...valueGuards);
    }
    return guards;
  }

  if (unwrapped.type === 'ArrayExpression') {
    const guards: StaticLocalExpression[] = [];
    for (const element of unwrapped.elements) {
      if (!element) {
        continue;
      }
      if (element.type === 'SpreadElement') {
        return null;
      }

      const elementGuards = collectStaticMutationGuardExpressions(
        element,
        ctx,
        guardedHazards
      );
      if (!elementGuards) {
        return null;
      }
      guards.push(...elementGuards);
    }
    return guards;
  }

  return null;
};

function collectStaticDestructuringProjection(
  binding: Binding,
  referenceStart: number,
  ctx: ExtractionContext,
  stack: string[],
  guardedHazards: ReadonlySet<Node>
): StaticLocalExpression | null {
  const { declarator } = binding;
  if (
    !declarator?.init ||
    (declarator.id.type !== 'ObjectPattern' &&
      declarator.id.type !== 'ArrayPattern')
  ) {
    return null;
  }

  if (
    hasDestructuringIntrinsicMutationBefore(
      declarator.id,
      declarator.start,
      ctx
    )
  ) {
    return null;
  }

  if (
    hasOpaqueDestructuringHazardBefore(
      unknownAliasMutationBinding,
      referenceStart,
      ctx,
      guardedHazards
    )
  ) {
    return null;
  }

  const bindingNames = countPatternBindingNames(declarator.id);
  if (bindingNames.get(binding.name) !== 1) {
    return null;
  }

  const bindingKey = toMutationBindingKey(binding);
  const targetMutations = getMutationTimeline(
    ctx.rootMutationsByBinding,
    bindingKey
  );
  const targetMutationHazards = getHazardTimelineAt(
    bindingKey,
    referenceStart,
    ctx
  );
  if (
    hasTimelineStartBefore(targetMutations, referenceStart) ||
    someHazardTimelineEndAtOrBefore(
      targetMutationHazards,
      referenceStart,
      ctx,
      (hazard) =>
        !guardedHazards.has(hazard) && isOpaqueDestructuringHazard(hazard, ctx)
    )
  ) {
    return null;
  }

  const snapshotCtx: ExtractionContext = {
    ...ctx,
    currentExpressionStart: declarator.start,
  };
  const initializerReferences = getReferences(
    declarator.init,
    ctx.bindingIndex
  );
  if (
    initializerReferences.some(({ binding: dependency }) => {
      return (
        dependency?.declarator === declarator ||
        (!!dependency &&
          hasOpaqueDestructuringHazardBefore(
            toMutationBindingKey(dependency),
            declarator.start,
            ctx,
            guardedHazards
          ))
      );
    })
  ) {
    return null;
  }
  const initializer = collectStaticLocalExpression(
    declarator.init,
    snapshotCtx,
    stack,
    new Set(),
    guardedHazards
  );
  if (!initializer) {
    return null;
  }

  const importedFrom = new Set(initializer.importedFrom);
  const imports = [...initializer.imports];
  const patternReplacements: Replacement[] = [];
  const localBindingNames = new Set(bindingNames.keys());
  for (const expression of collectOxcPatternRuntimeExpressions(declarator.id)) {
    if (
      hasReferencedRootMutationBefore(
        expression,
        referenceStart,
        ctx,
        localBindingNames,
        undefined,
        guardedHazards
      )
    ) {
      return null;
    }

    const resolved = collectStaticLocalExpression(
      expression,
      snapshotCtx,
      stack,
      localBindingNames,
      guardedHazards
    );
    if (!resolved) {
      return null;
    }

    resolved.importedFrom.forEach((source) => importedFrom.add(source));
    imports.push(...resolved.imports);
    patternReplacements.push({
      end: expression.end,
      start: expression.start,
      value: parenthesizeStaticReplacement(resolved.source),
    });
  }

  const patternSource = applyExpressionReplacements(
    declarator.id,
    patternReplacements,
    ctx.code
  );

  return {
    importedFrom: [...importedFrom],
    imports,
    source: `((${patternSource}) => ${binding.name})((${initializer.source}))`,
  };
}

export function collectStaticBindingExpression(
  binding: Binding,
  referenceStart: number,
  ctx: ExtractionContext,
  stack: string[] = [],
  guardedHazards: ReadonlySet<Node> = new Set()
): StaticLocalExpression | null {
  const { declarator } = binding;
  if (
    binding.kind === 'param' ||
    binding.declarationKind !== 'const' ||
    !declarator?.init ||
    referenceStart < declarator.end
  ) {
    return null;
  }

  if (
    binding.isRoot &&
    hasOpaqueDestructuringHazardBefore(
      toMutationBindingKey(binding),
      referenceStart,
      ctx,
      guardedHazards
    )
  ) {
    return null;
  }

  if (nestedDestructuringHasCallTimeUncertainty(binding, ctx)) {
    return null;
  }

  const key = toOxcBindingIdentity(binding);
  if (stack.includes(key)) {
    return null;
  }

  const nextStack = [...stack, key];
  if (isOxcFunctionLike(declarator.init)) {
    return {
      importedFrom: [],
      imports: [],
      source: ctx.code.slice(declarator.init.start, declarator.init.end),
    };
  }

  if (
    hasReferencedRootMutationBefore(
      declarator.init,
      referenceStart,
      ctx,
      new Set(countPatternBindingNames(declarator.id).keys()),
      declarator,
      guardedHazards
    )
  ) {
    return null;
  }

  if (declarator.id.type === 'Identifier') {
    return collectStaticLocalExpression(
      declarator.init,
      ctx,
      nextStack,
      new Set(),
      guardedHazards
    );
  }

  return collectStaticDestructuringProjection(
    binding,
    referenceStart,
    ctx,
    nextStack,
    guardedHazards
  );
}

export const containsProcessorManagedExpression = (
  node: Expression,
  ctx: ExtractionContext
): boolean =>
  ctx.processorManagedExpressionSpans.has(expressionSpanKey(node)) ||
  getOxcNodeChildren(node).some((child) =>
    containsProcessorManagedExpression(child as Expression, ctx)
  );
