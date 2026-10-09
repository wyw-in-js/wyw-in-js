/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define,@typescript-eslint/default-param-last */

import type {
  AssignmentExpression,
  Expression,
  Node,
  UpdateExpression,
} from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import { collectOxcPatternBindingNames } from '../oxc/patterns';
import { getOxcSyntacticPropertyKey } from '../oxc/projections';
import { isOxcFunctionLike } from '../oxc/runtimeSemantics';
import {
  hasTimelineStartBefore,
  resolveBindingAt,
  someTimelineEndAtOrBefore,
} from './scopeAnalysis';
import {
  getBindingDirectTimeline,
  getBindingHazardTimeline,
  hasArrayIterationMutationBefore,
  hasRelevantIntrinsicMutationBefore,
  readsAsFallbackUndefined,
} from './staticEvaluationSafety';
import {
  asOperandFailure,
  isStaticNonValue,
  unknownOutcome,
  UnknownReason,
  type StaticResult,
} from './staticOutcome';
import {
  cloneStaticValue,
  copyEnumerableOwnDataProperties,
  hasDefaultArrayIterator,
  hasExactPrototype,
  hasOnlyDataProperties,
  isStaticProxy,
  readArrayProjectionElement,
  readObjectProjectionProperty,
  readOwnDataProperty,
} from './staticValues';
import type {
  Binding,
  ExtractionContext,
  MutationTimeline,
  OxcFunctionLikeNode,
} from './types';

export type EvaluateStatic = (
  expression: Expression,
  ctx: ExtractionContext,
  env?: EvalEnv,
  stack?: EvaluationStack
) => StaticResult;

export type EvaluationStack = Array<string | OxcFunctionLikeNode>;

type IsKnownPureStaticCall = (node: Node, ctx: ExtractionContext) => boolean;

const INT32_SIZE = 2 ** 32;
const INT32_SIGN_BIT = 2 ** 31;
export const uninitializedStaticBinding = Symbol(
  'wyw.oxc.uninitializedStaticBinding'
);

const toInt32 = (value: number): number => {
  if (!Number.isFinite(value) || value === 0) {
    return 0;
  }

  const integer = Math.sign(value) * Math.floor(Math.abs(value));
  const int32bit = ((integer % INT32_SIZE) + INT32_SIZE) % INT32_SIZE;

  return int32bit >= INT32_SIGN_BIT ? int32bit - INT32_SIZE : int32bit;
};

export const bitwiseNot = (value: number): number => -toInt32(value) - 1;

export const bindingValueCacheKey = (
  binding: Binding,
  ctx: ExtractionContext,
  bindingMutations: MutationTimeline<Node> = getBindingDirectTimeline(
    binding,
    ctx
  ),
  bindingMutationHazards: MutationTimeline<Node> = getBindingHazardTimeline(
    binding,
    ctx
  ),
  isKnownPureStaticCall: IsKnownPureStaticCall
): string => {
  const snapshot =
    hasTimelineStartBefore(bindingMutations, ctx.currentExpressionStart) ||
    someTimelineEndAtOrBefore(
      bindingMutationHazards,
      ctx.currentExpressionStart,
      (hazard) => !isKnownPureStaticCall(hazard, ctx)
    )
      ? ctx.currentExpressionStart
      : 'stable';
  return `\0wyw-static-binding:${binding.declaredAt}:${snapshot}:${binding.name}`;
};

export const evaluateStaticPropertyKey = (
  keyNode: Node,
  computed: boolean,
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: EvaluationStack,
  evaluateStatic: EvaluateStatic
): string | number | null => {
  const syntactic = getOxcSyntacticPropertyKey(keyNode, computed);
  if (syntactic !== null) {
    return syntactic;
  }

  if (!computed) {
    return null;
  }

  const key = evaluateStatic(keyNode as Expression, ctx, env, stack);
  return typeof key === 'string' || typeof key === 'number' ? key : null;
};

