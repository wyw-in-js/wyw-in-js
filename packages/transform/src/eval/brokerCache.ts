import { oxcShaker } from '../shaker';
import { isSuperSet } from '../transform/Entrypoint.helpers';
import { collectOxcExportsAndImports } from '../utils/collectOxcExportsAndImports';

import type { EpochServices } from './brokerSession';
import { serializeValue, type SerializedValue } from './serialize';

export const isEvalOnlyKey = (key: string) =>
  key === '__wywPreval' || key === 'side-effect';

const isPreparedOnlySuperSet = (
  currentOnly: string[],
  requestedOnly: string[]
): boolean => {
  if (
    requestedOnly.includes('__wywPreval') &&
    !currentOnly.includes('__wywPreval')
  ) {
    return false;
  }

  return isSuperSet(currentOnly, requestedOnly);
};

const hasPreparedExportKeys = (
  prepared: {
    code?: string;
    exports?: Record<string, SerializedValue>;
  },
  requestedOnly: string[]
): boolean => {
  const requestedKeys = requestedOnly.filter(
    (key) => !isEvalOnlyKey(key) && key !== '*'
  );

  if (requestedKeys.length === 0) {
    return true;
  }

  if (!prepared.exports) {
    if (!prepared.code) {
      return false;
    }

    try {
      const collected = collectOxcExportsAndImports(
        prepared.code,
        'prepared-module.js'
      );
      if (collected.reexports.some((reexport) => reexport.exported === '*')) {
        return true;
      }

      const exportNames = new Set([
        ...Object.keys(collected.exports),
        ...collected.reexports
          .filter((reexport) => reexport.exported !== '*')
          .map((reexport) => reexport.exported),
      ]);

      return requestedKeys.every((key) => exportNames.has(key));
    } catch {
      return false;
    }
  }

  return requestedKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(prepared.exports, key)
  );
};

export const isPreparedCacheHit = (
  prepared: {
    exports?: Record<string, SerializedValue>;
    only: string[];
  },
  requestedOnly: string[]
): boolean =>
  isPreparedOnlySuperSet(prepared.only, requestedOnly) &&
  hasPreparedExportKeys(prepared, requestedOnly);

const isExportContainer = (
  value: unknown
): value is Record<string | symbol, unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

const hasCachedExport = (
  source: Record<string | symbol, unknown>,
  key: string
) => {
  if (Object.prototype.hasOwnProperty.call(source, key)) {
    return true;
  }
  if (key === 'default') {
    return false;
  }
  const fallback = source.default;
  return (
    isExportContainer(fallback) &&
    Object.prototype.hasOwnProperty.call(fallback, key)
  );
};

const resolveCachedExport = (
  source: Record<string | symbol, unknown>,
  key: string
) => {
  if (key === 'default') {
    return Object.prototype.hasOwnProperty.call(source, 'default')
      ? (source as Record<string, unknown>).default
      : undefined;
  }

  if (Object.prototype.hasOwnProperty.call(source, key)) {
    return (source as Record<string, unknown>)[key];
  }

  const fallback = (source as Record<string, unknown>).default;
  if (
    isExportContainer(fallback) &&
    Object.prototype.hasOwnProperty.call(fallback, key)
  ) {
    return (fallback as Record<string, unknown>)[key];
  }

  return undefined;
};

export const serializeCachedExports = (
  exportsValue: Record<string | symbol, unknown>,
  requiredOnly: string[]
): Record<string, SerializedValue> | null => {
  if (requiredOnly.some(isEvalOnlyKey)) {
    return null;
  }

  const keys = requiredOnly.includes('*')
    ? Object.keys(exportsValue).filter((key) => !isEvalOnlyKey(key))
    : requiredOnly.filter((key) => !isEvalOnlyKey(key));

  if (keys.length === 0) {
    return null;
  }

  const serialized: Record<string, SerializedValue> = {};
  for (const key of keys) {
    if (!hasCachedExport(exportsValue, key)) {
      return null;
    }
    try {
      const encoded = serializeValue(resolveCachedExport(exportsValue, key));
      if (encoded.kind === 'function') {
        return null;
      }
      serialized[key] = encoded;
    } catch {
      return null;
    }
  }

  return serialized;
};

export type CachedExportEntrypointLike = {
  evaluatedOnly?: string[];
  exports?: Record<string | symbol, unknown>;
  loadedAndParsed?: {
    code?: string;
    evalConfig?: { filename?: null | string };
    evaluator?: unknown;
  };
};

export const collectKnownExportNames = (
  services: EpochServices,
  id: string,
  cachedEntrypoint?: CachedExportEntrypointLike,
  publish = true
): string[] | undefined => {
  let knownExports = services.cache.get('exports', id) as string[] | undefined;
  if (knownExports || !cachedEntrypoint) {
    return knownExports;
  }

  const { loadedAndParsed } = cachedEntrypoint;
  if (loadedAndParsed?.evaluator !== oxcShaker || !loadedAndParsed.code) {
    return undefined;
  }

  const analyzed = collectOxcExportsAndImports(
    loadedAndParsed.code,
    loadedAndParsed.evalConfig?.filename ?? id
  );
  if (analyzed.reexports.some((reexport) => reexport.exported === '*')) {
    return undefined;
  }

  knownExports = Array.from(
    new Set([
      ...Object.keys(analyzed.exports),
      ...analyzed.reexports.map((reexport) => reexport.exported),
    ])
  );
  if (publish) {
    services.cache.publish(services.cacheEpoch, 'exports', id, knownExports);
  }
  return knownExports;
};

export const getSerializableStaticImportKeys = (
  services: EpochServices,
  id: string,
  cachedEntrypoint: CachedExportEntrypointLike,
  requiredOnly: string[],
  request?: string | null,
  importerId?: string | null
): string[] | null => {
  const isStaticImportLoad = Boolean(request && importerId);
  const requestedExports = requiredOnly.includes('*')
    ? null
    : requiredOnly.filter((key) => !isEvalOnlyKey(key) && key !== '*');
  const knownExports = collectKnownExportNames(
    services,
    id,
    cachedEntrypoint
  )?.filter((key) => !isEvalOnlyKey(key) && key !== '*');

  if (isStaticImportLoad) {
    if (
      !requestedExports?.length ||
      !knownExports?.length ||
      !isSuperSet(cachedEntrypoint.evaluatedOnly ?? [], knownExports)
    ) {
      return null;
    }

    if (!requestedExports.every((key) => knownExports.includes(key))) {
      return null;
    }

    return isSuperSet(cachedEntrypoint.evaluatedOnly ?? [], requestedExports)
      ? requestedExports
      : null;
  }

  if (knownExports?.length) {
    return isSuperSet(cachedEntrypoint.evaluatedOnly ?? [], knownExports)
      ? knownExports
      : null;
  }

  const evaluatedOnly = cachedEntrypoint.evaluatedOnly ?? requiredOnly;
  return requiredOnly.includes('*') ? evaluatedOnly : requiredOnly;
};
