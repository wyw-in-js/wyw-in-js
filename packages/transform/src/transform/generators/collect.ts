import { collectOxcRuntime } from '../../utils/collectOxcRuntime';
import type { ICollectAction, SyncScenarioForAction } from '../types';

/**
 * Parses the specified file, finds tags, applies run-time replacements,
 * removes dead code.
 */
// eslint-disable-next-line require-yield
export function* collect(
  this: ICollectAction
): SyncScenarioForAction<ICollectAction> {
  const { options } = this.services;
  const { prevalPayload } = this.data;
  const { entrypoint } = this;
  const { loadedAndParsed, name } = entrypoint;
  const preevalResult = entrypoint.getPreevalResult();

  if (loadedAndParsed.evaluator === 'ignored') {
    throw new Error('entrypoint was ignored');
  }

  const result = collectOxcRuntime(
    loadedAndParsed.code,
    name,
    options.root ?? process.cwd(),
    {
      ...options.pluginOptions,
      eventEmitter: this.services.eventEmitter,
      preserveSideEffectImportOrderLocals: new Set(
        preevalResult?.staticImportLocals ?? []
      ),
      preserveSideEffectImportLocals: new Set(
        preevalResult?.staticSideEffectImportLocals ?? []
      ),
    },
    prevalPayload.values,
    options.inputSourceMap,
    preevalResult?.runtimeProcessorPlan
  );

  return {
    ast: null,
    code: result.code,
    map: result.map,
    metadata: result.metadata,
  };
}
