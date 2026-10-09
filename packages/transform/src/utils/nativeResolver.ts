import fs from 'fs';
import path from 'path';

import { ResolverFactory, type NapiResolveOptions } from 'oxc-resolver';

import type {
  EvalResolverKind,
  OxcOptions,
  StrictOptions,
} from '@wyw-in-js/shared';

import type { EvalRunnerConditions } from '../eval/protocol';

import { parseRequest } from './parseRequest';

const CJS_DEFAULT_CONDITIONS = ['require', 'node', 'default'] as const;
const ESM_DEFAULT_CONDITIONS = ['node', 'import', 'default'] as const;
const FALLBACK_EXTENSIONS = ['.json', '.node'] as const;
const MAX_RESOLVER_CACHE_SIZE = 64;

const resolverCache = new Map<string, ResolverFactory>();

export type NativeResolverParams = {
  conditionNames?: string[];
  extensions: StrictOptions['extensions'];
  importer: string;
  kind: EvalResolverKind;
  oxcOptions?: OxcOptions;
  specifier: string;
};

const unique = <T>(items: readonly T[]): T[] => Array.from(new Set(items));

export const expandNativeResolverConditions = (
  kind: EvalResolverKind,
  conditionNames?: readonly string[]
): string[] => {
  const defaults =
    kind === 'require' ? CJS_DEFAULT_CONDITIONS : ESM_DEFAULT_CONDITIONS;
  const names = conditionNames?.length ? conditionNames : ['...'];
  const result: string[] = [];

  names.forEach((name) => {
    if (name === '...') {
      defaults.forEach((condition) => result.push(condition));
      return;
    }

    result.push(name);
  });

  return unique(result);
};

const getConfiguredConditionNames = (
  conditionNames: readonly string[] | undefined,
  oxcOptions: OxcOptions | undefined
): readonly string[] | undefined => {
  if (conditionNames) return conditionNames;
  const configured = (oxcOptions?.resolver as NapiResolveOptions | undefined)
    ?.conditionNames;
  return Array.isArray(configured) ? configured : undefined;
};

/**
 * Conditions the eval runner uses for the specifiers it resolves itself (a
 * `require()` reached by evaluated code, re-resolution of an extensionless id,
 * a bare external id): the same lists `resolveWithNativeResolver` uses for
 * that edge kind. Returns `undefined` when nothing is configured, so the
 * runner keeps Node's own defaults.
 */
export const getEvalRunnerConditions = ({
  conditionNames,
  oxcOptions,
}: Pick<NativeResolverParams, 'conditionNames' | 'oxcOptions'>):
  | EvalRunnerConditions
  | undefined => {
  const names = getConfiguredConditionNames(conditionNames, oxcOptions);
  if (!names?.length) return undefined;

  return {
    import: expandNativeResolverConditions('import', names),
    require: expandNativeResolverConditions('require', names),
  };
};

const createResolverOptions = ({
  conditionNames,
  extensions,
  kind,
  oxcOptions,
}: Pick<
  NativeResolverParams,
  'conditionNames' | 'extensions' | 'kind' | 'oxcOptions'
>): NapiResolveOptions => {
  const configuredResolver = (oxcOptions?.resolver ?? {}) as NapiResolveOptions;
  const hasConfiguredTsconfig = Object.prototype.hasOwnProperty.call(
    configuredResolver,
    'tsconfig'
  );
  const configuredExtensions = Array.isArray(configuredResolver.extensions)
    ? configuredResolver.extensions
    : [];

  return {
    ...configuredResolver,
    ...(hasConfiguredTsconfig ? {} : { tsconfig: 'auto' }),
    conditionNames: expandNativeResolverConditions(
      kind,
      getConfiguredConditionNames(conditionNames, oxcOptions)
    ),
    extensions: unique([
      ...configuredExtensions,
      ...extensions,
      ...FALLBACK_EXTENSIONS,
    ]),
  };
};

const getResolver = (options: NapiResolveOptions): ResolverFactory => {
  const key = JSON.stringify(options);
  const cached = resolverCache.get(key);
  if (cached) {
    resolverCache.delete(key);
    resolverCache.set(key, cached);
    return cached;
  }

  const resolver = new ResolverFactory(options);
  if (resolverCache.size >= MAX_RESOLVER_CACHE_SIZE) {
    const oldestKey = resolverCache.keys().next().value;
    if (oldestKey !== undefined) {
      resolverCache.delete(oldestKey);
    }
  }
  resolverCache.set(key, resolver);
  return resolver;
};

export const clearNativeResolverCacheForTest = (): void => {
  resolverCache.clear();
};

export const getNativeResolverCacheSizeForTest = (): number =>
  resolverCache.size;

const preferJsOverCjsForExtensionlessFileSpecifier = (
  specifier: string,
  resolved: string
): string => {
  if (
    (specifier.startsWith('.') || path.isAbsolute(specifier)) &&
    path.extname(specifier) === '' &&
    resolved.endsWith('.cjs') &&
    fs.existsSync(`${resolved.slice(0, -4)}.js`)
  ) {
    return `${resolved.slice(0, -4)}.js`;
  }

  return resolved;
};

export const resolveWithNativeResolver = ({
  conditionNames,
  extensions,
  importer,
  kind,
  oxcOptions,
  specifier,
}: NativeResolverParams): string => {
  const { filename, query, hash } = parseRequest(specifier);
  const options = createResolverOptions({
    conditionNames,
    extensions,
    kind,
    oxcOptions,
  });
  const resolver = getResolver(options);
  const result = resolver.resolveFileSync(importer, filename);

  if (!result.path) {
    throw new Error(result.error ?? `Cannot resolve module ${specifier}`);
  }

  const resolved = preferJsOverCjsForExtensionlessFileSpecifier(
    filename,
    result.path
  );
  const suffix = `${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`;

  return `${resolved}${suffix}`;
};
