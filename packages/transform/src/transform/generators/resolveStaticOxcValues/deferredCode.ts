import { deferOxcPreevalCode } from '../../../utils/oxcPreevalStage/deferredCode';
import { appendOxcWywPreval } from '../../../utils/oxcPreevalStage/prevalExport';
import type { IPreevalResult } from '../../Entrypoint.types';
import { toStaticWYWSelectorMetaValue } from './processorStaticModel';
import { pruneStaticPreevalCode } from './prune';

export const deferStaticPreevalCode = (
  result: IPreevalResult,
  filename: string,
  staticValueNames: Set<string>,
  staticImportLocals: Set<string>,
  staticExtendsHelperValues: Map<string, unknown>,
  sideEffectImportLocals: Set<string>
): void => {
  const semanticBaseCode = result.baseCode ?? result.code;
  const dependencyNames = [...(result.dependencyNames ?? [])];
  const valueNames = new Set(staticValueNames);
  const importLocals = new Set(staticImportLocals);
  const extendsHelperValues = new Map<string, unknown>();
  staticExtendsHelperValues.forEach((value, name) => {
    const metadata =
      value === null ? null : toStaticWYWSelectorMetaValue(value);
    if (value === null || metadata) {
      extendsHelperValues.set(name, metadata);
    }
  });
  const sideEffectLocals = new Set(sideEffectImportLocals);
  let code: string | undefined;
  const serializeCode = () => {
    code ??= appendOxcWywPreval(
      pruneStaticPreevalCode(
        semanticBaseCode,
        filename,
        valueNames,
        importLocals,
        extendsHelperValues,
        sideEffectLocals
      ),
      filename,
      dependencyNames
    );
    return code;
  };

  deferOxcPreevalCode(result, 'code', serializeCode);
  deferOxcPreevalCode(
    result,
    'evalCode',
    sideEffectLocals.size === 0
      ? serializeCode
      : () =>
          appendOxcWywPreval(
            pruneStaticPreevalCode(
              semanticBaseCode,
              filename,
              valueNames,
              importLocals,
              extendsHelperValues,
              new Set()
            ),
            filename,
            dependencyNames
          )
  );
};
