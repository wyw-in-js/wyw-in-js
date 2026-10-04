import { createHash } from 'crypto';

import {
  getPipelineCodeSha256Hex,
  primePipelineCodeSha256Hex,
} from '../debug/pipelineTelemetry';

export interface DependencyToCheck {
  resolved: string | null;
  readOnly?: boolean;
}

export interface IBaseCachedEntrypoint {
  dependencies: Map<string, { resolved: string | null }>;
  hasTransformResult?: boolean;
  initialCode?: string;
  isProcessing?: boolean;
  processingStarted?: boolean;
  loadedAndParsed?: { evaluator: unknown; reason?: string };
  invalidateOnDependencyChange?: Set<string>;
  invalidationDependencies?: Map<string, { resolved: string | null }>;
  transformed?: boolean;
}

export type EntrypointDependencySnapshot = Pick<
  IBaseCachedEntrypoint,
  'dependencies' | 'invalidationDependencies' | 'invalidateOnDependencyChange'
> & { invalidationVersion?: number };

export const createDependencySnapshot = (
  entrypoint: IBaseCachedEntrypoint,
  invalidationVersion: number
): EntrypointDependencySnapshot => {
  const copy = (
    dependencies: Map<string, { resolved: string | null }> | undefined
  ): Map<string, { resolved: string | null }> =>
    new Map(
      Array.from(dependencies ?? [], ([key, dependency]) => [
        key,
        { resolved: dependency.resolved },
      ])
    );

  return {
    invalidationVersion,
    dependencies: copy(entrypoint.dependencies),
    invalidationDependencies: copy(entrypoint.invalidationDependencies),
    invalidateOnDependencyChange: new Set(
      entrypoint.invalidateOnDependencyChange ?? []
    ),
  };
};

export const hashContent = (content: string): string => {
  const cached = getPipelineCodeSha256Hex(content);
  if (cached) return cached;

  const sha256Hex = createHash('sha256').update(content).digest('hex');
  primePipelineCodeSha256Hex(content, sha256Hex);
  return sha256Hex;
};

export const isEntrypointGraphIncomplete = (
  entrypoint: IBaseCachedEntrypoint | undefined
): boolean =>
  !(
    entrypoint?.loadedAndParsed?.evaluator === 'ignored' &&
    entrypoint.loadedAndParsed.reason === 'extension'
  ) &&
  Boolean(
    entrypoint?.isProcessing ||
      entrypoint?.transformed === false ||
      entrypoint?.hasTransformResult === false
  );

export const isMissingFileError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const { code } = error as NodeJS.ErrnoException;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export const getEffectiveInvalidationDependencies = (
  entrypoint: IBaseCachedEntrypoint | undefined,
  snapshot: EntrypointDependencySnapshot | undefined
): Set<string> | undefined => {
  if (entrypoint && isEntrypointGraphIncomplete(entrypoint) && snapshot) {
    return new Set([
      ...(snapshot.invalidateOnDependencyChange ?? []),
      ...(entrypoint.invalidateOnDependencyChange ?? []),
    ]);
  }
  return (
    entrypoint?.invalidateOnDependencyChange ??
    snapshot?.invalidateOnDependencyChange
  );
};
