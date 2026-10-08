/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { Expression, Node } from 'oxc-parser';

import {
  collectOxcPatternBindingNames,
  collectOxcPatternRuntimeExpressions,
} from '../oxc/patterns';
import { isOxcFunctionLike } from '../oxc/runtimeSemantics';
import { lookupStaticBinding } from './staticBindings';
import { isReadOnlyOpaqueFunction } from './staticFunctionPurity';
import {
  hasBindingMutationBefore,
  hasBindingMutationHazardBetween,
  hasReferencedRootMutationBetween,
  hasReferencedRootMutationHazardBefore,
} from './staticMutationChecks';
import * as timeline from './mutationTimeline';
import * as recursiveProof from './recursiveProof';
import { resolveBindingAt } from './scopeAnalysis';
import {
  getBindingDirectTimeline,
  getBindingHazardTimeline,
  hasLexicalPreDeclarationChange,
  isPatternRuntimeExpressionStable,
  isProcessEnvValueAccess,
  mutationDirectlyTargetsBinding,
  readsAsFallbackUndefined,
} from './staticEvaluationSafety';
import {
  cloneStaticValue,
  copyEnumerableOwnDataProperties,
  defineStaticDataProperty,
  isStaticProxy,
  readObjectMember,
} from './staticValues';
import {
  asOperandFailure,
  isFallbackUndefinedRead,
  isStaticNonValue,
  opaqueRuntime,
  OpaqueReason,
  toStaticOutcome,
  unknownOutcome,
  UnknownReason,
  type StaticOutcome,
  type StaticResult,
} from './staticOutcome';
import {
  appendDefaultArrayElements,
  applyRootMutation,
  assignPatternValue,
  bindingValueCacheKey,
  bitwiseNot,
  createOxcStaticFunctionValue,
  evaluateBinary,
  evaluateKnownObjectMember,
  evaluateStaticPropertyKey,
  uninitializedStaticBinding,
  unwrapOxcStaticCallableValue,
  type EvalEnv,
  type EvaluationStack,
} from './staticEvaluationRuntime';
import { evaluateStaticCall } from './staticCallEvaluation';
import type { ExtractionContext } from './types';

export { createOxcStaticCallableValue } from './staticEvaluationRuntime';

export const isKnownPureStaticCall = (
  node: Node,
  ctx: ExtractionContext,
  env?: EvalEnv
): boolean => {
  // Tagged templates are classified more precisely by the destructuring
  // projection gate. Treating them as ordinary binding mutations here would
  // make one processor template invalidate every later use of the tag.
  if (node.type === 'TaggedTemplateExpression') {
    return true;
  }

  if (
    node.type === 'CallExpression' &&
    ctx.processorManagedExpressionSpans.has(`${node.start}:${node.end}`)
  ) {
    return true;
  }

  if (
    (node.type === 'CallExpression' || node.type === 'NewExpression') &&
    ctx.pureAnnotatedInvocationSpans.has(`${node.start}:${node.end}`)
  ) {
    return true;
  }

  if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') {
    return false;
  }

  const binding = resolveBindingAt(ctx, node.callee.name, node.callee.start);
  if (binding?.importedFrom) {
    const override = lookupStaticBinding(
      ctx.staticBindings,
      binding.importedFrom,
      binding.imported
    );
    return override.found && typeof override.value === 'function';
  }

  const fn = binding?.functionNode ?? binding?.declarator?.init;
  if (
    !fn ||
    !isOxcFunctionLike(fn) ||
    (binding?.declarator && binding.declarator.end > node.start) ||
    node.arguments.some((argument) => argument.type === 'SpreadElement')
  ) {
    return false;
  }

  // An opaque return value is distinct from an impure invocation. A helper
  // that only returns a direct read cannot mutate sibling imports.
  if (isReadOnlyOpaqueFunction(fn)) {
    return true;
  }

  const proofEnv = env ?? new Map();
  const proofState =
    proofEnv.size === 0
      ? ctx.staticCallProof
      : recursiveProof.partial(ctx.staticCallProof);
  return recursiveProof.run(node, proofState, () => {
    const proofCtx: ExtractionContext = {
      ...ctx,
      currentExpressionStart: node.start,
      rootMutationHazardsByBinding: timeline.withoutTimelineMapNode(
        ctx.rootMutationHazardsByBinding,
        node
      ),
      staticCallProof: recursiveProof.partial(ctx.staticCallProof),
    };
    const isScalar = (value: unknown): boolean =>
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint';
    const argumentsAreScalar = node.arguments.every(
      (argument) =>
        argument.type !== 'SpreadElement' &&
        isScalar(evaluateStatic(argument, proofCtx, proofEnv))
    );

    return (
      argumentsAreScalar && isScalar(evaluateStatic(node, proofCtx, proofEnv))
    );
  });
};

