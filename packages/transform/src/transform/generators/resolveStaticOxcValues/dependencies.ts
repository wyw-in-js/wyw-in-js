/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import { Entrypoint } from '../../Entrypoint';
import type { IEntrypointDependency } from '../../Entrypoint.types';
import { isAborted } from '../../actions/AbortError';
import type { ITransformAction, SyncScenarioFor } from '../../types';
import { getWeakCacheMap } from './cache';

export const isRelativeSource = (source: string): boolean =>
  source.startsWith('./') ||
  source.startsWith('../') ||
  source === '.' ||
  source === '..';

export const dependencyResolutionCaches = new WeakMap<
  object,
  Map<string, IEntrypointDependency>
>();

// Bare package and alias resolution can depend on the importer through nested
// packages, package boundaries, tsconfig paths, or bundler aliases.
export const dependencyResolutionCacheKey = (
  importer: string,
  source: string,
  imported: string
): string => `${importer}\0${source}\0${imported}`;

export function* resolveDependency(
  action: ITransformAction,
  importer: string,
  source: string,
  imported: string
): SyncScenarioFor<IEntrypointDependency | null> {
  let entrypoint =
    importer === action.entrypoint.name
      ? action.entrypoint
      : Entrypoint.createRoot(
          action.services,
          importer,
          [imported],
          undefined,
          { graphTraversalToken: action.entrypoint.graphTraversalToken }
        );
  const imports = new Map([[source, [imported]]]);
  let resolved: IEntrypointDependency | undefined;
  for (;;) {
    try {
      [resolved] = yield* action.getNext('resolveImports', entrypoint, {
        imports,
        phase: 'initial',
      });
      break;
    } catch (e) {
      // The analysis root for another file is superseded whenever a concurrent
      // transform requests that file with a wider `only`. resolveImports then
      // aborts for it, but nothing in this pipeline is superseded: the abort
      // handlers of processEntrypoint and workflow only restart their own
      // entrypoint, so the error would fail this transform. Import resolution
      // does not depend on `only`; continue on the superseding generation.
      const successor =
        entrypoint !== action.entrypoint && isAborted(e)
          ? entrypoint.supersededWith
          : null;
      if (!successor) {
        throw e;
      }

      entrypoint = successor;
    }
  }

  // Non-relative sources (package names, aliases) can still be importer-
  // dependent because of nested packages, tsconfig boundaries, and bundler
  // aliases. Cache only within the same importer context.
  if (!isRelativeSource(source)) {
    const cache = getWeakCacheMap(
      dependencyResolutionCaches,
      action.services.cache
    );
    const cacheKey = dependencyResolutionCacheKey(importer, source, imported);
    if (resolved?.resolved) {
      cache.set(cacheKey, resolved);
      return resolved;
    }

    const cached = cache.get(cacheKey);
    if (cached?.resolved) {
      return cached;
    }
  }

  return resolved ?? null;
}
