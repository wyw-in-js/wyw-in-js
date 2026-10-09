import path from 'path';

import { stripQueryAndHash } from '../utils/parseRequest';

import { isBuiltinSpecifier, isVirtualSpecifier } from './brokerSession';

type DependencyGraphEntrypoint = {
  dependencies?: ReadonlyMap<string, { resolved: string | null }>;
};

type GetDependencyGraphEntrypoint = (
  id: string
) => DependencyGraphEntrypoint | undefined;

const isNodeModulesFile = (filename: string) =>
  filename.replace(/\\/g, '/').includes('/node_modules/');

const isWatchableModule = (specifier: string, resolved: string) => {
  if (
    isBuiltinSpecifier(specifier) ||
    isVirtualSpecifier(specifier) ||
    isVirtualSpecifier(resolved)
  ) {
    return false;
  }

  const filename = stripQueryAndHash(resolved);
  return path.isAbsolute(filename) && !isNodeModulesFile(filename);
};

/**
 * Lists the modules an evaluated root depended on.
 *
 * Direct imports of the root keep their specifiers, so `Result` can map them
 * through `dependencyResolutions`. Modules reached through those imports are
 * listed by resolved path, the same way statically resolved dependencies are,
 * because their specifiers are relative to another importer. The walk follows
 * the cached entrypoint graph rather than the runner's load requests: a
 * module reused from an earlier evaluation is not loaded again, but its value
 * still depends on everything it imported.
 *
 * Packages under `node_modules` are not followed.
 */
export const collectEvalDependencies = (
  rootId: string,
  runtimeSpecifiers: Iterable<string>,
  getEntrypoint: GetDependencyGraphEntrypoint
): string[] => {
  const direct = new Set(runtimeSpecifiers);
  const visited = new Set([rootId]);
  const pending: string[] = [];

  getEntrypoint(rootId)?.dependencies?.forEach((dependency, specifier) => {
    const { resolved } = dependency;
    if (
      resolved === null ||
      isBuiltinSpecifier(specifier) ||
      isVirtualSpecifier(specifier)
    ) {
      return;
    }

    direct.add(specifier);
    if (isWatchableModule(specifier, resolved) && !visited.has(resolved)) {
      visited.add(resolved);
      pending.push(resolved);
    }
  });

  const transitive: string[] = [];
  for (let index = 0; index < pending.length; index += 1) {
    getEntrypoint(pending[index])?.dependencies?.forEach(
      ({ resolved }, specifier) => {
        if (
          resolved === null ||
          visited.has(resolved) ||
          !isWatchableModule(specifier, resolved)
        ) {
          return;
        }

        visited.add(resolved);
        pending.push(resolved);
        transitive.push(resolved);
      }
    );
  }

  return [...direct, ...transitive];
};
