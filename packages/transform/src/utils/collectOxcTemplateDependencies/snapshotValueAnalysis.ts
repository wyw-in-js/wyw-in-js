/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { Expression, Node } from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import { getOxcSyntacticPropertyKey } from '../oxc/projections';
import { unwrapOxcRuntimeExpression } from '../oxc/runtimeSemantics';
import {
  forEachMergedTimelineStartBefore,
  forEachTimelineStartBefore,
  getMutationTimeline,
  resolveBindingAt,
  toMutationBindingKey,
} from './scopeAnalysis';
import { evaluateStaticOutcome } from './staticEvaluator';
import { hasStaticRuntimeIdentity } from './staticOutcome';
import {
  getHazardTimelineAt,
  someHazardTimelineEndAtOrBefore,
} from './staticEvaluationSafety';
import { toOxcBindingIdentity } from './bindingIdentity';
import type { Binding, ExtractionContext } from './types';

type SnapshotValueKind =
  | 'abrupt'
  | 'identity'
  | 'missing'
  | 'primitive'
  | 'unknown';

type SnapshotProjectionSegment = {
  fallback?: Expression;
  key: number | string;
};

type SnapshotPatternRoute = {
  rest: boolean;
  segments: SnapshotProjectionSegment[];
  unknown: boolean;
};

const joinSnapshotValueKinds = (
  left: SnapshotValueKind,
  right: SnapshotValueKind
): SnapshotValueKind => {
  if (left === 'identity' || right === 'identity') {
    return 'identity';
  }
  if (left === 'unknown' || right === 'unknown') {
    return 'unknown';
  }
  if (left === right) {
    return left;
  }

  // Missing values and paths which complete abruptly cannot expose an object
  // to the processor. When paired with a primitive branch, the successful
  // value is still primitive.
  return 'primitive';
};

const unwrapSnapshotExpression = (node: Node): Node =>
  unwrapOxcRuntimeExpression(node, true);

const snapshotStaticPropertyKey = (
  key: Node,
  computed: boolean,
  ctx: ExtractionContext
): number | string | null => {
  const syntactic = getOxcSyntacticPropertyKey(key, computed);
  if (syntactic !== null) {
    return syntactic;
  }
  if (!computed) {
    return null;
  }

  const outcome = evaluateStaticOutcome(key as Expression, ctx);
  if (
    outcome.kind === 'known' &&
    (typeof outcome.value === 'string' || typeof outcome.value === 'number')
  ) {
    return outcome.value;
  }

  if (key.type !== 'Identifier') {
    return null;
  }
  const binding = resolveBindingAt(ctx, key.name, key.start);
  const init = binding?.declarator?.init;
  let scalar =
    init?.type === 'Literal' &&
    (typeof init.value === 'string' || typeof init.value === 'number')
      ? init.value
      : null;
  if (!binding) {
    return scalar;
  }

  forEachTimelineStartBefore(
    getMutationTimeline(
      ctx.rootMutationsByBinding,
      toMutationBindingKey(binding)
    ),
    key.start,
    (change) => {
      if (
        change.type !== 'AssignmentExpression' ||
        change.operator !== '=' ||
        change.left.type !== 'Identifier' ||
        resolveBindingAt(ctx, change.left.name, change.left.start) !== binding
      ) {
        scalar = null;
        return;
      }
      const right = unwrapSnapshotExpression(change.right);
      scalar =
        right.type === 'Literal' &&
        (typeof right.value === 'string' || typeof right.value === 'number')
          ? right.value
          : null;
    }
  );
  return scalar;
};

const patternContainsSnapshotBinding = (
  pattern: Node,
  name: string
): boolean => {
  if (pattern.type === 'Identifier') {
    return pattern.name === name;
  }
  if (pattern.type === 'AssignmentPattern') {
    return patternContainsSnapshotBinding(pattern.left, name);
  }
  if (pattern.type === 'RestElement') {
    return patternContainsSnapshotBinding(pattern.argument, name);
  }
  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.some((property) =>
      patternContainsSnapshotBinding(
        property.type === 'RestElement' ? property.argument : property.value,
        name
      )
    );
  }
  if (pattern.type === 'ArrayPattern') {
    return pattern.elements.some(
      (element) => !!element && patternContainsSnapshotBinding(element, name)
    );
  }
  return false;
};

