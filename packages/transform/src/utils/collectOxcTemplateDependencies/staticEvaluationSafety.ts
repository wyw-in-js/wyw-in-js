/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type {
  Expression,
  MemberExpression,
  Node,
  VariableDeclarator,
} from 'oxc-parser';

import {
  appendOxcAssignmentTargetLeaves,
  type OxcAssignmentTargetLeaf,
} from '../oxc/assignmentTargets';
import { getOxcNodeChildren } from '../oxc/ast';
import {
  collectOxcPatternBindingNames,
  someOxcPatternNode,
} from '../oxc/patterns';
import { getOxcSyntacticPropertyKey } from '../oxc/projections';
import { findResolvedReferences as getReferences } from './bindingResolution';
import {
  getExecutionVisibleMutationTimeline,
  someExecutionAncestorEffect,
} from './mutationExecution';
import {
  getMutationTimeline,
  someTimelineEndAtOrBefore,
  someTimelineStartBefore,
  unknownAliasMutationBinding,
  resolveBindingAt,
  toMutationBindingKey,
} from './scopeAnalysis';
import { isFallbackUndefinedRead, type StaticResult } from './staticOutcome';
import type {
  Binding,
  ExtractionContext,
  MutationTimeline,
  OxcFunctionLikeNode,
} from './types';

const symbolIteratorPathPart = '\0wyw-static-Symbol.iterator';

type StaticMemberPath = {
  parts: Array<string | number>;
  root: string;
};

const getUnshadowedStaticMemberPath = (
  node: Node,
  ctx: ExtractionContext,
  seenBindings = new Set<Binding>()
): StaticMemberPath | null => {
  if (node.type === 'Identifier') {
    const binding = resolveBindingAt(ctx, node.name, node.start);
    if (!binding) {
      return { parts: [], root: node.name };
    }

    if (
      binding.declarationKind !== 'const' ||
      !binding.declarator?.init ||
      binding.declarator.id.type !== 'Identifier' ||
      binding.declarator.end > node.start ||
      seenBindings.has(binding)
    ) {
      return null;
    }

    const nextSeenBindings = new Set(seenBindings);
    nextSeenBindings.add(binding);
    return getUnshadowedStaticMemberPath(
      binding.declarator.init,
      ctx,
      nextSeenBindings
    );
  }

  if (node.type !== 'MemberExpression') {
    return null;
  }

  const parent = getUnshadowedStaticMemberPath(node.object, ctx, seenBindings);
  if (!parent) {
    return null;
  }

  let key = getOxcSyntacticPropertyKey(node.property, node.computed);
  if (key === null && node.computed) {
    const propertyPath = getUnshadowedStaticMemberPath(
      node.property,
      ctx,
      seenBindings
    );
    if (
      propertyPath?.root === 'Symbol' &&
      propertyPath.parts.length === 1 &&
      propertyPath.parts[0] === 'iterator'
    ) {
      key = symbolIteratorPathPart;
    }
  }

  return key === null
    ? null
    : {
        parts: [...parent.parts, key],
        root: parent.root,
      };
};

const nodeContainsStaticMemberPath = (
  node: Node,
  root: string,
  prefix: ReadonlyArray<string | number>,
  ctx: ExtractionContext
): boolean => {
  const path = getUnshadowedStaticMemberPath(node, ctx);
  if (
    path?.root === root &&
    prefix.every((part, index) => path.parts[index] === part)
  ) {
    return true;
  }

  return getOxcNodeChildren(node).some((child) =>
    nodeContainsStaticMemberPath(child, root, prefix, ctx)
  );
};

const someIntrinsicChangeEndAtOrBefore = (
  binding: 'Array' | 'Object' | 'String',
  end: number,
  ctx: ExtractionContext,
  predicate: (change: Node) => boolean
): boolean =>
  someTimelineEndAtOrBefore(
    getMutationTimeline(ctx.rootMutationsByBinding, binding),
    end,
    predicate
  ) ||
  someHazardTimelineEndAtOrBefore(
    getHazardTimelineAt(binding, end, ctx),
    end,
    ctx,
    predicate
  );

