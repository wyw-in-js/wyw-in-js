import type { CodeRemoverOptions } from '@wyw-in-js/shared';

import {
  applyOxcEdits,
  type OxcEdit,
  type OxcEditRange,
} from './oxc/fileEdits';
import { collectDangerousCodeReplacementsWithOxc } from './oxcPreevalTransforms';

export type DangerousCodePlan = {
  runtimeOnlyProcessorSpans: OxcEditRange[];
  removedSpans: OxcEditRange[];
  replacements: OxcEdit[];
};

export const createDangerousCodePlanWithOxc = (
  code: string,
  filename: string,
  options?: CodeRemoverOptions,
  planningOptions?: {
    ignoredSpans?: OxcEditRange[];
    preserveImportMetaEnv?: boolean;
  }
): DangerousCodePlan => {
  const replacements = collectDangerousCodeReplacementsWithOxc(
    code,
    filename,
    options,
    planningOptions
  );

  return {
    removedSpans: replacements.map(({ end, start }) => ({ end, start })),
    replacements,
    runtimeOnlyProcessorSpans: replacements
      .filter((replacement) => replacement.kind === 'component')
      .map(({ end, start }) => ({ end, start })),
  };
};

export const removeDangerousCodeWithOxc = (
  code: string,
  filename: string,
  options?: CodeRemoverOptions
): string =>
  applyOxcEdits(
    code,
    createDangerousCodePlanWithOxc(code, filename, options).replacements
  );
