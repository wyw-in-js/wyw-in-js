import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

import { BaseProcessor } from '@wyw-in-js/processor-utils';
import type { TagSource } from '@wyw-in-js/processor-utils';
import { findPackageJSON, syncResolve } from '@wyw-in-js/shared';
import type { StrictOptions, TagResolverMeta } from '@wyw-in-js/shared';

import type { ProcessorManifest } from './manifest';
import { resolveProcessorReference } from './manifest';

const nodeRequire = createRequire(import.meta.url);

export type ProcessorClass = new (
  ...args: ConstructorParameters<typeof BaseProcessor>
) => BaseProcessor;

// Keyed by the resolved package.json path: two versions of one package
// installed for different importers declare their tags independently.
const definedTagsCache = new Map<string, Record<string, string> | undefined>();
const resolvedTagResolverSourceCache = new Map<string, string | undefined>();
type ProcessorLookupValue = {
  manifest: ProcessorManifest | null;
  processor: ProcessorClass | null;
};
const NO_PROCESSOR: ProcessorLookupValue = Object.freeze({
  manifest: null,
  processor: null,
});
// Keyed by the importer directory: a bare specifier resolves relative to it,
// so importers in different packages may get different processor versions.
const packageProcessorLookupCache = new Map<string, ProcessorLookupValue>();
const tagResolverProcessorLookupCache = new WeakMap<
  NonNullable<StrictOptions['tagResolver']>,
  Map<string, ProcessorLookupValue>
>();

const createTagResolverLookupCacheKey = (
  source: string,
  imported: string,
  filename: string | null | undefined
): string => `${filename ?? ''}\0${source}\0${imported}`;

const createPackageLookupCacheKey = (
  source: string,
  imported: string,
  filename: string | null | undefined
): string => `${filename ? dirname(filename) : ''}\0${source}\0${imported}`;

const URL_SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:/;

const isPackageLookupCandidate = (source: string): boolean => {
  if (
    !source ||
    source.startsWith('.') ||
    source.startsWith('/') ||
    source.startsWith('\\') ||
    source.startsWith('\0') ||
    source.startsWith('@/') ||
    source.startsWith('~/') ||
    source.startsWith('#') ||
    source.includes('?') ||
    source.includes('#') ||
    URL_SCHEME_RE.test(source)
  ) {
    return false;
  }

  if (source.startsWith('@')) {
    const [scope, pkg] = source.split('/', 2);
    return scope.length > 1 && !!pkg;
  }

  return true;
};

const getTagResolverLookupCache = (
  tagResolver: NonNullable<StrictOptions['tagResolver']>
): Map<string, ProcessorLookupValue> => {
  const existing = tagResolverProcessorLookupCache.get(tagResolver);
  if (existing) {
    return existing;
  }

  const created = new Map<string, ProcessorLookupValue>();
  tagResolverProcessorLookupCache.set(tagResolver, created);
  return created;
};

const getResolvedTagResolverSource = (
  source: string,
  sourceFile: string | null | undefined
): string | undefined => {
  if (!sourceFile) {
    return undefined;
  }

  const key = `${sourceFile}\0${source}`;
  if (resolvedTagResolverSourceCache.has(key)) {
    return resolvedTagResolverSourceCache.get(key);
  }

  try {
    const resolved = syncResolve(source, sourceFile, []);
    resolvedTagResolverSourceCache.set(key, resolved);
    return resolved;
  } catch {
    resolvedTagResolverSourceCache.set(key, undefined);
    return undefined;
  }
};

const getDefinedTagsFromPackage = (
  pkgName: string,
  filename: string | null | undefined
): Record<string, string> | undefined => {
  const packageJSONPath = findPackageJSON(pkgName, filename);
  if (!packageJSONPath) {
    return undefined;
  }

  if (definedTagsCache.has(packageJSONPath)) {
    return definedTagsCache.get(packageJSONPath);
  }

  const packageDir = dirname(packageJSONPath);
  const packageJSON = JSON.parse(readFileSync(packageJSONPath, 'utf8'));
  const definedTags: Record<string, string> | undefined =
    packageJSON['wyw-in-js']?.tags;

  const normalizedTags = definedTags
    ? Object.entries(definedTags).reduce(
        (acc, [key, value]) => ({
          ...acc,
          [key]: value.startsWith('.')
            ? join(packageDir, value)
            : nodeRequire.resolve(value, { paths: [packageDir] }),
        }),
        {} as Record<string, string>
      )
    : undefined;

  definedTagsCache.set(packageJSONPath, normalizedTags);

  return normalizedTags;
};

