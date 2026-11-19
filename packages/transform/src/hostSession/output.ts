/**
 * Projects a `Result` of the pipeline into the normalized output of a host
 * session, and holds the rules for file names with a `?query`:
 * - changed files and dependencies are matched without `?query` and `#hash`,
 *   as the transform cache keys files;
 * - dependencies go to the watcher as files on disk, cut at the first `?`;
 * - unresolved specifiers stay as written: they are requests, not paths.
 */
import path from 'path';

import { stripQueryAndHash } from '@wyw-in-js/shared';

import type { Result } from '../types';

import type { HostFile, HostOutput, HostWarning } from './types';

// The module extensions that the suggested CSS id replaces, as Vite does.
const MODULE_EXTENSIONS: readonly string[] = [
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
];

const CSS_ID_EXTENSION = '.wyw-in-js.css';

/** A resolved id as a file for the watcher: without its `?query`. */
export const toWatchFile = (id: string): string => id.split('?', 1)[0];

/** The files a root depends on, for matching changed files. */
export const toMatchFiles = (
  root: string,
  dependencies: readonly string[]
): ReadonlySet<string> =>
  new Set([root, ...dependencies].map((file) => stripQueryAndHash(file)));

/** `/p/a.ts?x` suggests `/p/a.wyw-in-js.css`. A hint only. */
export const suggestCssId = (filename: string): string => {
  const file = toWatchFile(filename);
  const extension = path.extname(file);
  return MODULE_EXTENSIONS.includes(extension)
    ? `${file.slice(0, -extension.length)}${CSS_ID_EXTENSION}`
    : `${file}${CSS_ID_EXTENSION}`;
};

/** Resolves a dependency of the root for the caller; `null` is a miss. */
export type ResolveDependency = (specifier: string) => Promise<string | null>;

const resolveDependencies = async (
  result: Result,
  resolve: ResolveDependency
): Promise<Pick<HostOutput, 'dependencies' | 'unresolved'>> => {
  const resolutions = new Map<string, string>();
  result.dependencyResolutions?.forEach(({ resolved, source }) => {
    if (resolved && !resolutions.has(source)) {
      resolutions.set(source, resolved);
    }
  });

  const specifiers = [...new Set(result.dependencies ?? [])];
  const resolved = await Promise.all(
    specifiers.map((specifier) => {
      if (path.isAbsolute(specifier)) return specifier;
      const known = resolutions.get(specifier);
      if (known !== undefined) return known;
      // A bundler resolver that throws on a miss reports a miss here.
      return resolve(specifier).catch(() => null);
    })
  );

  const dependencies = new Set<string>();
  const unresolved: string[] = [];
  specifiers.forEach((specifier, index) => {
    const id = resolved[index];
    if (id === null) {
      unresolved.push(specifier);
    } else {
      dependencies.add(toWatchFile(id));
    }
  });

  return { dependencies: [...dependencies], unresolved };
};

export type Projection = {
  file: HostFile;
  /** Resolves the dependencies the pipeline left unresolved. */
  resolve: ResolveDependency;
  result: Result;
  /** Warnings the pipeline reported during the call. */
  warnings: readonly HostWarning[];
};

/**
 * A result without CSS metadata hands the input back; an empty stylesheet
 * keeps the transformed code without CSS.
 */
export const projectResult = async ({
  file,
  resolve,
  result,
  warnings,
}: Projection): Promise<HostOutput> => {
  const { dependencies, unresolved } = await resolveDependencies(
    result,
    resolve
  );
  const allWarnings: HostWarning[] = [
    ...warnings,
    ...(result.diagnostics ?? []).map(
      (diagnostic): HostWarning => ({ ...diagnostic, source: 'processor' })
    ),
  ];

  if (result.cssText === undefined) {
    return {
      changed: false,
      code: file.code,
      css: null,
      dependencies,
      map: file.inputSourceMap ?? null,
      metadata: null,
      unresolved,
      warnings: allWarnings,
    };
  }

  return {
    changed: true,
    code: result.code,
    css:
      result.cssText === ''
        ? null
        : {
            map: result.cssSourceMapText ?? null,
            suggestedId: suggestCssId(file.filename),
            text: result.cssText,
          },
    dependencies,
    map: result.sourceMap ?? null,
    metadata: result.metadata ?? null,
    unresolved,
    warnings: allWarnings,
  };
};
