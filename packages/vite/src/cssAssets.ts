import path from 'path';

import type { ModuleNode, ResolvedConfig } from 'vite';

export type AssetInfoLike = { name?: unknown };
export type AssetFileNames = string | ((assetInfo: AssetInfoLike) => string);
export type RollupOutputLike = {
  assetFileNames?: AssetFileNames;
  format?: unknown;
  preserveModules?: boolean;
  preserveModulesRoot?: unknown;
} & Record<string, unknown>;

export type OutputAssetLike = {
  fileName: string;
  name?: unknown;
  names?: unknown;
  originalFileName?: unknown;
  originalFileNames?: unknown;
  type: 'asset';
};

export type OutputChunkLike = {
  code: string;
  facadeModuleId?: unknown;
  fileName: string;
  moduleIds?: unknown;
  type: 'chunk';
};

export type OutputBundleLike = Record<
  string,
  OutputAssetLike | OutputChunkLike
>;

export type CssReloadTarget = {
  moduleGraph: {
    getModuleById(id: string): ModuleNode | null | undefined;
  };
  reloadModule(module: ModuleNode): void;
};

export const isWindowsAbsolutePath = (value: string): boolean =>
  /^[a-zA-Z]:[\\/]/.test(value);

export const normalizeToPosix = (value: string): string =>
  value.replace(/\\/g, path.posix.sep);

export const isInside = (childPath: string, parentPath: string): boolean => {
  const rel = path.relative(parentPath, childPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export const isWywCssAssetName = (value: string): boolean =>
  value.endsWith('.wyw-in-js.css');

export const normalizeAssetRelativePath = (value: string): string | null => {
  const normalized = path.posix.normalize(
    normalizeToPosix(value).replace(/^\/+/, '')
  );
  if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
    return null;
  }

  return normalized;
};

export const stripExtension = (value: string): string => {
  const ext = path.posix.extname(value);
  return ext ? value.slice(0, -ext.length) : value;
};

export const getComparableAssetPaths = (
  value: string,
  rootDir: string
): Set<string> => {
  const variants = new Set<string>();
  const normalized = normalizeToPosix(value);

  variants.add(normalized);

  if (path.isAbsolute(value) || isWindowsAbsolutePath(normalized)) {
    if (isInside(value, rootDir)) {
      const relativeToRoot = normalizeAssetRelativePath(
        path.relative(rootDir, value)
      );
      if (relativeToRoot) {
        variants.add(relativeToRoot);
      }
    }

    return variants;
  }

  const relativePath = normalizeAssetRelativePath(value);
  if (relativePath) {
    variants.add(relativePath);
  }

  return variants;
};

export const getStringValues = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  return value.filter((item): item is string => typeof item === 'string');
};

export const getOutputAssetNames = (asset: OutputAssetLike): string[] => [
  ...(typeof asset.name === 'string' ? [asset.name] : []),
  ...getStringValues(asset.names),
  ...(typeof asset.originalFileName === 'string'
    ? [asset.originalFileName]
    : []),
  ...getStringValues(asset.originalFileNames),
];

export const isOutputAssetLike = (value: unknown): value is OutputAssetLike =>
  !!value &&
  typeof value === 'object' &&
  (value as { type?: unknown }).type === 'asset' &&
  typeof (value as { fileName?: unknown }).fileName === 'string';

export const isOutputChunkLike = (value: unknown): value is OutputChunkLike =>
  !!value &&
  typeof value === 'object' &&
  (value as { type?: unknown }).type === 'chunk' &&
  typeof (value as { fileName?: unknown }).fileName === 'string' &&
  typeof (value as { code?: unknown }).code === 'string';

export const getTrackedModuleIdForChunk = (
  chunk: OutputChunkLike,
  cssFilesByModuleId: Map<string, string>
): string | null => {
  if (
    typeof chunk.facadeModuleId === 'string' &&
    cssFilesByModuleId.has(chunk.facadeModuleId)
  ) {
    return chunk.facadeModuleId;
  }

  if (!Array.isArray(chunk.moduleIds)) {
    return null;
  }

  const moduleId = chunk.moduleIds.find(
    (id): id is string => typeof id === 'string' && cssFilesByModuleId.has(id)
  );

  return moduleId ?? null;
};

export const findWywCssAssetFileName = (
  bundle: OutputBundleLike,
  cssFilename: string,
  rootDir: string
): string | null => {
  const expectedNames = getComparableAssetPaths(cssFilename, rootDir);

  for (const item of Object.values(bundle)) {
    if (isOutputAssetLike(item) && item.fileName.endsWith('.css')) {
      const isMatch = getOutputAssetNames(item).some((assetName) => {
        const variants = getComparableAssetPaths(assetName, rootDir);
        return Array.from(variants).some((variant) =>
          expectedNames.has(variant)
        );
      });

      if (isMatch) {
        return normalizeToPosix(item.fileName);
      }
    }
  }

  return null;
};

