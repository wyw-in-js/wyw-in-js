/**
 * This file is an entry point for module evaluation for getting lazy dependencies.
 */

import { invariant } from 'ts-invariant';

import type { Entrypoint } from '../transform/Entrypoint';
import type { IEvaluatedEntrypoint } from '../transform/EvaluatedEntrypoint';
import type { Services } from '../transform/types';

export interface IEvaluateResult {
  dependencies: string[];
  publication: Entrypoint | IEvaluatedEntrypoint | undefined;
  values: Map<string, unknown> | null;
}

export default async function evaluate(
  services: Services,
  entrypoint: Entrypoint
): Promise<IEvaluateResult> {
  invariant(
    services.evalBroker,
    '[wyw-in-js] Eval broker is missing for evaluation.'
  );
  const result = await services.evalBroker.evaluate(entrypoint, services);
  const publication = Object.prototype.hasOwnProperty.call(
    result,
    'publication'
  )
    ? result.publication
    : services.cache.get('entrypoints', entrypoint.name);

  return {
    values: result.values,
    dependencies: result.dependencies,
    publication,
  };
}