const findSnapshotPatternRoute = (
  pattern: Node,
  name: string,
  ctx: ExtractionContext,
  segments: SnapshotProjectionSegment[] = []
): SnapshotPatternRoute | null => {
  if (pattern.type === 'Identifier') {
    return pattern.name === name
      ? { rest: false, segments, unknown: false }
      : null;
  }

  if (pattern.type === 'AssignmentPattern') {
    const route = findSnapshotPatternRoute(pattern.left, name, ctx, segments);
    if (!route) {
      return null;
    }
    if (route.segments.length === 0) {
      return { ...route, unknown: true };
    }

    const nextSegments = route.segments.map((segment) => ({ ...segment }));
    nextSegments[segments.length - 1] = {
      ...nextSegments[segments.length - 1]!,
      fallback: pattern.right,
    };
    return { ...route, segments: nextSegments };
  }

  if (pattern.type === 'RestElement') {
    if (!patternContainsSnapshotBinding(pattern.argument, name)) {
      return null;
    }
    const route = findSnapshotPatternRoute(
      pattern.argument,
      name,
      ctx,
      segments
    );
    return route ? { ...route, rest: true } : null;
  }

  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      const target =
        property.type === 'RestElement' ? property.argument : property.value;
      if (!patternContainsSnapshotBinding(target, name)) {
        continue;
      }
      if (property.type === 'RestElement') {
        const route = findSnapshotPatternRoute(target, name, ctx, segments);
        return route ? { ...route, rest: true } : null;
      }

      const key = snapshotStaticPropertyKey(
        property.key,
        property.computed,
        ctx
      );
      if (key === null) {
        return { rest: false, segments, unknown: true };
      }
      return findSnapshotPatternRoute(property.value, name, ctx, [
        ...segments,
        { key },
      ]);
    }
    return null;
  }

  if (pattern.type === 'ArrayPattern') {
    for (let index = 0; index < pattern.elements.length; index += 1) {
      const element = pattern.elements[index];
      if (!element || !patternContainsSnapshotBinding(element, name)) {
        continue;
      }
      return findSnapshotPatternRoute(element, name, ctx, [
        ...segments,
        { key: index },
      ]);
    }
  }

  return null;
};

const snapshotPathMatches = (
  left: SnapshotProjectionSegment[],
  right: SnapshotProjectionSegment[]
): boolean =>
  left.length === right.length &&
  left.every(
    ({ key }, index) => String(key) === String(right[index]?.key ?? '')
  );

const snapshotPathStartsWith = (
  path: SnapshotProjectionSegment[],
  prefix: SnapshotProjectionSegment[]
): boolean =>
  prefix.length <= path.length &&
  prefix.every(
    ({ key }, index) => String(key) === String(path[index]?.key ?? '')
  );

const snapshotMemberPath = (
  node: Node,
  ctx: ExtractionContext
): {
  binding: Binding | null;
  segments: SnapshotProjectionSegment[];
} | null => {
  const current = unwrapSnapshotExpression(node);
  if (current.type === 'Identifier') {
    return {
      binding: resolveBindingAt(ctx, current.name, current.start) ?? null,
      segments: [],
    };
  }
  if (current.type !== 'MemberExpression' || current.optional) {
    return null;
  }

  const object = snapshotMemberPath(current.object, ctx);
  const key = snapshotStaticPropertyKey(
    current.property,
    current.computed,
    ctx
  );
  if (!object || key === null) {
    return null;
  }
  return {
    binding: object.binding,
    segments: [...object.segments, { key }],
  };
};

const isDefinitelyUndefinedSnapshotExpression = (
  expression: Expression,
  ctx: ExtractionContext
): boolean => {
  const current = unwrapSnapshotExpression(expression);
  if (current.type === 'UnaryExpression' && current.operator === 'void') {
    return true;
  }
  return (
    current.type === 'Identifier' &&
    current.name === 'undefined' &&
    !resolveBindingAt(ctx, current.name, current.start)
  );
};

