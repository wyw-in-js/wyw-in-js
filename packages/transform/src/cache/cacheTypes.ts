import { createHash } from 'crypto';

import {
  getPipelineCodeSha256Hex,
  primePipelineCodeSha256Hex,
} from '../debug/pipelineTelemetry';

export interface IBaseCachedEntrypoint {
  dependencies: Map<string, { resolved: string | null }>;
  hasTransformResult?: boolean;
  initialCode?: string;
  isProcessing?: boolean;
  invalidateOnDependencyChange?: Set<string>;
  invalidationDependencies?: Map<string, { resolved: string | null }>;
  transformed?: boolean;
}

export type EntrypointDependencySnapshot = Pick<
  IBaseCachedEntrypoint,
  'dependencies' | 'invalidationDependencies' | 'invalidateOnDependencyChange'
>;

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