const evaluateObjectExpressionMember = (
  expression: Expression,
  propertyKey: string | number,
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: EvaluationStack,
  evaluateStatic: EvaluateStatic
): StaticResult => {
  if (expression.type !== 'ObjectExpression') {
    return unknownOutcome(UnknownReason.UnsupportedSyntax);
  }

  for (let idx = expression.properties.length - 1; idx >= 0; idx -= 1) {
    const property = expression.properties[idx]!;
    if (property.type === 'SpreadElement') {
      return unknownOutcome(UnknownReason.UnsupportedOperand);
    }

    const key = evaluateStaticPropertyKey(
      property.key,
      property.computed,
      ctx,
      env,
      stack,
      evaluateStatic
    );
    if (key === null) {
      return unknownOutcome(UnknownReason.UnsupportedOperand);
    }

    if (key === propertyKey) {
      return evaluateStatic(property.value, ctx, env, stack);
    }
  }

  return unknownOutcome(UnknownReason.MissingProperty);
};

export const evaluateKnownObjectMember = (
  expression: Expression,
  propertyKey: string | number,
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: EvaluationStack,
  evaluateStatic: EvaluateStatic
): StaticResult => {
  const objectMember = evaluateObjectExpressionMember(
    expression,
    propertyKey,
    ctx,
    env,
    stack,
    evaluateStatic
  );
  if (!isStaticNonValue(objectMember)) {
    return objectMember;
  }

  if (expression.type !== 'Identifier' || env.has(expression.name)) {
    return unknownOutcome(UnknownReason.UnsupportedSyntax);
  }

  const binding = resolveBindingAt(ctx, expression.name, expression.start);
  if (
    !binding ||
    binding.kind === 'param' ||
    binding.importedFrom ||
    binding.isRoot ||
    stack.includes(binding.name) ||
    !binding.declarator?.init ||
    binding.declarator.id.type !== 'Identifier'
  ) {
    return unknownOutcome(UnknownReason.UnsupportedBinding);
  }

  return evaluateKnownObjectMember(
    binding.declarator.init,
    propertyKey,
    ctx,
    env,
    [...stack, binding.name],
    evaluateStatic
  );
};

export type EvalEnv = Map<string, unknown>;

const oxcStaticCallableValue = Symbol('wyw.oxc.staticCallableValue');
export const oxcStaticFunctionNode = Symbol('wyw.oxc.staticFunctionNode');

type OxcStaticCallableValue = {
  [oxcStaticCallableValue]: unknown;
};

type OxcStaticFunctionValue = (() => undefined) & {
  [oxcStaticFunctionNode]: OxcFunctionLikeNode;
};

export const isOxcStaticCallableValue = (
  value: unknown
): value is OxcStaticCallableValue =>
  typeof value === 'object' &&
  value !== null &&
  !isStaticProxy(value) &&
  oxcStaticCallableValue in value;

export const unwrapOxcStaticCallableValue = (value: unknown): unknown =>
  isOxcStaticCallableValue(value) ? value[oxcStaticCallableValue] : value;

export const createOxcStaticFunctionValue = (
  fn: OxcFunctionLikeNode
): OxcStaticFunctionValue =>
  Object.assign(() => undefined, {
    [oxcStaticFunctionNode]: fn,
  });

export const isOxcStaticFunctionValue = (
  value: unknown
): value is OxcStaticFunctionValue =>
  typeof value === 'function' &&
  !isStaticProxy(value) &&
  oxcStaticFunctionNode in value;

export const createOxcStaticCallableValue = (
  value: unknown
): OxcStaticCallableValue => ({
  [oxcStaticCallableValue]: value,
});

export const appendDefaultArrayElements = (
  target: unknown[],
  value: unknown[],
  ctx: ExtractionContext
): boolean => {
  if (
    hasArrayIterationMutationBefore(ctx.currentExpressionStart, ctx) ||
    isStaticProxy(value) ||
    !hasExactPrototype(value, Array.prototype) ||
    !hasOnlyDataProperties(value) ||
    !hasDefaultArrayIterator(value)
  ) {
    return false;
  }

  const length = readOwnDataProperty(value, 'length');
  if (!length.safe || !length.found || typeof length.value !== 'number') {
    return false;
  }

  for (let index = 0; index < length.value; index += 1) {
    const element = readArrayProjectionElement(value, index);
    if (!element.safe) {
      return false;
    }
    target.push(element.value);
  }

  return true;
};

