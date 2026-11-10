import type { IFileContext } from '@wyw-in-js/processor-utils';
import { isFeatureEnabled } from '@wyw-in-js/shared';

import type { EventEmitter } from '../EventEmitter';
import { applyOxcProcessors } from '../applyOxcProcessors';
import type { ApplyOxcProcessorsResult } from '../applyOxcProcessors/types';
import { createDangerousCodePlanWithOxc } from '../dangerousCodeRemoval';
import type { OxcPreevalOptions } from './types';
import { currentPipelineObserver } from '../../telemetry/observer';

type PreevalProcessorCollection = {
  dependencyNames: string[];
  processed: ApplyOxcProcessorsResult;
};

export const collectPreevalProcessors = (
  code: string,
  fileContext: IFileContext,
  options: OxcPreevalOptions,
  eventEmitter: EventEmitter
): PreevalProcessorCollection => {
  const filename = fileContext.filename ?? 'unknown.js';
  const createEvaltimeCodePlan = isFeatureEnabled(
    options.features,
    'dangerousCodeRemover',
    filename
  )
    ? (processorSpans: Array<{ end: number; start: number }>) =>
        currentPipelineObserver().observeDangerousCode(filename, () =>
          eventEmitter.perf('transform:preeval:removeDangerousCode', () =>
            createDangerousCodePlanWithOxc(
              code,
              filename,
              options.codeRemover,
              {
                ignoredSpans: processorSpans,
                preserveImportMetaEnv: true,
              }
            )
          )
        )
    : undefined;
  const processed = eventEmitter.perf('transform:preeval:processTemplate', () =>
    applyOxcProcessors(
      code,
      fileContext,
      {
        ...options,
        createEvaltimeCodePlan,
      },
      (processor) => {
        processor.doEvaltimeReplacement();
      },
      false,
      true
    )
  );
  const dependencyNames = processed.processors.flatMap((processor) =>
    processor.dependencies.flatMap((dependency) =>
      dependency.ex.type === 'Identifier' ? [dependency.ex.name] : []
    )
  );

  return {
    dependencyNames,
    processed,
  };
};
