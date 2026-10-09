import type { ApplyOxcProcessorsResult } from '../applyOxcProcessors/types';
import { usesStaticEvaluation } from '../evalStrategy';
import type { OxcPreevalOptions, StaticPreevalOverlay } from './types';

export const createStaticPreevalOverlay = (
  processed: ApplyOxcProcessorsResult,
  dependencyNames: string[],
  options: OxcPreevalOptions
): StaticPreevalOverlay => {
  const staticValuesEnabled = usesStaticEvaluation(options);
  const staticValueNames = staticValuesEnabled
    ? new Set(processed.staticValues.map((item) => item.name))
    : null;
  const evalDependencyNames = staticValuesEnabled
    ? dependencyNames.filter((name) => !staticValueNames!.has(name))
    : dependencyNames;
  const staticValueCache = new Map<string, unknown>();

  if (staticValuesEnabled) {
    processed.staticValues.forEach(({ name, value }) => {
      staticValueCache.set(name, value);
    });
  }

  return {
    evalDependencyNames,
    staticValueCache,
    staticValueCandidates: staticValuesEnabled
      ? processed.staticValueCandidates
      : [],
  };
};