export const inferSnapshotExpressionKind = (
  expression: Expression,
  ctx: ExtractionContext,
  stack = new Set<string>()
): SnapshotValueKind => {
  const current = unwrapSnapshotExpression(expression) as Expression;
  const outcome = evaluateStaticOutcome(current, ctx);
  if (hasStaticRuntimeIdentity(outcome)) {
    return 'identity';
  }
  if (outcome.kind === 'known') {
    return 'primitive';
  }

  if (current.type === 'Literal') {
    return 'primitive';
  }
  if (
    current.type === 'UnaryExpression' ||
    current.type === 'BinaryExpression' ||
    current.type === 'UpdateExpression' ||
    current.type === 'TemplateLiteral'
  ) {
    return 'primitive';
  }
  if (
    current.type === 'ObjectExpression' ||
    current.type === 'ArrayExpression' ||
    current.type === 'ArrowFunctionExpression' ||
    current.type === 'FunctionExpression' ||
    current.type === 'ClassExpression' ||
    current.type === 'NewExpression'
  ) {
    return 'identity';
  }
  if (current.type === 'ConditionalExpression') {
    return joinSnapshotValueKinds(
      inferSnapshotExpressionKind(current.consequent, ctx, stack),
      inferSnapshotExpressionKind(current.alternate, ctx, stack)
    );
  }
  if (current.type === 'LogicalExpression') {
    return joinSnapshotValueKinds(
      inferSnapshotExpressionKind(current.left, ctx, stack),
      inferSnapshotExpressionKind(current.right, ctx, stack)
    );
  }
  if (current.type === 'SequenceExpression') {
    const last = current.expressions.at(-1);
    return last ? inferSnapshotExpressionKind(last, ctx, stack) : 'missing';
  }
  if (current.type === 'AssignmentExpression') {
    return current.operator === '=' ||
      current.operator === '&&=' ||
      current.operator === '||=' ||
      current.operator === '??='
      ? inferSnapshotExpressionKind(current.right, ctx, stack)
      : 'primitive';
  }

  const member = snapshotMemberPath(current, ctx);
  if (member?.binding) {
    return inferSnapshotBindingKind(
      member.binding,
      member.segments,
      ctx,
      stack
    );
  }

  return 'unknown';
};

const inferSnapshotObjectPropertyKind = (
  expression: Extract<Expression, { type: 'ObjectExpression' }>,
  segments: SnapshotProjectionSegment[],
  ctx: ExtractionContext,
  stack: Set<string>
): SnapshotValueKind => {
  const [head, ...tail] = segments;
  if (!head) {
    return 'identity';
  }

  for (let index = expression.properties.length - 1; index >= 0; index -= 1) {
    const property = expression.properties[index]!;
    if (property.type === 'SpreadElement') {
      return 'unknown';
    }
    const key = snapshotStaticPropertyKey(property.key, property.computed, ctx);
    if (key === null || String(key) !== String(head.key)) {
      continue;
    }
    if (property.kind !== 'init' || property.method) {
      return 'unknown';
    }
    if (
      head.fallback &&
      isDefinitelyUndefinedSnapshotExpression(property.value, ctx)
    ) {
      return inferSnapshotProjectionKind(head.fallback, tail, ctx, stack);
    }
    return inferSnapshotProjectionKind(property.value, tail, ctx, stack);
  }

  if (head.fallback) {
    return inferSnapshotProjectionKind(head.fallback, tail, ctx, stack);
  }
  return tail.length === 0 ? 'missing' : 'abrupt';
};

const inferSnapshotArrayPropertyKind = (
  expression: Extract<Expression, { type: 'ArrayExpression' }>,
  segments: SnapshotProjectionSegment[],
  ctx: ExtractionContext,
  stack: Set<string>
): SnapshotValueKind => {
  const [head, ...tail] = segments;
  if (!head) {
    return 'identity';
  }
  if (head.key === 'length') {
    return tail.length === 0 ? 'primitive' : 'abrupt';
  }
  if (
    typeof head.key !== 'number' ||
    !Number.isInteger(head.key) ||
    head.key < 0
  ) {
    return 'unknown';
  }

  const element = expression.elements[head.key];
  if (!element || element.type === 'SpreadElement') {
    if (head.fallback) {
      return inferSnapshotProjectionKind(head.fallback, tail, ctx, stack);
    }
    return tail.length === 0 ? 'missing' : 'abrupt';
  }
  if (head.fallback && isDefinitelyUndefinedSnapshotExpression(element, ctx)) {
    return inferSnapshotProjectionKind(head.fallback, tail, ctx, stack);
  }
  return inferSnapshotProjectionKind(element, tail, ctx, stack);
};