export const getRelativeImportPath = (
  fromFileName: string,
  toFileName: string
): string => {
  const fromDir = path.posix.dirname(normalizeToPosix(fromFileName));
  const relativePath = path.posix.relative(
    fromDir,
    normalizeToPosix(toFileName)
  );

  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
};

export const escapeForRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const hasStaticImport = (code: string, specifier: string): boolean =>
  new RegExp(
    `(^|\\n)\\s*import\\s*(?:["']${escapeForRegExp(
      specifier
    )}["']|[^\\n;]+\\s+from\\s+["']${escapeForRegExp(specifier)}["'])`,
    'm'
  ).test(code);

export const hasRequireCall = (code: string, specifier: string): boolean =>
  new RegExp(
    `(^|[;\\n])\\s*require\\(\\s*["']${escapeForRegExp(specifier)}["']\\s*\\)`,
    'm'
  ).test(code);

export const getCssLoadStatement = (
  format: unknown,
  specifier: string
): string =>
  format === 'cjs'
    ? `require(${JSON.stringify(specifier)});\n`
    : `import ${JSON.stringify(specifier)};\n`;

export const hasCssLoadStatement = (
  code: string,
  specifier: string,
  format: unknown
): boolean =>
  format === 'cjs'
    ? hasRequireCall(code, specifier)
    : hasStaticImport(code, specifier);

export const prependCssLoadStatement = (
  code: string,
  specifier: string,
  format: unknown
): string => {
  const statement = getCssLoadStatement(format, specifier);
  let insertAt = 0;

  if (code.startsWith('#!')) {
    const lineBreakIndex = code.indexOf('\n');
    if (lineBreakIndex >= 0) {
      insertAt = lineBreakIndex + 1;
    } else {
      return `${code}\n${statement}`;
    }
  }

  if (format === 'cjs') {
    const directiveMatch =
      /^(?:\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*');)+/.exec(
        code.slice(insertAt)
      );

    if (directiveMatch) {
      insertAt += directiveMatch[0].length;
    }
  }

  return `${code.slice(0, insertAt)}${statement}${code.slice(insertAt)}`;
};

export const getWywCssAssetFileNames = (
  resolvedConfig: ResolvedConfig,
  output: RollupOutputLike,
  originalAssetFileNames: AssetFileNames
): ((assetInfo: AssetInfoLike) => string) | null => {
  if (!output.preserveModules) return null;

  const rootDir = resolvedConfig.root;

  const preserveModulesRootValue = output.preserveModulesRoot;
  let preserveModulesRootAbs: string | null = null;
  if (typeof preserveModulesRootValue === 'string') {
    preserveModulesRootAbs = path.isAbsolute(preserveModulesRootValue)
      ? preserveModulesRootValue
      : path.resolve(rootDir, preserveModulesRootValue);
  }

  const preserveModulesRootRel =
    preserveModulesRootAbs && isInside(preserveModulesRootAbs, rootDir)
      ? normalizeToPosix(path.relative(rootDir, preserveModulesRootAbs))
      : null;

  return (assetInfo) => {
    const template =
      typeof originalAssetFileNames === 'function'
        ? originalAssetFileNames(assetInfo)
        : originalAssetFileNames;

    const assetName = assetInfo?.name;
    if (typeof assetName !== 'string' || !isWywCssAssetName(assetName)) {
      return template;
    }

    if (!template.includes('[')) {
      return template;
    }

    let relativePath: string | null = null;

    const assetNameNormalized = normalizeToPosix(assetName);

    if (
      path.isAbsolute(assetName) ||
      isWindowsAbsolutePath(assetNameNormalized)
    ) {
      const preserveRel =
        preserveModulesRootAbs && isInside(assetName, preserveModulesRootAbs)
          ? path.relative(preserveModulesRootAbs, assetName)
          : null;

      if (
        preserveRel &&
        !path.isAbsolute(preserveRel) &&
        !preserveRel.startsWith('..')
      ) {
        relativePath = preserveRel;
      } else if (isInside(assetName, rootDir)) {
        relativePath = path.relative(rootDir, assetName);
      }
    } else if (
      preserveModulesRootRel &&
      assetNameNormalized.startsWith(`${preserveModulesRootRel}/`)
    ) {
      relativePath = assetNameNormalized.slice(
        preserveModulesRootRel.length + 1
      );
    } else {
      relativePath = assetNameNormalized;
    }

    const normalized = relativePath
      ? normalizeAssetRelativePath(relativePath)
      : null;
    if (!normalized) {
      return template;
    }

    const withoutExt = stripExtension(normalized);

    if (template.includes('[name]')) {
      const dir = path.posix.dirname(withoutExt);
      if (dir === '.' || dir === '') {
        return template;
      }

      return template.replace(/\[name\]/g, `${dir}/[name]`);
    }

    const dir = path.posix.dirname(withoutExt);
    if (dir === '.' || dir === '') {
      return template;
    }

    const idx = template.indexOf('[');
    if (idx < 0) {
      return template;
    }

    const prefix = template.slice(0, idx);
    if (prefix !== '' && !prefix.endsWith('/')) {
      return template;
    }

    return `${prefix}${dir}/${template.slice(idx)}`;
  };
};
