import type {
  SyncScenarioForAction,
  IExplodeReexportsAction,
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
  // Never scheduled. It stays because it is part of the public
  // `baseHandlers` shape and of the `transform()` custom handlers type.
  explodeReexports: emptyHandler<IExplodeReexportsAction>,
  getExports,
  processEntrypoint,
  processImports,
  transform,
};
