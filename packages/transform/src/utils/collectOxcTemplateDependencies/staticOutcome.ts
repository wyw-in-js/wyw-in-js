import { isStaticProxy } from './staticValues';

/**
 * Why the static evaluator could not determine a value.
 */
export enum UnknownReason {
  /** A `process.env` read. Fallback positions read it as `undefined`. */
  BuildTimeEnvironment = 'build-time-environment',
  /** A static helper or an object construction threw. */
  EvaluationError = 'evaluation-error',
  /** A parameter read outside of a modeled call. */
  FunctionParameter = 'function-parameter',
  /** An import without a static value; it needs cross-file resolution. */
  ImportedBinding = 'imported-binding',
  /** The property is not an own data property and may come from a prototype. */
  MissingProperty = 'missing-property',
  /** The binding or one of its sources changes before the read. */
  Mutation = 'mutation',
  /**
   * A `var` read before its declaration. Interpolations are evaluated at the
   * end of the module, so the value is the one the declaration assigns.
   */
  ReadBeforeDeclaration = 'read-before-declaration',
  /** An operand is a runtime-only value. */
  OpaqueOperand = 'opaque-operand',
  /** The evaluation depends on itself. */
  Recursion = 'recursion',
  /** A lexical binding is read before its initialization. */
  TemporalDeadZone = 'temporal-dead-zone',
  /** The identifier has no binding, so it is a runtime global. */
  UnresolvedBinding = 'unresolved-binding',
  /** The binding has no initializer the evaluator models. */
  UnsupportedBinding = 'unsupported-binding',
  /** The operation would need coercion, user code or an unmodeled operand. */
  UnsupportedOperand = 'unsupported-operand',
  /** The syntax, operator or call shape is not modeled. */
  UnsupportedSyntax = 'unsupported-syntax',
}

/**
 * Why a value exists only at runtime.
 */
export enum OpaqueReason {
  /** A function or arrow expression. The evaluator does not model closures. */
  FunctionExpression = 'function-expression',
  /** A callable value the evaluator holds, such as a declared function. */
  FunctionValue = 'function-value',
  /** A proxy. Any access may run user code. */
  Proxy = 'proxy',
}

export type KnownStaticOutcome = Readonly<{
  kind: 'known';
  value: unknown;
}>;

export type UnknownStaticOutcome = Readonly<{
  kind: 'unknown';
  reason: UnknownReason;
}>;

export type OpaqueRuntimeStaticOutcome = Readonly<{
  kind: 'opaque-runtime';
  reason: OpaqueReason;
}>;

/**
 * The result of statically evaluating an expression. `known(undefined)` is a
 * value like any other; it never means "could not evaluate".
 */
export type StaticOutcome =
  | KnownStaticOutcome
  | OpaqueRuntimeStaticOutcome
  | UnknownStaticOutcome;

/**
 * Outcomes that carry no value.
 */
export type StaticNonValue = OpaqueRuntimeStaticOutcome | UnknownStaticOutcome;

/**
 * What the evaluator passes between its own steps: either the known value
 * itself (unboxed) or a non-value outcome.
 */
export type StaticResult = unknown;

const createNonValues = <TReason extends string, TOutcome>(
  reasons: Record<string, TReason>,
  create: (reason: TReason) => TOutcome
): Record<TReason, TOutcome> =>
  Object.fromEntries(
    Object.values(reasons).map((reason) => [
      reason,
      // No prototype: a non-value that leaked into value code is never
      // mistaken for a plain object.
      Object.freeze(Object.assign(Object.create(null), create(reason))),
    ])
  ) as Record<TReason, TOutcome>;

const unknownOutcomes = createNonValues<UnknownReason, UnknownStaticOutcome>(
  UnknownReason,
  (reason) => ({ kind: 'unknown', reason })
);

const opaqueRuntimeOutcomes = createNonValues<
  OpaqueReason,
  OpaqueRuntimeStaticOutcome
>(OpaqueReason, (reason) => ({ kind: 'opaque-runtime', reason }));

// Identity lookup: unlike property reads, it never reaches a proxy trap.
const nonValues: ReadonlySet<unknown> = new Set<unknown>([
  ...Object.values(unknownOutcomes),
  ...Object.values(opaqueRuntimeOutcomes),
]);

export const known = (value: unknown): KnownStaticOutcome => ({
  kind: 'known',
  value,
});

export const unknownOutcome = (reason: UnknownReason): UnknownStaticOutcome =>
  unknownOutcomes[reason];

export const opaqueRuntime = (
  reason: OpaqueReason
): OpaqueRuntimeStaticOutcome => opaqueRuntimeOutcomes[reason];

export const isStaticNonValue = (
  result: StaticResult
): result is StaticNonValue => nonValues.has(result);

/**
 * A non-value used as an operand makes the operation unknown. Only a
 * position whose value is the operand itself keeps it opaque.
 */
export const asOperandFailure = (
  nonValue: StaticNonValue
): UnknownStaticOutcome =>
  nonValue.kind === 'unknown'
    ? nonValue
    : unknownOutcome(UnknownReason.OpaqueOperand);

/**
 * Whether the result is an unknown that the legacy fallback rules read as
 * `undefined` in some positions: a build-time `process.env` read or a `var`
 * read before its declaration. The rules live in `readsAsFallbackUndefined`.
 */
export const isFallbackUndefinedRead = (result: StaticResult): boolean =>
  result === unknownOutcomes[UnknownReason.BuildTimeEnvironment] ||
  result === unknownOutcomes[UnknownReason.ReadBeforeDeclaration];

export const toStaticOutcome = (result: StaticResult): StaticOutcome => {
  if (isStaticNonValue(result)) {
    return result;
  }

  if (isStaticProxy(result)) {
    return opaqueRuntime(OpaqueReason.Proxy);
  }

  if (typeof result === 'function') {
    return opaqueRuntime(OpaqueReason.FunctionValue);
  }

  return known(result);
};

/**
 * The pre-outcome contract: `undefined` stands for every non-value, and
 * function or proxy values are returned as they are.
 */
export const toLegacyStaticValue = (result: StaticResult): unknown =>
  isStaticNonValue(result) ? undefined : result;

/**
 * Whether the outcome denotes an existing runtime object, so a consumer has
 * to keep the reference instead of a copy. A function expression is not
 * modeled as a value, so there is no identity to keep.
 */
export const hasStaticRuntimeIdentity = (outcome: StaticOutcome): boolean => {
  if (outcome.kind === 'known') {
    return typeof outcome.value === 'object' && outcome.value !== null;
  }

  return (
    outcome.kind === 'opaque-runtime' &&
    outcome.reason !== OpaqueReason.FunctionExpression
  );
};