export const assignPatternValue = (
  pattern: Node,
  value: unknown,
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: EvaluationStack,
  evaluateStatic: EvaluateStatic
): boolean => {
  if (pattern.type === 'Identifier') {
    env.set(pattern.name, value);
    return true;
  }

  if (pattern.type === 'AssignmentPattern') {
    const assignedValue =
      value === undefined
        ? evaluateStatic(pattern.right, ctx, env, stack)
        : value;
    if (isStaticNonValue(assignedValue)) {
      return false;
    }

    return assignPatternValue(
      pattern.left,
      assignedValue,
      ctx,
      env,
      stack,
      evaluateStatic
    );
  }

  if (pattern.type === 'ObjectPattern') {
    if (
      hasRelevantIntrinsicMutationBefore(
        pattern,
        ctx.currentExpressionStart,
        ctx
      ) ||
      typeof value !== 'object' ||
      value === null ||
      isStaticProxy(value) ||
      !hasExactPrototype(value, Object.prototype)
    ) {
      return false;
    }

    const excludedKeys = new Set<string>();
    for (const property of pattern.properties) {
      if (property.type === 'RestElement') {
        const rest: Record<string, unknown> = {};
        if (
          !copyEnumerableOwnDataProperties(rest, value, excludedKeys, 'reject')
        ) {
          return false;
        }
        if (
          !assignPatternValue(
            property.argument,
            rest,
            ctx,
            env,
            stack,
            evaluateStatic
          )
        ) {
          return false;
        }
        continue;
      }

      const key = evaluateStaticPropertyKey(
        property.key,
        property.computed,
        ctx,
        env,
        stack,
        evaluateStatic
      );
      if (key === null) {
        return false;
      }

      excludedKeys.add(String(key));
      const member = readObjectProjectionProperty(value, key);
      if (!member.safe) {
        return false;
      }
      if (
        !assignPatternValue(
          property.value,
          member.value,
          ctx,
          env,
          stack,
          evaluateStatic
        )
      ) {
        return false;
      }
    }

    return true;
  }

  if (pattern.type === 'ArrayPattern') {
    if (
      hasRelevantIntrinsicMutationBefore(
        pattern,
        ctx.currentExpressionStart,
        ctx
      ) ||
      isStaticProxy(value) ||
      !Array.isArray(value) ||
      !hasExactPrototype(value, Array.prototype) ||
      !hasOnlyDataProperties(value)
    ) {
      return false;
    }

    if (!hasDefaultArrayIterator(value)) {
      return false;
    }

    const length = readOwnDataProperty(value, 'length');
    if (!length.safe || !length.found || typeof length.value !== 'number') {
      return false;
    }

    for (let index = 0; index < pattern.elements.length; index += 1) {
      const element = pattern.elements[index];
      let elementValue: unknown;
      if (element?.type === 'RestElement') {
        const rest: unknown[] = [];
        for (let cursor = index; cursor < length.value; cursor += 1) {
          const member = readArrayProjectionElement(value, cursor);
          if (!member.safe) {
            return false;
          }
          rest.push(member.value);
        }
        elementValue = rest;
      } else {
        // Array destructuring advances the iterator for elisions too.
        const member = readArrayProjectionElement(value, index);
        if (!member.safe) {
          return false;
        }
        elementValue = member.value;
      }
      if (!element) {
        continue;
      }

      const target =
        element.type === 'RestElement' ? element.argument : element;
      if (
        !assignPatternValue(
          target,
          elementValue,
          ctx,
          env,
          stack,
          evaluateStatic
        )
      ) {
        return false;
      }
    }

    return true;
  }

  return false;
};