export const hasRelevantIntrinsicMutationBefore = (
  pattern: Node,
  end: number,
  ctx: ExtractionContext
): boolean => {
  const unknownAliasChangesBefore = someHazardTimelineEndAtOrBefore(
    getHazardTimelineAt(unknownAliasMutationBinding, end, ctx),
    end,
    ctx,
    () => true
  );

  if (
    someOxcPatternNode(pattern, (node) => node.type === 'ObjectPattern') &&
    (unknownAliasChangesBefore ||
      someIntrinsicChangeEndAtOrBefore(
        'Object',
        end,
        ctx,
        (change) =>
          !nodeContainsStaticMemberPath(change, 'Object', [], ctx) ||
          nodeContainsStaticMemberPath(change, 'Object', ['prototype'], ctx)
      ))
  ) {
    return true;
  }

  return (
    someOxcPatternNode(pattern, (node) => node.type === 'ArrayPattern') &&
    hasArrayIterationMutationBefore(end, ctx)
  );
};

export const hasArrayIterationMutationBefore = (
  end: number,
  ctx: ExtractionContext
): boolean =>
  someHazardTimelineEndAtOrBefore(
    getHazardTimelineAt(unknownAliasMutationBinding, end, ctx),
    end,
    ctx,
    () => true
  ) ||
  someIntrinsicChangeEndAtOrBefore(
    'Object',
    end,
    ctx,
    (change) =>
      !nodeContainsStaticMemberPath(change, 'Object', [], ctx) ||
      nodeContainsStaticMemberPath(change, 'Object', ['prototype'], ctx)
  ) ||
  someIntrinsicChangeEndAtOrBefore(
    'Array',
    end,
    ctx,
    (change) =>
      !nodeContainsStaticMemberPath(change, 'Array', [], ctx) ||
      nodeContainsStaticMemberPath(change, 'Array', ['prototype'], ctx)
  );

export const hasStringPrototypeMutationBefore = (
  end: number,
  ctx: ExtractionContext
): boolean =>
  someIntrinsicChangeEndAtOrBefore(
    'String',
    end,
    ctx,
    (change) =>
      !nodeContainsStaticMemberPath(change, 'String', [], ctx) ||
      nodeContainsStaticMemberPath(change, 'String', ['prototype'], ctx)
  );

export const getBindingDirectTimeline = (
  binding: Binding,
  ctx: ExtractionContext
) =>
  getMutationTimeline(
    ctx.rootMutationsByBinding,
    toMutationBindingKey(binding)
  );

export const getHazardTimelineAt = (
  binding: string,
  targetStart: number,
  ctx: ExtractionContext
): MutationTimeline<Node> =>
  getExecutionVisibleMutationTimeline(
    ctx.bindingIndex,
    getMutationTimeline(ctx.rootMutationHazardsByBinding, binding),
    targetStart
  );

export const someHazardTimelineEndAtOrBefore = (
  timeline: MutationTimeline<Node>,
  targetStart: number,
  ctx: ExtractionContext,
  predicate: (hazard: Node) => boolean
): boolean =>
  someTimelineEndAtOrBefore(timeline, targetStart, predicate) ||
  someExecutionAncestorEffect(
    ctx.bindingIndex,
    timeline,
    targetStart,
    predicate
  );

export const getBindingHazardTimeline = (
  binding: Binding,
  ctx: ExtractionContext
): MutationTimeline<Node> =>
  getHazardTimelineAt(
    toMutationBindingKey(binding),
    ctx.currentExpressionStart,
    ctx
  );

const assignmentTargetContainsBinding = (
  target: Node,
  binding: Binding,
  ctx: ExtractionContext
): boolean => {
  const targets: OxcAssignmentTargetLeaf[] = [];
  appendOxcAssignmentTargetLeaves(target, targets);
  for (let i = 0; i < targets.length; i += 1) {
    const leaf = targets[i]!;
    if (
      leaf.type === 'Identifier' &&
      resolveBindingAt(ctx, leaf.name, leaf.start) === binding
    ) {
      return true;
    }
  }
  return false;
};

export const mutationDirectlyTargetsBinding = (
  mutation: Node,
  binding: Binding,
  ctx: ExtractionContext
): boolean => {
  if (mutation.type === 'AssignmentExpression') {
    return assignmentTargetContainsBinding(mutation.left, binding, ctx);
  }

  return (
    mutation.type === 'UpdateExpression' &&
    assignmentTargetContainsBinding(mutation.argument, binding, ctx)
  );
};

export const hasDirectBindingMutationBefore = (
  binding: Binding,
  end: number,
  ctx: ExtractionContext
): boolean =>
  someTimelineEndAtOrBefore(
    getBindingDirectTimeline(binding, ctx),
    end,
    (mutation) => mutationDirectlyTargetsBinding(mutation, binding, ctx)
  ) ||
  someHazardTimelineEndAtOrBefore(
    getBindingHazardTimeline(binding, ctx),
    end,
    ctx,
    (mutation) => mutationDirectlyTargetsBinding(mutation, binding, ctx)
  );

