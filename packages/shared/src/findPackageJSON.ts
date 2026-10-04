import { readFileSync } from 'fs';
import { dirname, isAbsolute } from 'path';
import { createRequire } from 'module';
import findUp from 'find-up';

const cache = new Map<string, string | undefined>();
const nodeRequire = createRequire(import.meta.url);

function findSelfPackageJSON(pkgName: string, filename: string) {
  const packageJSONPath = findUp.sync('package.json', {
    cwd: dirname(filename),
  });
  if (!packageJSONPath) return undefined;

  try {
    const packageJSON = JSON.parse(readFileSync(packageJSONPath, 'utf8'));
    return packageJSON?.name === pkgName ? packageJSONPath : undefined;
  } catch {
    return undefined;
  }
}

function findPackageJSONUncached(
  pkgName: string,
  filename: string | null | undefined
): string | undefined {
  // Jest's resolver does not work properly with `moduleNameMapper` when `paths` are defined
  const isJest = Boolean(globalThis.process?.env?.JEST_WORKER_ID);
  const skipPathsOptions = isJest && !pkgName.startsWith('.');

  try {
    const pkgPath =
      pkgName === '.' && filename && isAbsolute(filename)
        ? filename
        : nodeRequire.resolve(
            pkgName,
            filename ? { paths: [dirname(filename)] } : {}
          );
    if (!cache.has(pkgPath)) {
      cache.set(pkgPath, findUp.sync('package.json', { cwd: pkgPath }));
    }

    return cache.get(pkgPath);
  } catch (er: unknown) {
    const code =
      typeof er === 'object' && er !== null && 'code' in er
        ? er.code
        : undefined;

    if (code === 'MODULE_NOT_FOUND') {
      if (filename) {
        // Bun doesn't expose workspace packages via `require.resolve`, but tests
        // and tooling can still reference the current package by name.
        const selfPackageJSON = findSelfPackageJSON(pkgName, filename);
        if (selfPackageJSON) {
          return selfPackageJSON;
        }

        const bun = (
          globalThis as typeof globalThis & {
            Bun?: {
              resolveSync?: (specifier: string, from: string) => string;
            };
          }
        ).Bun;
        if (bun && typeof bun.resolveSync === 'function') {
          try {
            const resolved = bun.resolveSync(pkgName, filename);
            if (!cache.has(resolved)) {
              cache.set(
                resolved,
                findUp.sync('package.json', {
                  cwd: resolved,
                })
              );
            }

            return cache.get(resolved);
          } catch {
            // fall through to the existing resolution heuristics
          }
        }
      }

      if (skipPathsOptions && filename) {
        return findPackageJSONUncached(pkgName, null);
      }

      return undefined;
    }

    if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      // See https://github.com/wyw-in-js/wyw-in-js/issues/43
      // `require` can't resolve ESM-only packages. We can use the `resolve`
      // package here, but it does not solve all cases because `pkgName`
      // can be an alias and should be resolved by a bundler. However, we can't use
      // `resolve` from a bundler because it is async. The good news is that in that
      // specific case, we can just ignore those packages. For now.
      return undefined;
    }

    throw er;
  }
}

// Processors look up the same packages from every module in a directory, and
// a failed `require.resolve` (e.g. a bundler alias) walks every node_modules
// level before falling back to reading the nearest package.json.
const lookupCache = new Map<string, string | undefined>();

export function findPackageJSON(
  pkgName: string,
  filename: string | null | undefined
): string | undefined {
  const lookupKey = `${pkgName}\0${filename ? dirname(filename) : ''}`;
  if (lookupCache.has(lookupKey)) {
    return lookupCache.get(lookupKey);
  }

  const result = findPackageJSONUncached(pkgName, filename);
  lookupCache.set(lookupKey, result);
  return result;
}