export const applyRootMutation = (
  bindingName: string,
  baseValue: unknown,
  mutation: AssignmentExpression | UpdateExpression,
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: EvaluationStack,
  evaluateStatic: EvaluateStatic
): StaticResult => {
  const resolvePath = (node: Node): { path: Array<string | number> } | null => {
    if (node.type === 'Identifier') {
      return node.name === bindingName ? { path: [] } : null;
    }

    if (node.type !== 'MemberExpression') {
      return null;
    }

    const parent = resolvePath(node.object);
    if (!parent) {
      return null;
    }

    const key = evaluateStaticPropertyKey(
      node.property,
      node.computed,
      ctx,
      env,
      stack,
      evaluateStatic
    );
    if (key === null) {
      return null;
    }

    return {
      path: [...parent.path, key],
    };
  };

  const pathInfo = resolvePath(
    mutation.type === 'AssignmentExpression' ? mutation.left : mutation.argument
  );
  if (!pathInfo) {
    return unknownOutcome(UnknownReason.UnsupportedSyntax);
  }

  const cloned = cloneStaticValue(baseValue);
  if (pathInfo.path.length === 0) {
    if (mutation.type !== 'AssignmentExpression') {
      return unknownOutcome(UnknownReason.UnsupportedOperand);
    }

    return evaluateStatic(mutation.right, ctx, env, stack);
  }

  // A property write on a primitive (or on a value that could not be cloned)
  // throws at runtime.
  if (typeof cloned !== 'object' || cloned === null) {
    return unknownOutcome(UnknownReason.UnsupportedOperand);
  }

  let target = cloned as Record<string | number, unknown>;
  for (let idx = 0; idx < pathInfo.path.length - 1; idx += 1) {
    const key = pathInfo.path[idx];
    const next = target?.[key];
    if (typeof next !== 'object' || next === null) {
      return unknownOutcome(UnknownReason.UnsupportedOperand);
    }

    target = next as Record<string | number, unknown>;
  }

  const lastKey = pathInfo.path[pathInfo.path.length - 1]!;
  if (mutation.type === 'AssignmentExpression') {
    const nextValue = evaluateStatic(mutation.right, ctx, env, stack);
    if (isStaticNonValue(nextValue)) {
      return asOperandFailure(nextValue);
    }

    target[lastKey] = nextValue;
    return cloned;
  }

  const currentValue = target[lastKey];
  if (typeof currentValue !== 'number') {
    return unknownOutcome(UnknownReason.UnsupportedOperand);
  }

  target[lastKey] =
    mutation.operator === '++' ? currentValue + 1 : currentValue - 1;
  return cloned;
};

const collectHoistedVarNames = (
  node: Node,
  names = new Set<string>(),
  root = node
): Set<string> => {
  if (node !== root && isOxcFunctionLike(node)) {
    return names;
  }

  if (node.type === 'VariableDeclaration' && node.kind === 'var') {
    node.declarations.forEach((declarator) => {
      collectOxcPatternBindingNames(declarator.id).forEach((name) =>
        names.add(name)
      );
    });
  }

  getOxcNodeChildren(node).forEach((child) =>
    collectHoistedVarNames(child, names, root)
  );
  return names;
};

type FunctionBodyDeclarationFact =
  | {
      kind: 'function';
      name: string;
      node: OxcFunctionLikeNode;
    }
  | {
      kind: 'lexical';
      names: readonly string[];
    };

type FunctionBodyFacts = {
  hoistedVarNames: readonly string[];
  topLevelDeclarations: readonly FunctionBodyDeclarationFact[];
};

type FunctionBodyNode = Extract<Node, { type: 'BlockStatement' }>;

const functionBodyFactsCache = new WeakMap<
  FunctionBodyNode,
  FunctionBodyFacts
>();