const inferSnapshotProjectionKind = (
  expression: Expression,
  segments: SnapshotProjectionSegment[],
  ctx: ExtractionContext,
  stack: Set<string>
): SnapshotValueKind => {
  if (segments.length === 0) {
    return inferSnapshotExpressionKind(expression, ctx, stack);
  }

  const current = unwrapSnapshotExpression(expression) as Expression;
  if (current.type === 'Identifier') {
    const binding = resolveBindingAt(ctx, current.name, current.start);
    return binding
      ? inferSnapshotBindingKind(binding, segments, ctx, stack)
      : 'unknown';
  }
  if (current.type === 'ObjectExpression') {
    return inferSnapshotObjectPropertyKind(current, segments, ctx, stack);
  }
  if (current.type === 'ArrayExpression') {
    return inferSnapshotArrayPropertyKind(current, segments, ctx, stack);
  }
  if (current.type === 'ConditionalExpression') {
    return joinSnapshotValueKinds(
      inferSnapshotProjectionKind(current.consequent, segments, ctx, stack),
      inferSnapshotProjectionKind(current.alternate, segments, ctx, stack)
    );
  }
  if (current.type === 'LogicalExpression') {
    return joinSnapshotValueKinds(
      inferSnapshotProjectionKind(current.left, segments, ctx, stack),
      inferSnapshotProjectionKind(current.right, segments, ctx, stack)
    );
  }

  const valueKind = inferSnapshotExpressionKind(current, ctx, stack);
  return valueKind === 'primitive' || valueKind === 'missing'
    ? 'abrupt'
    : 'unknown';
};

const inferSnapshotAssignmentKind = (
  assignment: Extract<Node, { type: 'AssignmentExpression' }>,
  binding: Binding,
  accessPath: SnapshotProjectionSegment[],
  ctx: ExtractionContext,
  stack: Set<string>,
  previous: SnapshotValueKind
): SnapshotValueKind => {
  if (
    assignment.left.type === 'ObjectPattern' ||
    assignment.left.type === 'ArrayPattern'
  ) {
    const route = findSnapshotPatternRoute(assignment.left, binding.name, ctx);
    if (!route) {
      return previous;
    }
    if (route.unknown || route.rest) {
      return route.rest ? 'identity' : 'unknown';
    }
    return inferSnapshotProjectionKind(
      assignment.right,
      [...route.segments, ...accessPath],
      ctx,
      stack
    );
  }

  const target = snapshotMemberPath(assignment.left, ctx);
  if (!target) {
    return 'unknown';
  }
  const sameBinding = target.binding === binding;
  const targetIsRecordedAlias =
    !sameBinding &&
    getMutationTimeline(
      ctx.rootMutationsByBinding,
      toMutationBindingKey(binding)
    ).byStart.includes(assignment);
  if (!sameBinding && !targetIsRecordedAlias) {
    return previous;
  }

  if (snapshotPathStartsWith(accessPath, target.segments)) {
    const remaining = accessPath.slice(target.segments.length);
    if (
      assignment.operator !== '=' &&
      assignment.operator !== '&&=' &&
      assignment.operator !== '||=' &&
      assignment.operator !== '??='
    ) {
      return remaining.length === 0 ? 'primitive' : previous;
    }
    const assigned = inferSnapshotProjectionKind(
      assignment.right,
      remaining,
      ctx,
      stack
    );
    return assignment.operator === '='
      ? assigned
      : joinSnapshotValueKinds(previous, assigned);
  }

  if (targetIsRecordedAlias) {
    const assignedKind = inferSnapshotExpressionKind(
      assignment.right,
      ctx,
      stack
    );
    if (assignedKind === 'identity' || assignedKind === 'unknown') {
      // Alias propagation proves that the assignment can reach this binding,
      // but a differently shaped target does not prove which projected leaf
      // it changes. An identity-bearing RHS therefore remains unsafe.
      return 'unknown';
    }
  }

  return previous;
};