const hasOwn = (target: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(target, key);

/**
 * Recognizes `BaseProcessor` from any copy of `@wyw-in-js/processor-utils`
 * (processor packages often pin their own version) by the members it has
 * owned since the first release: the static `SKIP` sentinel and
 * `isValidValue`.
 */
const isBaseProcessorFromAnyCopy = (ctor: object): boolean => {
  const { SKIP: skip, prototype } = ctor as {
    SKIP?: unknown;
    prototype?: unknown;
  };
  return (
    hasOwn(ctor, 'SKIP') &&
    typeof skip === 'symbol' &&
    skip.description === BaseProcessor.SKIP.description &&
    typeof prototype === 'object' &&
    prototype !== null &&
    hasOwn(prototype, 'isValidValue')
  );
};

const isProcessorClass = (value: unknown): value is ProcessorClass => {
  if (typeof value !== 'function') {
    return false;
  }

  if (value.prototype instanceof BaseProcessor) {
    return true;
  }

  for (
    let ancestor: unknown = Object.getPrototypeOf(value);
    typeof ancestor === 'function';
    ancestor = Object.getPrototypeOf(ancestor)
  ) {
    if (isBaseProcessorFromAnyCopy(ancestor)) {
      return true;
    }
  }

  return false;
};

const describeDefaultExport = (value: unknown): string => {
  if (typeof value === 'function') {
    return value.name ? `"${value.name}"` : 'an anonymous function';
  }

  if (value === null) {
    return 'null';
  }

  return typeof value === 'object' ? 'an object' : String(value);
};

const getProcessorFromFile = (
  processorPath: string,
  { imported, source }: TagSource
): ProcessorLookupValue => {
  const { implementationPath, manifest } =
    resolveProcessorReference(processorPath);
  const Processor: unknown = nodeRequire(implementationPath).default;
  if (!isProcessorClass(Processor)) {
    throw new Error(
      `[wyw-in-js] Invalid processor ${implementationPath} for "${imported}" from "${source}": ` +
        'its default export must be a class extending BaseProcessor ' +
        `from @wyw-in-js/processor-utils, got ${describeDefaultExport(
          Processor
        )}.`
    );
  }

  return {
    manifest,
    processor: Processor,
  };
};

const getProcessorFromPackage = (
  tagSource: TagSource,
  filename: string | null | undefined
): ProcessorLookupValue => {
  const definedTags = getDefinedTagsFromPackage(tagSource.source, filename);
  const processorPath = definedTags?.[tagSource.imported];
  if (!processorPath) {
    return NO_PROCESSOR;
  }

  return getProcessorFromFile(processorPath, tagSource);
};

export const getProcessorForImport = (
  { imported, source }: { imported: string; source: string },
  filename: string | null | undefined,
  options: Pick<StrictOptions, 'tagResolver'>
): [ProcessorClass | null, TagSource, ProcessorManifest | null] => {
  const { tagResolver } = options;
  const packageLookupCandidate = isPackageLookupCandidate(source);

  if (!tagResolver && !packageLookupCandidate) {
    return [null, { imported, source }, null];
  }

  const cacheKey = tagResolver
    ? createTagResolverLookupCacheKey(source, imported, filename)
    : createPackageLookupCacheKey(source, imported, filename);
  const lookupCache = tagResolver
    ? getTagResolverLookupCache(tagResolver)
    : packageProcessorLookupCache;

  if (lookupCache.has(cacheKey)) {
    const cached = lookupCache.get(cacheKey);
    return [
      cached?.processor ?? null,
      { imported, source },
      cached?.manifest ?? null,
    ];
  }

  let customFile: string | null = null;
  if (tagResolver) {
    const tagResolverMeta: TagResolverMeta = {
      sourceFile: filename,
      resolvedSource: getResolvedTagResolverSource(source, filename),
    };

    customFile = tagResolver(source, imported, tagResolverMeta);
  }
  let lookupValue = NO_PROCESSOR;
  if (customFile) {
    lookupValue = getProcessorFromFile(customFile, { imported, source });
  } else if (packageLookupCandidate) {
    lookupValue = getProcessorFromPackage({ imported, source }, filename);
  }

  lookupCache.set(cacheKey, lookupValue);
  return [lookupValue.processor, { imported, source }, lookupValue.manifest];
};