const getFunctionBodyFacts = (body: FunctionBodyNode): FunctionBodyFacts => {
  const cached = functionBodyFactsCache.get(body);
  if (cached) {
    return cached;
  }

  const topLevelDeclarations: FunctionBodyDeclarationFact[] = [];
  body.body.forEach((statement) => {
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      topLevelDeclarations.push({
        kind: 'lexical',
        names: statement.declarations.flatMap((declarator) =>
          collectOxcPatternBindingNames(declarator.id)
        ),
      });
    } else if (statement.type === 'FunctionDeclaration' && statement.id) {
      topLevelDeclarations.push({
        kind: 'function',
        name: statement.id.name,
        node: statement,
      });
    }
  });

  const facts = {
    hoistedVarNames: [...collectHoistedVarNames(body)],
    topLevelDeclarations,
  };
  functionBodyFactsCache.set(body, facts);
  return facts;
};

const prepareFunctionBodyEnvironment = (
  fn: OxcFunctionLikeNode,
  env: EvalEnv
): void => {
  if (fn.body?.type !== 'BlockStatement') {
    return;
  }

  const facts = getFunctionBodyFacts(fn.body);
  facts.hoistedVarNames.forEach((name) => {
    if (!env.has(name)) {
      env.set(name, undefined);
    }
  });

  facts.topLevelDeclarations.forEach((declaration) => {
    if (declaration.kind === 'lexical') {
      declaration.names.forEach((name) => {
        env.set(name, uninitializedStaticBinding);
      });
      return;
    }

    env.set(declaration.name, createOxcStaticFunctionValue(declaration.node));
  });
};

export const evaluateFunctionCall = (
  fn: OxcFunctionLikeNode,
  args: unknown[],
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: EvaluationStack,
  evaluateStatic: EvaluateStatic
): StaticResult => {
  if (fn.async || !fn.body) {
    return unknownOutcome(UnknownReason.UnsupportedSyntax);
  }

  if (stack.includes(fn)) {
    return unknownOutcome(UnknownReason.Recursion);
  }

  const nextStack = [...stack, fn];
  const localEnv = new Map(env);
  if (fn.id) {
    localEnv.set(fn.id.name, createOxcStaticFunctionValue(fn));
  }
  fn.params.forEach((param) => {
    collectOxcPatternBindingNames(param).forEach((name) => {
      localEnv.set(name, uninitializedStaticBinding);
    });
  });
  for (let idx = 0; idx < fn.params.length; idx += 1) {
    if (
      !assignPatternValue(
        fn.params[idx],
        args[idx],
        ctx,
        localEnv,
        nextStack,
        evaluateStatic
      )
    ) {
      return unknownOutcome(UnknownReason.UnsupportedOperand);
    }
  }

  if (fn.body.type !== 'BlockStatement') {
    return evaluateStatic(fn.body as Expression, ctx, localEnv, nextStack);
  }

  prepareFunctionBodyEnvironment(fn, localEnv);

  for (const statement of fn.body.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declarator of statement.declarations) {
        if (statement.kind === 'var' && !declarator.init) {
          continue;
        }

        let value = declarator.init
          ? evaluateStatic(declarator.init, ctx, localEnv, nextStack)
          : undefined;
        if (isStaticNonValue(value)) {
          if (
            !declarator.init ||
            !readsAsFallbackUndefined(declarator.init, value, ctx, localEnv)
          ) {
            return asOperandFailure(value);
          }
          // An identifier keeps the unknown read, so only the positions
          // covered by the fallback rules see `undefined` later.
          if (declarator.id.type !== 'Identifier') {
            value = undefined;
          }
        }
        if (
          !assignPatternValue(
            declarator.id,
            value,
            ctx,
            localEnv,
            nextStack,
            evaluateStatic
          )
        ) {
          return unknownOutcome(UnknownReason.UnsupportedOperand);
        }
      }
      continue;
    }

    if (statement.type === 'FunctionDeclaration') {
      continue;
    }

    if (statement.type === 'ReturnStatement') {
      if (!statement.argument) {
        return unknownOutcome(UnknownReason.UnsupportedSyntax);
      }

      return evaluateStatic(statement.argument, ctx, localEnv, nextStack);
    }

    return unknownOutcome(UnknownReason.UnsupportedSyntax);
  }

  return unknownOutcome(UnknownReason.UnsupportedSyntax);
};

