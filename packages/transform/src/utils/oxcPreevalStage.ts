import type { IFileContext } from '@wyw-in-js/processor-utils';

import { EventEmitter } from './EventEmitter';
import { deferOxcPreevalCode } from './oxcPreevalStage/deferredCode';
import { appendOxcWywPreval } from './oxcPreevalStage/prevalExport';
import { prepareOxcPreevalCode } from './oxcPreevalStage/prepareCode';
import { collectPreevalProcessors } from './oxcPreevalStage/processors';
import { createStaticPreevalOverlay } from './oxcPreevalStage/staticOverlay';
import type {
  OxcPreevalOptions,
  OxcPreevalResult,
} from './oxcPreevalStage/types';

export { appendOxcWywPreval } from './oxcPreevalStage/prevalExport';

export const runOxcPreevalStage = (
  code: string,
  fileContext: IFileContext,
  options: OxcPreevalOptions
): OxcPreevalResult => {
  const filename = fileContext.filename ?? 'unknown.js';
  const eventEmitter = options.eventEmitter ?? EventEmitter.dummy;
  const { dependencyNames, processed } = collectPreevalProcessors(
    code,
    fileContext,
    options,
    eventEmitter
  );
  const staticOverlay = createStaticPreevalOverlay(
    processed,
    dependencyNames,
    options
  );
  const prepareBaseCode = () =>
    prepareOxcPreevalCode(processed.code, filename, options, eventEmitter);
  const baseCode = prepareBaseCode();

  if (processed.processors.length === 0) {
    return {
      baseCode,
      code: baseCode,
      dependencyNames: [],
      metadata: null,
      processorManagedExpressionSpans: [],
      processorClassNames: {},
      pureCallHints: [],
      runtimeProcessorPlan: processed.runtimeProcessorPlan,
      staticDependencies: [],
      staticPlanFacts: processed.staticPlanFacts,
      staticValueCandidates: [],
      staticValueCache: new Map(),
    };
  }

  const result: OxcPreevalResult = {
    baseCode,
    code: '',
    dependencyNames: staticOverlay.evalDependencyNames,
    metadata: {
      dependencies: [],
      processors: processed.processors,
      replacements: [],
      rules: {},
    },
    processorManagedExpressionSpans: processed.processorManagedExpressionSpans,
    processorClassNames: Object.fromEntries(
      processed.processorClassNamesByLocal
    ),
    pureCallHints: processed.pureCallHints,
    runtimeProcessorPlan: processed.runtimeProcessorPlan,
    staticDependencies: [],
    staticPlanFacts: processed.staticPlanFacts,
    staticValueCache: staticOverlay.staticValueCache,
    staticValueCandidates: staticOverlay.staticValueCandidates,
  };
  const deferExecutableCode = () => {
    deferOxcPreevalCode(result, 'code', () =>
      appendOxcWywPreval(result.baseCode, filename, result.dependencyNames)
    );
  };
  deferExecutableCode();

  if (processed.finalizeProcessorCallbacks) {
    let evaltimeReplacementsFinalized = false;
    result.finalizeEvaltimeReplacements = (
      staticValueCache?: Map<string, unknown>
    ) => {
      if (evaltimeReplacementsFinalized) {
        return;
      }

      processed.finalizeProcessorCallbacks?.(staticValueCache);
      result.baseCode = prepareBaseCode();
      deferExecutableCode();
      result.staticValueCache = staticValueCache ?? result.staticValueCache;
      result.staticValueCandidates = processed.staticValueCandidates;
      evaltimeReplacementsFinalized = true;
    };
  }

  return result;
};
