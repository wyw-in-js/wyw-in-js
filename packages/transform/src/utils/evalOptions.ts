import type { EvalOptionsV2, StrictOptions } from '@wyw-in-js/shared';

/**
 * Defaults for the eval options that are read without `loadWywOptions`
 * (tests, direct `transform` callers). `loadWywOptions` spreads the same
 * values, so a missing option means the same thing on every path.
 */
export const DEFAULT_EVAL_OPTIONS: Readonly<
  Required<Pick<EvalOptionsV2, 'errors' | 'require' | 'resolver'>>
> = {
  errors: 'strict',
  require: 'warn-and-run',
  resolver: 'bundler',
};

export const getEvalOptions = (services: {
  options: { pluginOptions: Pick<StrictOptions, 'eval'> };
}): EvalOptionsV2 => ({
  ...DEFAULT_EVAL_OPTIONS,
  ...(services.options.pluginOptions.eval ?? {}),
});
