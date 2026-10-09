import path from 'path';

import {
  syncResolve,
  type ImportOverride,
  type ImportOverrides,
} from '@wyw-in-js/shared';
import { Minimatch } from 'minimatch';

export type ImportKeyKind = 'file' | 'package';

export type ImportKey = {
  key: string;
  kind: ImportKeyKind;
};

export function toCanonicalFileKey(
  resolved: string,
  root: string | undefined
): string {
  const rootDir = root ? path.resolve(root) : process.cwd();
  const normalizedResolved = path.resolve(resolved);
  let relative = path.relative(rootDir, normalizedResolved);

  if (path.sep !== path.posix.sep) {
    relative = relative.split(path.sep).join(path.posix.sep);
  }

  if (!relative.startsWith('.')) {
    relative = `./${relative}`;
  }

  return relative;
}

export function toImportKey({
  source,
  resolved,
  root,
}: {
  resolved: string | null;
  root: string | undefined;
  source: string;
}): ImportKey {
  const isFileImport = source.startsWith('.') || path.isAbsolute(source);

  if (isFileImport && resolved) {
    return { key: toCanonicalFileKey(resolved, root), kind: 'file' };
  }

  return { key: source, kind: 'package' };
}

export function resolveMockSpecifier({
  importer,
  mock,
  root,
  stack,
}: {
  importer: string;
  mock: string;
  root: string | undefined;
  stack: string[];
}): string {
  const specifier =
    mock.startsWith('.') && root ? path.resolve(root, mock) : mock;

  return syncResolve(specifier, importer, stack);
}

export function applyImportOverrideToOnly(
  only: string[],
  override: ImportOverride | undefined
): string[] {
  if (override?.noShake) {
    return ['*'];
  }

  return only;
}

type CompiledImportOverrides = {
  matchers: Array<{
    matcher: Minimatch;
    override: ImportOverride;
    pattern: string;
    specificity: number;
  }>;
};

const compiledImportOverridesCache = new WeakMap<
  ImportOverrides,
  CompiledImportOverrides
>();

const minimatchOptions = {
  dot: true,
  nocomment: true,
  nonegate: true,
} as const;

function getPatternSpecificity(pattern: string): number {
  let wildcardCount = 0;
  let escaped = false;
  for (const char of pattern) {
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '*' || char === '?') {
      wildcardCount += 1;
    }
  }

  return pattern.length - wildcardCount * 10;
}

function compileImportOverrides(
  importOverrides: ImportOverrides
): CompiledImportOverrides {
  const matchers = Object.entries(importOverrides)
    .map(([pattern, override]) => {
      return {
        matcher: new Minimatch(pattern, minimatchOptions),
        override,
        pattern,
        specificity: getPatternSpecificity(pattern),
      };
    })
    .sort((a, b) => {
      const bySpecificity = b.specificity - a.specificity;
      if (bySpecificity !== 0) return bySpecificity;

      const byLength = b.pattern.length - a.pattern.length;
      if (byLength !== 0) return byLength;

      return a.pattern.localeCompare(b.pattern);
    });

  return { matchers };
}

function getCompiledImportOverrides(
  importOverrides: ImportOverrides
): CompiledImportOverrides {
  const cached = compiledImportOverridesCache.get(importOverrides);
  if (cached) return cached;

  const compiled = compileImportOverrides(importOverrides);
  compiledImportOverridesCache.set(importOverrides, compiled);
  return compiled;
}

export function getImportOverride(
  importOverrides: ImportOverrides | undefined,
  key: string
): ImportOverride | undefined {
  if (!importOverrides) {
    return undefined;
  }

  const direct = importOverrides[key];
  if (direct) return direct;

  const { matchers } = getCompiledImportOverrides(importOverrides);
  return matchers.find(({ matcher }) => matcher.match(key))?.override;
}

export type ImportOverrideMatch = {
  key: string;
  override: ImportOverride | undefined;
};

/**
 * Finds the override for one import: file imports are keyed by their
 * root-relative resolved path, package imports by their source.
 */
export function findImportOverride({
  importOverrides,
  resolved,
  root,
  source,
}: {
  importOverrides: ImportOverrides | undefined;
  resolved: string | null;
  root: string | undefined;
  source: string;
}): ImportOverrideMatch {
  const { key } = toImportKey({ source, resolved, root });
  return { key, override: getImportOverride(importOverrides, key) };
}

export type OverriddenImport<TResolved extends string | null> = {
  mocked: boolean;
  only: string[];
  resolved: string | TResolved;
};

/**
 * Applies the matching import override to a resolved import: `mock` replaces
 * the resolved id (even for an unresolved import), `noShake` widens `only`
 * to `['*']`. Returns `null` when no override matches.
 */
export function applyImportOverride<TResolved extends string | null>({
  getStack,
  importOverrides,
  importer,
  only,
  resolved,
  root,
  source,
}: {
  getStack: () => string[];
  importOverrides: ImportOverrides | undefined;
  importer: string;
  only: string[];
  resolved: TResolved;
  root: string | undefined;
  source: string;
}): OverriddenImport<TResolved> | null {
  if (!importOverrides) {
    return null;
  }

  const { override } = findImportOverride({
    importOverrides,
    resolved,
    root,
    source,
  });
  if (!override) {
    return null;
  }

  return {
    mocked: Boolean(override.mock),
    only: applyImportOverrideToOnly(only, override),
    resolved: override.mock
      ? resolveMockSpecifier({
          importer,
          mock: override.mock,
          root,
          stack: getStack(),
        })
      : resolved,
  };
}
