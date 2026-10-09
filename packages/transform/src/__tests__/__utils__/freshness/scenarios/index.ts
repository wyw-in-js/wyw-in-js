import type { FreshnessScenario } from '../types';

import { barrelScenarios } from './barrels';
import { concurrencyScenarios } from './concurrency';
import { editScenarios } from './edits';
import { sessionScenarios } from './sessions';

export const freshnessScenarios: FreshnessScenario[] = [
  ...editScenarios,
  ...barrelScenarios,
  ...sessionScenarios,
  ...concurrencyScenarios,
];
