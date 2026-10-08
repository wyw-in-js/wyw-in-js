import type { CallExpression, Node } from 'oxc-parser';

import { isOxcFunctionLike } from '../oxc/runtimeSemantics';
import { lookupStaticBinding } from './staticBindings';
import { resolveBindingAt } from './scopeAnalysis';
import {
  hasDirectBindingMutationBefore,
  hasStringPrototypeMutationBefore,
  isDestructuringProjection,
} from './staticEvaluationSafety';
import {
  asOperandFailure,
  isStaticNonValue,
  unknownOutcome,
  UnknownReason,
  type StaticNonValue,
  type StaticResult,
} from './staticOutcome';
import { isStaticProxy } from './staticValues';
import {
  evaluateFunctionCall,
  evaluateNumberConversion,
  evaluateStaticPropertyKey,
  evaluateStringConversion,
  isOxcStaticCallableValue,
  isOxcStaticFunctionValue,
  oxcStaticFunctionNode,
  unwrapOxcStaticCallableValue,
  type EvalEnv,
  type EvaluateStatic,
  type EvaluationStack,
} from './staticEvaluationRuntime';
import type { ExtractionContext } from './types';

const evaluateArguments = (
  expression: CallExpression,
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: EvaluationStack,
  evaluateStatic: EvaluateStatic
): unknown[] | StaticNonValue => {
  const args: unknown[] = [];
  for (const argument of expression.arguments) {
    if (argument.type === 'SpreadElement') {
      return unknownOutcome(UnknownReason.UnsupportedSyntax);
    }

    const value = evaluateStatic(argument, ctx, env, stack);
    if (isStaticNonValue(value)) {
      return asOperandFailure(value);
    }
    args.push(value);
  }

  return args;
};

const callStaticHelper = (helper: unknown, args: unknown[]): StaticResult => {
  try {
    return (helper as (...a: unknown[]) => unknown)(...args);
  } catch {
    return unknownOutcome(UnknownReason.EvaluationError);
  }
};

/**
 * Calls the evaluator models: destructuring projections, local functions,
 * static helpers, `String`/`Number`/`Boolean`, `Math.round` and string case
 * conversion.
 */
export const evaluateStaticCall = (
  expression: CallExpression,
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: EvaluationStack,
  evaluateStatic: EvaluateStatic
): StaticResult => {
  let inlineCallee: Node = expression.callee;
  while (
    inlineCallee.type === 'ParenthesizedExpression' ||
    inlineCallee.type === 'TSAsExpression' ||
    inlineCallee.type === 'TSSatisfiesExpression' ||
    inlineCallee.type === 'TSNonNullExpression' ||
    inlineCallee.type === 'TSInstantiationExpression' ||
    inlineCallee.type === 'TSTypeAssertion'
  ) {
    inlineCallee = inlineCallee.expression as Node;
  }

  if (isDestructuringProjection(inlineCallee)) {
    const args = evaluateArguments(expression, ctx, env, stack, evaluateStatic);
    if (isStaticNonValue(args)) {
      return args;
    }

    return evaluateFunctionCall(
      inlineCallee,
      args,
      ctx,
      env,
      stack,
      evaluateStatic
    );
  }

  if (expression.callee.type === 'Identifier') {
    const binding = resolveBindingAt(
      ctx,
      expression.callee.name,
      expression.callee.start
    );
    const args = evaluateArguments(expression, ctx, env, stack, evaluateStatic);
    if (isStaticNonValue(args)) {
      return args;
    }

    if (
      binding &&
      hasDirectBindingMutationBefore(binding, expression.start, ctx)
    ) {
      return unknownOutcome(UnknownReason.Mutation);
    }

    const staticCallable = env.get(expression.callee.name);
    if (isOxcStaticFunctionValue(staticCallable)) {
      return evaluateFunctionCall(
        staticCallable[oxcStaticFunctionNode],
        args,
        ctx,
        env,
        stack,
        evaluateStatic
      );
    }
    if (
      isOxcStaticCallableValue(staticCallable) &&
      expression.arguments.length === 0
    ) {
      return unwrapOxcStaticCallableValue(staticCallable);
    }

    // Plain function in env (e.g. supplied via staticBindings as a
    // pure helper). Invoke with already-evaluated args.
    if (
      typeof staticCallable === 'function' &&
      !isStaticProxy(staticCallable)
    ) {
      return callStaticHelper(staticCallable, args);
    }

    const canUseIntrinsic = !binding && !env.has(expression.callee.name);
    if (canUseIntrinsic && args.length === 1) {
      switch (expression.callee.name) {
        case 'String':
          return evaluateStringConversion(args[0]);
        case 'Number':
          return evaluateNumberConversion(args[0]);
        case 'Boolean':
          return Boolean(args[0]);
        default:
          break;
      }
    }

    // staticBindings can register a pure helper for an imported name
    // (e.g. linaria's `cx` from '@linaria/core'). When the callee
    // resolves to such an import and every arg evaluated, invoke the
    // helper and return its result as a static value.
    if (binding?.importedFrom) {
      const override = lookupStaticBinding(
        ctx.staticBindings,
        binding.importedFrom,
        binding.imported
      );
      if (override.found && typeof override.value === 'function') {
        return callStaticHelper(override.value, args);
      }
    }

    const fn = binding?.functionNode ?? binding?.declarator?.init;
    if (fn && isOxcFunctionLike(fn)) {
      return evaluateFunctionCall(fn, args, ctx, env, stack, evaluateStatic);
    }
  }

  if (expression.callee.type === 'MemberExpression') {
    if (
      !expression.callee.computed &&
      expression.callee.object.type === 'Identifier' &&
      expression.callee.object.name === 'Math' &&
      !resolveBindingAt(
        ctx,
        expression.callee.object.name,
        expression.callee.object.start
      ) &&
      expression.callee.property.type === 'Identifier' &&
      expression.callee.property.name === 'round' &&
      expression.arguments.length === 1
    ) {
      const [argument] = expression.arguments;
      if (argument?.type !== 'SpreadElement') {
        const value = evaluateStatic(argument, ctx, env, stack);
        if (typeof value === 'number') {
          return Math.round(value);
        }
      }
    }

    const objectValue = evaluateStatic(
      expression.callee.object,
      ctx,
      env,
      stack
    );
    const key = evaluateStaticPropertyKey(
      expression.callee.property,
      expression.callee.computed,
      ctx,
      env,
      stack,
      evaluateStatic
    );
    if (
      typeof objectValue === 'string' &&
      (key === 'toLowerCase' || key === 'toUpperCase') &&
      expression.arguments.length === 0 &&
      !hasStringPrototypeMutationBefore(ctx.currentExpressionStart, ctx)
    ) {
      return key === 'toLowerCase'
        ? objectValue.toLowerCase()
        : objectValue.toUpperCase();
    }
  }

  return unknownOutcome(UnknownReason.UnsupportedSyntax);
};