const inlineSnapshotCallPreservesPrimitiveShape = (
  call: Extract<Node, { type: 'CallExpression' }>,
  ctx: ExtractionContext,
  stack: Set<string>
): boolean => {
  const callee = unwrapSnapshotExpression(call.callee);
  if (
    (callee.type !== 'ArrowFunctionExpression' &&
      callee.type !== 'FunctionExpression') ||
    callee.async ||
    callee.generator ||
    !callee.body
  ) {
    return false;
  }

  let safe = true;
  const visit = (node: Node): void => {
    if (!safe) {
      return;
    }
    if (
      node.type === 'CallExpression' ||
      node.type === 'NewExpression' ||
      node.type === 'TaggedTemplateExpression'
    ) {
      safe = false;
      return;
    }
    if (node.type === 'AssignmentExpression') {
      if (
        (node.operator === '=' ||
          node.operator === '&&=' ||
          node.operator === '||=' ||
          node.operator === '??=') &&
        !['abrupt', 'missing', 'primitive'].includes(
          inferSnapshotExpressionKind(node.right, ctx, stack)
        )
      ) {
        safe = false;
        return;
      }
    }
    getOxcNodeChildren(node).forEach(visit);
  };

  visit(callee.body);
  return safe;
};

function inferSnapshotBindingKind(
  binding: Binding,
  accessPath: SnapshotProjectionSegment[],
  ctx: ExtractionContext,
  stack: Set<string>
): SnapshotValueKind {
  const stackKey = `${toOxcBindingIdentity(binding)}:${accessPath
    .map(({ key }) => String(key))
    .join('.')}`;
  if (stack.has(stackKey)) {
    return 'unknown';
  }
  const nextStack = new Set(stack);
  nextStack.add(stackKey);

  const { declarator } = binding;
  let result: SnapshotValueKind = 'unknown';
  if (declarator?.init) {
    if (declarator.id.type === 'Identifier') {
      result = inferSnapshotProjectionKind(
        declarator.init,
        accessPath,
        ctx,
        nextStack
      );
    } else {
      const route = findSnapshotPatternRoute(declarator.id, binding.name, ctx);
      if (route?.rest) {
        result = accessPath.length === 0 ? 'identity' : 'unknown';
      } else if (route && !route.unknown) {
        result = inferSnapshotProjectionKind(
          declarator.init,
          [...route.segments, ...accessPath],
          ctx,
          nextStack
        );
      }
    }
  }

  const bindingKey = toMutationBindingKey(binding);
  forEachMergedTimelineStartBefore(
    getMutationTimeline(ctx.rootMutationsByBinding, bindingKey),
    getHazardTimelineAt(bindingKey, ctx.currentExpressionStart, ctx),
    ctx.currentExpressionStart,
    (hazard) =>
      hazard.type === 'AssignmentExpression' ||
      hazard.type === 'UpdateExpression',
    (change) => {
      if (change.type === 'UpdateExpression') {
        const target = snapshotMemberPath(change.argument, ctx);
        if (
          target &&
          target.binding === binding &&
          snapshotPathMatches(target.segments, accessPath)
        ) {
          result = 'primitive';
        }
        return;
      }
      if (change.type !== 'AssignmentExpression') {
        return;
      }
      result = inferSnapshotAssignmentKind(
        change,
        binding,
        accessPath,
        ctx,
        nextStack,
        result
      );
    }
  );

  const hasOpaqueCallHazard = someHazardTimelineEndAtOrBefore(
    getHazardTimelineAt(bindingKey, ctx.currentExpressionStart, ctx),
    ctx.currentExpressionStart,
    ctx,
    (hazard) => {
      if (
        hazard.type === 'CallExpression' &&
        inlineSnapshotCallPreservesPrimitiveShape(hazard, ctx, nextStack)
      ) {
        return false;
      }

      let found = false;
      const visit = (node: Node): void => {
        if (
          node.type === 'CallExpression' ||
          node.type === 'NewExpression' ||
          node.type === 'TaggedTemplateExpression'
        ) {
          found = true;
          return;
        }
        if (!found) {
          getOxcNodeChildren(node).forEach(visit);
        }
      };
      visit(hazard);
      return found;
    }
  );

  return hasOpaqueCallHazard ? 'unknown' : result;
}
