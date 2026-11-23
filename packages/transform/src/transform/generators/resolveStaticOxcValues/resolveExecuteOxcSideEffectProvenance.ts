/* eslint-disable no-restricted-syntax,no-continue */

import { isAbsolute } from 'path';

import { stripQueryAndHash } from '@wyw-in-js/shared';

import type { OxcStaticValueCandidate } from '../../../utils/collectOxcTemplateDependencies';
import type { ITransformAction, SyncScenarioFor } from '../../types';
import { resolveCandidateSideEffectProvenance } from './candidateResolver';
import type { StaticExportResult } from './types';

/**
 * Collects only CSS side-effect provenance for execute evaluation. Candidate
 * values are intentionally neither returned nor installed in the preeval
 * static-value cache.
 */
export function* resolveExecuteOxcSideEffectProvenance(
  action: ITransformAction,
  candidates: OxcStaticValueCandidate[],
  filename: string
): SyncScenarioFor<void> {
  const preevalResult = action.entrypoint.getPreevalResult();
  if (!preevalResult) {
    return;
  }

  if (preevalResult.executeSideEffectProvenanceResolved) {
    return;
  }

  const executeDependencyNames = new Set(preevalResult.dependencyNames ?? []);
  const executeSideEffectImportLocals = new Set(
    preevalResult.staticSideEffectImportLocals ?? []
  );
  const executeSideEffectDependencies = new Set(
    preevalResult.executeSideEffectDependencies ?? []
  );
  const memo = new Map<string, StaticExportResult | null>();

  for (const candidate of candidates) {
    if (
      !executeDependencyNames.has(candidate.name) ||
      candidate.imports.length === 0
    ) {
      continue;
    }

    const provenance = yield* resolveCandidateSideEffectProvenance(
      action,
      candidate,
      filename,
      memo
    );
    if (!provenance) {
      continue;
    }

    provenance.importLocals.forEach((local) =>
      executeSideEffectImportLocals.add(local)
    );
    provenance.dependencies.forEach((dependency) =>
      executeSideEffectDependencies.add(dependency)
    );
  }

  preevalResult.staticImportLocals = [
    ...new Set([
      ...(preevalResult.staticImportLocals ?? []),
      ...executeSideEffectImportLocals,
    ]),
  ];
  preevalResult.staticSideEffectImportLocals = [
    ...executeSideEffectImportLocals,
  ];
  preevalResult.executeSideEffectDependencies = [
    ...executeSideEffectDependencies,
  ];
  preevalResult.executeSideEffectProvenanceResolved = true;

  for (const dependency of executeSideEffectDependencies) {
    const strippedDependency = stripQueryAndHash(dependency);
    if (isAbsolute(strippedDependency)) {
      action.services.cache.checkFreshness(dependency, strippedDependency);
    }

    action.entrypoint.addInvalidationDependency({
      only: ['*'],
      resolved: dependency,
      source: dependency,
    });
    action.entrypoint.markInvalidateOnDependencyChange(dependency);
  }
}