/**
 * Evaluator core: returns the known value itself or a non-value outcome from
 * `staticOutcome`. `undefined` is a known value here, never a failure.
 */
export const evaluateStatic = (
  expression: Expression,
  ctx: ExtractionContext,
  env: EvalEnv = new Map(),
  stack: EvaluationStack = []
): StaticResult => {
  if (
    expression.type === 'TSAsExpression' ||
    expression.type === 'TSSatisfiesExpression' ||
    expression.type === 'TSNonNullExpression' ||
    expression.type === 'TSInstantiationExpression' ||
    expression.type === 'TSTypeAssertion' ||
    expression.type === 'ParenthesizedExpression'
  ) {
    return evaluateStatic(expression.expression as Expression, ctx, env, stack);
  }

  if (expression.type === 'Literal') {
    return expression.value;
  }

  if (
    expression.type === 'ArrowFunctionExpression' ||
    expression.type === 'FunctionExpression'
  ) {
    return opaqueRuntime(OpaqueReason.FunctionExpression);
  }

  if (expression.type === 'UnaryExpression') {
    if (expression.operator === 'void') {
      return undefined;
    }

    if (expression.operator === 'typeof') {
      // `typeof someIdentifier` is the canonical undeclared-global
      // probe — it returns 'undefined' regardless of whether the
      // symbol is declared. Only fold truly unbound identifiers: declared
      // but dynamic locals still have runtime values we cannot infer.
      const argIsUnboundBareIdentifier =
        expression.argument.type === 'Identifier' &&
        !resolveBindingAt(
          ctx,
          expression.argument.name,
          expression.argument.start
        );
      const argument = expression.argument as Expression;
      const arg = evaluateStatic(argument, ctx, env, stack);
      if (!isStaticNonValue(arg)) {
        return typeof arg;
      }

      return argIsUnboundBareIdentifier ||
        readsAsFallbackUndefined(argument, arg, ctx, env)
        ? 'undefined'
        : asOperandFailure(arg);
    }

    const arg = evaluateStatic(
      expression.argument as Expression,
      ctx,
      env,
      stack
    );
    if (isStaticNonValue(arg)) {
      return asOperandFailure(arg);
    }

    switch (expression.operator) {
      case '-':
        return typeof arg === 'number'
          ? -arg
          : unknownOutcome(UnknownReason.UnsupportedOperand);
      case '+':
        return typeof arg === 'number'
          ? +arg
          : unknownOutcome(UnknownReason.UnsupportedOperand);
      case '!':
        return !arg;
      case '~':
        return typeof arg === 'number'
          ? bitwiseNot(arg)
          : unknownOutcome(UnknownReason.UnsupportedOperand);
      default:
        return unknownOutcome(UnknownReason.UnsupportedSyntax);
    }
  }

  if (expression.type === 'LogicalExpression') {
    const leftResult = evaluateStatic(expression.left, ctx, env, stack);
    // A non-value never selects a branch, except the reads that the legacy
    // fallback rules count as `undefined` (see readsAsFallbackUndefined).
    if (
      isStaticNonValue(leftResult) &&
      !readsAsFallbackUndefined(expression.left, leftResult, ctx, env)
    ) {
      return asOperandFailure(leftResult);
    }
    const left = isStaticNonValue(leftResult) ? undefined : leftResult;

    if (expression.operator === '||') {
      return left || evaluateStatic(expression.right, ctx, env, stack);
    }

    if (expression.operator === '??') {
      return left ?? evaluateStatic(expression.right, ctx, env, stack);
    }

    if (expression.operator === '&&') {
      return left && evaluateStatic(expression.right, ctx, env, stack);
    }

    return unknownOutcome(UnknownReason.UnsupportedSyntax);
  }

  if (expression.type === 'ConditionalExpression') {
    const test = evaluateStatic(expression.test, ctx, env, stack);
    if (isStaticNonValue(test)) {
      return asOperandFailure(test);
    }

    return evaluateStatic(
      test ? expression.consequent : expression.alternate,
      ctx,
      env,
      stack
    );
  }

  if (expression.type === 'TemplateLiteral') {
    let result = '';

    for (let idx = 0; idx < expression.quasis.length; idx += 1) {
      result += expression.quasis[idx]?.value.cooked ?? '';

      const nextExpression = expression.expressions[idx];
      if (!nextExpression) {
        continue;
      }

      const value = evaluateStatic(nextExpression, ctx, env, stack);
      if (isStaticNonValue(value)) {
        return asOperandFailure(value);
      }
      if (typeof value !== 'string' && typeof value !== 'number') {
        return unknownOutcome(UnknownReason.UnsupportedOperand);
      }

      result += String(value);
    }

    return result;
  }

  if (expression.type === 'Identifier') {
    const binding = resolveBindingAt(ctx, expression.name, expression.start);
    if (
      binding?.kind === 'variable' &&
      binding.declarator &&
      ctx.currentExpressionStart < binding.declarator.end
    ) {
      // Read before the declaration completes. A modeled call environment
      // only vouches for `undefined`. A `var` is left to evaluation, which
      // sees the value at the end of the module.
      if (env.has(expression.name)) {
        const envValue = env.get(expression.name);
        return envValue === undefined || isFallbackUndefinedRead(envValue)
          ? envValue
          : unknownOutcome(UnknownReason.TemporalDeadZone);
      }

      return unknownOutcome(
        binding.declarationKind === 'var'
          ? UnknownReason.ReadBeforeDeclaration
          : UnknownReason.TemporalDeadZone
      );
    }

    if (env.has(expression.name)) {
      const envValue = env.get(expression.name);
      if (envValue === uninitializedStaticBinding) {
        return unknownOutcome(UnknownReason.TemporalDeadZone);
      }

      if (
        binding?.importedFrom &&
        hasBindingMutationBefore(
          binding,
          ctx.currentExpressionStart,
          ctx,
          env,
          isKnownPureStaticCall
        )
      ) {
        return unknownOutcome(UnknownReason.Mutation);
      }

      return unwrapOxcStaticCallableValue(envValue);
    }

    if (binding?.importedFrom) {
      if (
        hasBindingMutationBefore(
          binding,
          ctx.currentExpressionStart,
          ctx,
          env,
          isKnownPureStaticCall
        )
      ) {
        return unknownOutcome(UnknownReason.Mutation);
      }

      // staticBindings can supply a literal value for an imported name,
      // bypassing whatever the source module would otherwise resolve to.
      // Function values are deferred to the CallExpression branch.
      const override = lookupStaticBinding(
        ctx.staticBindings,
        binding.importedFrom,
        binding.imported
      );
      if (override.found && typeof override.value !== 'function') {
        return override.value;
      }
      return unknownOutcome(UnknownReason.ImportedBinding);
    }
    if (!binding) {
      return expression.name === 'undefined'
        ? undefined
        : unknownOutcome(UnknownReason.UnresolvedBinding);
    }

    if (binding.kind === 'param') {
      return unknownOutcome(UnknownReason.FunctionParameter);
    }

    const bindingMutations = getBindingDirectTimeline(binding, ctx);
    const bindingMutationHazards = getBindingHazardTimeline(binding, ctx);
    const bindingHasChanges =
      bindingMutations.byStart.length > 0 ||
      bindingMutationHazards.byStart.length > 0;

    if (
      bindingHasChanges &&
      hasLexicalPreDeclarationChange(
        binding,
        ctx,
        bindingMutations,
        bindingMutationHazards
      )
    ) {
      return unknownOutcome(UnknownReason.Mutation);
    }

    const { declarator } = binding;
    const init = declarator?.init;
    const valueCacheKey = init
      ? bindingValueCacheKey(
          binding,
          ctx,
          bindingMutations,
          bindingMutationHazards,
          (hazard, proofCtx) => isKnownPureStaticCall(hazard, proofCtx, env)
        )
      : null;
    if (valueCacheKey && env.has(valueCacheKey)) {
      return env.get(valueCacheKey);
    }

    if (stack.includes(binding.name)) {
      return unknownOutcome(UnknownReason.Recursion);
    }

    let value: StaticResult = unknownOutcome(UnknownReason.UnsupportedBinding);
    if (init) {
      const nextStack = [...stack, binding.name];
      if (declarator.id.type === 'Identifier') {
        if (
          hasReferencedRootMutationHazardBefore(
            init,
            ctx.currentExpressionStart,
            ctx,
            declarator,
            env,
            isKnownPureStaticCall
          )
        ) {
          return unknownOutcome(UnknownReason.Mutation);
        }
        value = evaluateStatic(init, ctx, env, nextStack);
      } else {
        if (
          binding.declarationKind !== 'const' ||
          expression.start < declarator.end
        ) {
          return unknownOutcome(UnknownReason.UnsupportedBinding);
        }
        if (
          hasReferencedRootMutationHazardBefore(
            init,
            declarator.start,
            ctx,
            undefined,
            env,
            isKnownPureStaticCall
          )
        ) {
          return unknownOutcome(UnknownReason.Mutation);
        }

        const snapshotCtx: ExtractionContext = {
          ...ctx,
          currentExpressionStart: declarator.start,
        };
        const patternRuntimeExpressions = collectOxcPatternRuntimeExpressions(
          declarator.id
        );
        if (
          patternRuntimeExpressions.some(
            (runtimeExpression) =>
              !isPatternRuntimeExpressionStable(
                runtimeExpression,
                declarator,
                snapshotCtx,
                env
              ) ||
              hasReferencedRootMutationHazardBefore(
                runtimeExpression,
                declarator.start,
                ctx,
                undefined,
                env,
                isKnownPureStaticCall
              )
          )
        ) {
          return unknownOutcome(UnknownReason.Mutation);
        }

        const initialValue = evaluateStatic(init, snapshotCtx, env, nextStack);
        if (isStaticNonValue(initialValue)) {
          return asOperandFailure(initialValue);
        }

        const patternBindingNames = collectOxcPatternBindingNames(
          declarator.id
        );
        const patternEnv = new Map(env);
        patternBindingNames.forEach((name) => {
          patternEnv.set(name, uninitializedStaticBinding);
        });
        if (
          !assignPatternValue(
            declarator.id,
            initialValue,
            snapshotCtx,
            patternEnv,
            nextStack,
            evaluateStatic
          ) ||
          !patternEnv.has(binding.name)
        ) {
          return unknownOutcome(UnknownReason.UnsupportedOperand);
        }

        value = patternEnv.get(binding.name);
        const sourceChangedAfterDestructuring =
          hasReferencedRootMutationBetween(
            init,
            declarator.end,
            ctx.currentExpressionStart,
            ctx,
            env,
            isKnownPureStaticCall
          ) ||
          patternRuntimeExpressions.some((runtimeExpression) =>
            hasReferencedRootMutationBetween(
              runtimeExpression,
              declarator.end,
              ctx.currentExpressionStart,
              ctx,
              env,
              isKnownPureStaticCall
            )
          );
        if (
          typeof value === 'object' &&
          value !== null &&
          (sourceChangedAfterDestructuring ||
            hasBindingMutationHazardBetween(
              binding,
              declarator.end,
              ctx.currentExpressionStart,
              ctx,
              env,
              isKnownPureStaticCall
            ))
        ) {
          return unknownOutcome(UnknownReason.Mutation);
        }

        patternBindingNames.forEach((name) => {
          const siblingBinding = ctx.bindingIndex.bindingsByName
            .get(name)
            ?.find((candidate) => candidate.declarator === declarator);
          const siblingValue = patternEnv.get(name);
          const siblingHasChanges =
            !!siblingBinding &&
            (getBindingDirectTimeline(siblingBinding, ctx).byStart.length > 0 ||
              getBindingHazardTimeline(siblingBinding, ctx).byStart.length > 0);
          if (
            siblingBinding &&
            patternEnv.has(name) &&
            !siblingHasChanges &&
            !(
              typeof siblingValue === 'object' &&
              siblingValue !== null &&
              sourceChangedAfterDestructuring
            )
          ) {
            env.set(
              bindingValueCacheKey(
                siblingBinding,
                ctx,
                undefined,
                undefined,
                (hazard, proofCtx) =>
                  isKnownPureStaticCall(hazard, proofCtx, env)
              ),
              siblingValue
            );
          }
        });
      }
    } else if (binding.functionNode) {
      value = createOxcStaticFunctionValue(binding.functionNode);
    }

    if (isStaticNonValue(value)) {
      return bindingHasChanges && value.kind === 'opaque-runtime'
        ? unknownOutcome(UnknownReason.Mutation)
        : value;
    }

    if (!bindingHasChanges) {
      if (valueCacheKey) {
        env.set(valueCacheKey, value);
      }
      return value;
    }

    const hasPriorMutations = timeline.hasTimelineStartBefore(
      bindingMutations,
      ctx.currentExpressionStart
    );
    const isUnreplayedPriorHazard = (hazard: Node): boolean =>
      !isKnownPureStaticCall(hazard, ctx, env) &&
      !timeline.timelineStartBeforeIncludes(
        bindingMutations,
        ctx.currentExpressionStart,
        hazard
      );
    if (
      (typeof value !== 'object' || value === null) &&
      (hasPriorMutations ||
        timeline.someTimelineEndAtOrBefore(
          bindingMutationHazards,
          ctx.currentExpressionStart,
          (hazard) =>
            isUnreplayedPriorHazard(hazard) &&
            mutationDirectlyTargetsBinding(hazard, binding, ctx)
        ))
    ) {
      return unknownOutcome(UnknownReason.Mutation);
    }

    if (
      typeof value === 'object' &&
      value !== null &&
      declarator?.id.type === 'Identifier' &&
      timeline.someTimelineEndAtOrBefore(
        bindingMutationHazards,
        ctx.currentExpressionStart,
        isUnreplayedPriorHazard
      )
    ) {
      return unknownOutcome(UnknownReason.Mutation);
    }

    if (binding.isRoot && typeof value === 'object' && value !== null) {
      if (!hasPriorMutations) {
        if (valueCacheKey) {
          env.set(valueCacheKey, value);
        }
        return value;
      }

      // An object value clones to `undefined` only when it is unsafe to copy.
      let nextValue: StaticResult = cloneStaticValue(value);
      if (nextValue === undefined) {
        return unknownOutcome(UnknownReason.UnsupportedOperand);
      }
      timeline.forEachTimelineStartBefore(
        bindingMutations,
        ctx.currentExpressionStart,
        (mutation) => {
          if (!isStaticNonValue(nextValue)) {
            nextValue = applyRootMutation(
              binding.name,
              nextValue,
              mutation,
              ctx,
              env,
              [...stack, binding.name],
              evaluateStatic
            );
          }
        }
      );
      if (isStaticNonValue(nextValue)) {
        return nextValue;
      }

      if (valueCacheKey) {
        env.set(valueCacheKey, nextValue);
      }
      return nextValue;
    }

    if (valueCacheKey) {
      env.set(valueCacheKey, value);
    }
    return value;
  }

  if (expression.type === 'ObjectExpression') {
    const result: Record<string, unknown> = {};

    for (const property of expression.properties) {
      if (property.type === 'SpreadElement') {
        const spreadValue = evaluateStatic(property.argument, ctx, env, stack);
        if (isStaticNonValue(spreadValue)) {
          return asOperandFailure(spreadValue);
        }
        if (
          typeof spreadValue !== 'object' ||
          spreadValue === null ||
          !copyEnumerableOwnDataProperties(result, spreadValue)
        ) {
          return unknownOutcome(UnknownReason.UnsupportedOperand);
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
        return unknownOutcome(UnknownReason.UnsupportedOperand);
      }

      const value = evaluateStatic(property.value, ctx, env, stack);
      if (isStaticNonValue(value)) {
        return asOperandFailure(value);
      }

      const isPrototypeSetter =
        !property.computed &&
        !property.shorthand &&
        !property.method &&
        key === '__proto__';
      if (isPrototypeSetter) {
        if ((typeof value === 'object' && value !== null) || value === null) {
          try {
            Object.setPrototypeOf(result, value);
          } catch {
            return unknownOutcome(UnknownReason.EvaluationError);
          }
        }
        continue;
      }

      if (!defineStaticDataProperty(result, key, value)) {
        return unknownOutcome(UnknownReason.EvaluationError);
      }
    }

    return result;
  }

  if (expression.type === 'ArrayExpression') {
    const result: unknown[] = [];

    for (const element of expression.elements) {
      if (!element) {
        return unknownOutcome(UnknownReason.UnsupportedSyntax);
      }

      if (element.type === 'SpreadElement') {
        const spreadValue = evaluateStatic(element.argument, ctx, env, stack);
        if (isStaticNonValue(spreadValue)) {
          return asOperandFailure(spreadValue);
        }
        if (
          isStaticProxy(spreadValue) ||
          !Array.isArray(spreadValue) ||
          !appendDefaultArrayElements(result, spreadValue, ctx)
        ) {
          return unknownOutcome(UnknownReason.UnsupportedOperand);
        }
        continue;
      }

      const value = evaluateStatic(element, ctx, env, stack);
      if (isStaticNonValue(value)) {
        return asOperandFailure(value);
      }

      result.push(value);
    }

    return result;
  }

  if (expression.type === 'MemberExpression') {
    if (isProcessEnvValueAccess(expression, ctx, env)) {
      // Treat process.env.X as undefined at build time (see
      // readsAsFallbackUndefined). Reading from real process.env would
      // couple the bundle to whatever happens to be set on the build machine;
      // falling back to the ?? / || branch (or a runtime read) is more
      // predictable.
      return unknownOutcome(UnknownReason.BuildTimeEnvironment);
    }

    const key = evaluateStaticPropertyKey(
      expression.property,
      expression.computed,
      ctx,
      env,
      stack,
      evaluateStatic
    );
    if (key === null) {
      return unknownOutcome(UnknownReason.UnsupportedOperand);
    }

    const knownObjectMember = evaluateKnownObjectMember(
      expression.object as Expression,
      key,
      ctx,
      env,
      stack,
      evaluateStatic
    );
    if (!isStaticNonValue(knownObjectMember)) {
      return knownObjectMember;
    }

    const objectValue = evaluateStatic(expression.object, ctx, env, stack);
    if (isStaticNonValue(objectValue)) {
      return asOperandFailure(objectValue);
    }

    const member = readObjectMember(objectValue, key);
    if (!member.safe) {
      return unknownOutcome(UnknownReason.UnsupportedOperand);
    }

    return member.found
      ? member.value
      : unknownOutcome(UnknownReason.MissingProperty);
  }

  if (expression.type === 'NewExpression') {
    if (
      expression.callee.type !== 'Identifier' ||
      expression.arguments.length !== 1
    ) {
      return unknownOutcome(UnknownReason.UnsupportedSyntax);
    }

    const [argument] = expression.arguments;
    if (!argument || argument.type === 'SpreadElement') {
      return unknownOutcome(UnknownReason.UnsupportedSyntax);
    }

    if (
      env.has(expression.callee.name) ||
      resolveBindingAt(ctx, expression.callee.name, expression.callee.start)
    ) {
      return unknownOutcome(UnknownReason.UnsupportedSyntax);
    }

    // Wrapper constructors produce identity-bearing objects. Returning the
    // primitive conversion here changes both value identity and `typeof`, and
    // converting an object argument could execute user coercion hooks.
    return unknownOutcome(UnknownReason.UnsupportedOperand);
  }

  if (expression.type === 'CallExpression') {
    return evaluateStaticCall(expression, ctx, env, stack, evaluateStatic);
  }

  return evaluateBinary(expression, ctx, env, stack, evaluateStatic);
};

/**
 * The evaluator's interface: an explicit outcome instead of a value where
 * `undefined` also means "could not evaluate".
 */
export const evaluateStaticOutcome = (
  expression: Expression,
  ctx: ExtractionContext,
  env: EvalEnv = new Map()
): StaticOutcome => toStaticOutcome(evaluateStatic(expression, ctx, env));