export const hasLexicalPreDeclarationChange = (
  binding: Binding,
  ctx: ExtractionContext,
  bindingMutations: MutationTimeline<Node>,
  bindingMutationHazards: MutationTimeline<Node>
): boolean => {
  if (
    (binding.declarationKind !== 'const' &&
      binding.declarationKind !== 'let') ||
    !binding.declarator
  ) {
    return false;
  }

  const isPreDeclarationChange = (change: Node): boolean =>
    getReferences(change, ctx.bindingIndex).some(
      (reference) =>
        reference.name === binding.name && reference.binding === binding
    );

  return (
    someTimelineStartBefore(
      bindingMutations,
      binding.declaredAt,
      isPreDeclarationChange
    ) ||
    someTimelineStartBefore(
      bindingMutationHazards,
      binding.declaredAt,
      isPreDeclarationChange
    )
  );
};

export const isPatternRuntimeExpressionStable = (
  expression: Expression,
  patternDeclarator: VariableDeclarator,
  ctx: ExtractionContext,
  env: ReadonlyMap<string, unknown>,
  stack = new Set<string>()
): boolean =>
  getReferences(expression, ctx.bindingIndex).every(
    ({ binding, name, start: referenceStart }) => {
      if (env.has(name)) {
        return true;
      }

      if (!binding || binding.kind === 'param') {
        return false;
      }

      if (binding.declarator === patternDeclarator) {
        return true;
      }

      if (binding.kind === 'import' || binding.kind === 'function') {
        return true;
      }

      if (
        binding.declarationKind !== 'const' ||
        !binding.declarator?.init ||
        referenceStart < binding.declarator.end ||
        stack.has(binding.name)
      ) {
        return false;
      }

      const nextStack = new Set(stack);
      nextStack.add(binding.name);
      return isPatternRuntimeExpressionStable(
        binding.declarator.init,
        patternDeclarator,
        ctx,
        env,
        nextStack
      );
    }
  );

export const isDestructuringProjection = (
  callee: Node
): callee is OxcFunctionLikeNode =>
  callee.type === 'ArrowFunctionExpression' &&
  !callee.async &&
  callee.params.length === 1 &&
  (callee.params[0]?.type === 'ObjectPattern' ||
    callee.params[0]?.type === 'ArrayPattern') &&
  callee.body?.type === 'Identifier' &&
  new Set(collectOxcPatternBindingNames(callee.params[0])).has(
    callee.body.name
  );

const isProcessEnvMember = (node: Node): node is MemberExpression => {
  if (node.type !== 'MemberExpression' || node.computed) {
    return false;
  }

  if (node.property.type !== 'Identifier' || node.property.name !== 'env') {
    return false;
  }

  return node.object.type === 'Identifier' && node.object.name === 'process';
};

export const isProcessEnvValueAccess = (
  expression: Expression,
  ctx: ExtractionContext,
  env: ReadonlyMap<string, unknown>
): boolean => {
  const processEnvMember =
    expression.type === 'MemberExpression' ? expression.object : null;
  if (
    !processEnvMember ||
    !isProcessEnvMember(processEnvMember) ||
    env.has('process')
  ) {
    return false;
  }

  const processIdentifier = processEnvMember.object;
  return (
    processIdentifier.type === 'Identifier' &&
    !resolveBindingAt(ctx, processIdentifier.name, processIdentifier.start)
  );
};

/**
 * Legacy fallback rules. In the fallback positions of the static evaluator
 * (`typeof`, `??`/`||`/`&&` left operands, comparison operands and
 * function-local initializers) these unknown reads count as `undefined`:
 * - a direct `process.env.X` read (build-time environment policy);
 * - a `var` read before its declaration;
 * - a function-local variable initialized from one of them.
 * Everywhere else they stay unknown and are left to runtime evaluation.
 */
export const readsAsFallbackUndefined = (
  expression: Expression,
  result: StaticResult,
  ctx: ExtractionContext,
  env: ReadonlyMap<string, unknown>
): boolean => {
  if (!isFallbackUndefinedRead(result)) {
    return false;
  }

  if (expression.type === 'Identifier') {
    if (env.has(expression.name)) {
      return isFallbackUndefinedRead(env.get(expression.name));
    }

    const binding = resolveBindingAt(ctx, expression.name, expression.start);
    return (
      binding?.declarationKind === 'var' &&
      !!binding.declarator &&
      ctx.currentExpressionStart < binding.declarator.end
    );
  }

  return isProcessEnvValueAccess(expression, ctx, env);
};
