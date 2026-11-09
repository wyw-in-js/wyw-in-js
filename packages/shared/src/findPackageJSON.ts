import { existsSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { createRequire } from 'module';
import findUp from 'find-up';

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

type NearestPackageJSON = (resolved: string) => string | undefined;

function findPackageJSONUncached(
  pkgName: string,
  filename: string | null | undefined,
  nearestPackageJSON: NearestPackageJSON
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
    return nearestPackageJSON(pkgPath);
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
            return nearestPackageJSON(bun.resolveSync(pkgName, filename));
          } catch {
            // fall through to the existing resolution heuristics
          }
        }
      }

      if (skipPathsOptions && filename) {
        return findPackageJSONUncached(pkgName, null, nearestPackageJSON);
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

type PackageJSONLookup = (
  pkgName: string,
  filename: string | null | undefined
) => string | undefined;

/**
 * Creates a lookup that owns every cache of `findPackageJSON`. The caches live
 * as long as the lookup, so a new lookup starts from an empty state.
 */
function createPackageJSONLookup(): PackageJSONLookup {
  // The nearest package.json of a resolved file.
  const packageJSONByFile = new Map<string, string | undefined>();

  const nearestPackageJSON: NearestPackageJSON = (resolved) => {
    if (!packageJSONByFile.has(resolved)) {
      packageJSONByFile.set(
        resolved,
        findUp.sync('package.json', { cwd: resolved })
      );
    }

    return packageJSONByFile.get(resolved);
  };

  // A bare specifier resolves the same way from every directory between the
  // importer's directory and the nearest directory that holds one of these
  // entries: Node's `require.resolve` walks the node_modules chain, Bun's also
  // reads the `paths` of the nearest tsconfig.json or jsconfig.json and the
  // self-reference of the nearest package.json, and the fallbacks below read
  // the nearest package.json. That directory is the resolution scope.
  const scopeMarkers = [
    'node_modules',
    'package.json',
    'tsconfig.json',
    'jsconfig.json',
  ];

  // The resolution scope of every directory seen so far.
  const scopes = new Map<string, string>();

  const hasScopeMarker = (dir: string) =>
    scopeMarkers.some((marker) => existsSync(join(dir, marker)));

  const resolutionScope = (dir: string): string => {
    const walked: string[] = [];
    let current = dir;
    let scope = scopes.get(current);
    while (scope === undefined) {
      walked.push(current);
      const parent = dirname(current);
      if (parent === current || hasScopeMarker(current)) {
        scope = current;
      } else {
        current = parent;
        scope = scopes.get(current);
      }
    }

    const found = scope;
    walked.forEach((walkedDir) => scopes.set(walkedDir, found));
    return found;
  };

  // Processors look up the same packages from every module of a package, and
  // a failed `require.resolve` (e.g. a bundler alias) walks every node_modules
  // level before falling back to reading the nearest package.json, so lookups
  // are shared by the directories of one resolution scope. A path specifier
  // resolves against the importer's own directory and keeps it as the key.
  const lookups = new Map<string, string | undefined>();

  const lookupDir = (pkgName: string, filename: string | null | undefined) => {
    if (!filename) {
      return '';
    }

    const dir = dirname(filename);
    const isPathSpecifier =
      pkgName !== '.' && (pkgName.startsWith('.') || isAbsolute(pkgName));
    return isAbsolute(filename) && !isPathSpecifier
      ? resolutionScope(dir)
      : dir;
  };

  return (pkgName, filename) => {
    const lookupKey = `${pkgName}\0${lookupDir(pkgName, filename)}`;
    if (lookups.has(lookupKey)) {
      return lookups.get(lookupKey);
    }

    const result = findPackageJSONUncached(
      pkgName,
      filename,
      nearestPackageJSON
    );
    lookups.set(lookupKey, result);
    return result;
  };
}

const processLookup = createPackageJSONLookup();

export function findPackageJSON(
  pkgName: string,
  filename: string | null | undefined
): string | undefined {
  return processLookup(pkgName, filename);
}