const isCoercionFreePrimitive = (value: unknown): boolean =>
  value === null || (typeof value !== 'object' && typeof value !== 'function');

export const evaluateStringConversion = (value: unknown): StaticResult =>
  isCoercionFreePrimitive(value)
    ? String(value)
    : unknownOutcome(UnknownReason.UnsupportedOperand);

export const evaluateNumberConversion = (value: unknown): StaticResult => {
  if (!isCoercionFreePrimitive(value) || typeof value === 'symbol') {
    return unknownOutcome(UnknownReason.UnsupportedOperand);
  }
  try {
    return Number(value);
  } catch {
    return unknownOutcome(UnknownReason.EvaluationError);
  }
};

export const evaluateBinary = (
  expression: Expression,
  ctx: ExtractionContext,
  env: EvalEnv = new Map(),
  stack: EvaluationStack = [],
  evaluateStatic: EvaluateStatic
): StaticResult => {
  if (expression.type !== 'BinaryExpression') {
    return unknownOutcome(UnknownReason.UnsupportedSyntax);
  }

  const leftResult = evaluateStatic(
    expression.left as Expression,
    ctx,
    env,
    stack
  );
  const rightResult = evaluateStatic(
    expression.right as Expression,
    ctx,
    env,
    stack
  );
  const operands: Array<[Expression, StaticResult]> = [
    [expression.left as Expression, leftResult],
    [expression.right, rightResult],
  ];
  for (const [operand, result] of operands) {
    if (
      isStaticNonValue(result) &&
      !readsAsFallbackUndefined(operand, result, ctx, env)
    ) {
      return asOperandFailure(result);
    }
  }

  const left = isStaticNonValue(leftResult) ? undefined : leftResult;
  const right = isStaticNonValue(rightResult) ? undefined : rightResult;

  const comparesDistinctReferences =
    left !== right &&
    left !== null &&
    right !== null &&
    (typeof left === 'object' || typeof left === 'function') &&
    (typeof right === 'object' || typeof right === 'function');
  if (
    comparesDistinctReferences &&
    (expression.operator === '===' ||
      expression.operator === '!==' ||
      expression.operator === '==' ||
      expression.operator === '!=')
  ) {
    // Static export loading and local snapshot reconstruction can clone an
    // object graph. A false identity result is therefore not proof that the
    // runtime references are distinct.
    return unknownOutcome(UnknownReason.UnsupportedOperand);
  }

  switch (expression.operator) {
    case '===':
      return left === right;
    case '!==':
      return left !== right;
    case '==':
      if (!isCoercionFreePrimitive(left) || !isCoercionFreePrimitive(right)) {
        return unknownOutcome(UnknownReason.UnsupportedOperand);
      }
      // eslint-disable-next-line eqeqeq
      return left == right;
    case '!=':
      if (!isCoercionFreePrimitive(left) || !isCoercionFreePrimitive(right)) {
        return unknownOutcome(UnknownReason.UnsupportedOperand);
      }
      // eslint-disable-next-line eqeqeq
      return left != right;
    default:
      break;
  }

  if (expression.operator === '+') {
    if (typeof left === 'number' && typeof right === 'number') {
      return left + right;
    }

    if (
      (typeof left === 'string' || typeof left === 'number') &&
      (typeof right === 'string' || typeof right === 'number')
    ) {
      return `${left}${right}`;
    }
  }

  if (typeof left === 'number' && typeof right === 'number') {
    switch (expression.operator) {
      case '<':
        return left < right;
      case '<=':
        return left <= right;
      case '>':
        return left > right;
      case '>=':
        return left >= right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
        return left / right;
      case '%':
        return left % right;
      case '**':
        return left ** right;
      default:
        break;
    }
  }

  return unknownOutcome(UnknownReason.UnsupportedOperand);
};
