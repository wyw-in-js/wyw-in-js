export const MODULE_DEPRECATION_CODE = 'WYW_MODULE_DEPRECATED';

const MODULE_DEPRECATION_MESSAGE =
  '[wyw-in-js] `Module` from @wyw-in-js/transform is deprecated and will be removed in 3.0. ' +
  'It is a legacy in-process evaluator that transform() no longer uses; call transform() instead.';

// Process-wide by design: the deprecation is reported once per process.
let warned = false;

export function warnModuleDeprecation(): void {
  if (warned) {
    return;
  }

  warned = true;
  process.emitWarning(MODULE_DEPRECATION_MESSAGE, {
    code: MODULE_DEPRECATION_CODE,
    type: 'DeprecationWarning',
  });
}
