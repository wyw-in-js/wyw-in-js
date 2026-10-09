import type { EvalStrategy, StrictOptions } from '@wyw-in-js/shared';

export const DEFAULT_EVAL_STRATEGY: EvalStrategy = 'hybrid';

/**
 * The effective `eval.strategy` every stage has to agree on. `loadWywOptions`
 * fills in the default, but options can still reach the pipeline without it:
 * internal callers that build options by hand, or `eval: { strategy:
 * undefined }`, which the options merge keeps as an explicit `undefined`.
 */
export const getEvalStrategy = (
  options: Pick<StrictOptions, 'eval'>
): EvalStrategy => options.eval?.strategy ?? DEFAULT_EVAL_STRATEGY;

/** `hybrid` and `static` resolve provably static values without the evaluator. */
export const usesStaticEvaluation = (
  options: Pick<StrictOptions, 'eval'>
): boolean => getEvalStrategy(options) !== 'execute';
