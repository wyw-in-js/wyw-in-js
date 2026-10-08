import type {
  SyncScenarioForAction,
  ICollectAction,
  IEvalAction,
  IExplodeReexportsAction,
  IExtractAction,
  IWorkflowAction,
  ActionQueueItem,
} from '../types';

import { getExports } from './getExports';
import { processEntrypoint } from './processEntrypoint';
import { processImports } from './processImports';
import { transform } from './transform';

// eslint-disable-next-line require-yield
function* emptyHandler<T extends ActionQueueItem>(
  this: T
): SyncScenarioForAction<T> {
  throw new Error(`Handler for ${this.type} is not implemented`);
}

export const baseProcessingHandlers = {
  collect: emptyHandler<ICollectAction>,
  evalFile: emptyHandler<IEvalAction>,
  explodeReexports: emptyHandler<IExplodeReexportsAction>,
  extract: emptyHandler<IExtractAction>,
  workflow: emptyHandler<IWorkflowAction>,
  getExports,
  processEntrypoint,
  processImports,
  transform,
};
