/**
 * This file contains a Vite loader for wyw-in-js.
 * It uses the transform.ts function to generate class names from source code,
 * returns transformed code without template literals and attaches generated source maps
 */

import { existsSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import path from 'path';

import { createFilter, loadEnv } from 'vite';
import type {
  ModuleNode,
  Plugin,
  ResolvedConfig,
  ViteDevServer,
  FilterPattern,
} from 'vite';

import {
  asyncResolverFactory,
  logger,
  mergeOxcResolverAlias,
  syncResolve,
  toNativeResolverAlias,
  type NativeResolverAlias,
} from '@wyw-in-js/shared';
import type {
  IFileReporterOptions,
  PluginOptions,
  Preprocessor,
  Result as TransformResult,
  TransformCacheCollection as TransformCacheCollectionType,
  WYWTransformDiagnostic,
} from '@wyw-in-js/transform';
import * as transformPkg from '@wyw-in-js/transform';

const {
  createTransformManifest,
  createFileReporter,
  disposeEvalBroker,
  getFileIdx,
  stringifyTransformManifest,
  transform,
  TransformCacheCollection,
} = transformPkg;

type MetadataManifest = NonNullable<TransformResult['metadata']> & {
  cssFile?: string;
  source: string;
  version: 1;
};

const createMetadataManifest = (
  metadata: NonNullable<TransformResult['metadata']>,
  context: Pick<MetadataManifest, 'cssFile' | 'source'>
): MetadataManifest =>
  typeof createTransformManifest === 'function'
    ? createTransformManifest(metadata, context)
    : {
        ...metadata,
        ...context,
        version: 1,
      };

const stringifyMetadataManifest = (manifest: MetadataManifest): string =>
  typeof stringifyTransformManifest === 'function'
    ? stringifyTransformManifest(manifest)
    : `${JSON.stringify(manifest, null, 2)}\n`;

type VitePluginOptions = {
  debug?: IFileReporterOptions | false | null | undefined;
  exclude?: FilterPattern;
  include?: FilterPattern;
  keepComments?: boolean | RegExp;
  prefixer?: boolean;
  preprocessor?: Preprocessor;
  preserveCssPaths?: boolean;
  sourceMap?: boolean;
  ssrDevCss?: boolean;
  ssrDevCssPath?: string;
  transformLibraries?: boolean;
} & Partial<PluginOptions>;

type OverrideContext = NonNullable<PluginOptions['overrideContext']>;
type OverrideContextArgs = Parameters<OverrideContext>;

export type { Plugin };

type AssetInfoLike = { name?: unknown };
type AssetFileNames = string | ((assetInfo: AssetInfoLike) => string);
type RollupOutputLike = {
  assetFileNames?: AssetFileNames;
  format?: unknown;
  preserveModules?: boolean;
  preserveModulesRoot?: unknown;
} & Record<string, unknown>;

type OutputAssetLike = {
  fileName: string;
  name?: unknown;
  names?: unknown;
  originalFileName?: unknown;
  originalFileNames?: unknown;
  type: 'asset';
};

type OutputChunkLike = {
  code: string;
  facadeModuleId?: unknown;
  fileName: string;
  moduleIds?: unknown;
  type: 'chunk';
};

type OutputBundleLike = Record<string, OutputAssetLike | OutputChunkLike>;

type CssReloadTarget = {
  moduleGraph: {
    getModuleById(id: string): ModuleNode | null | undefined;
  };
  reloadModule(module: ModuleNode): void;
};

const isWindowsAbsolutePath = (value: string): boolean =>
  /^[a-zA-Z]:[\\/]/.test(value);

const normalizeToPosix = (value: string): string =>
  value.replace(/\\/g, path.posix.sep);

const isInside = (childPath: string, parentPath: string): boolean => {
  const rel = path.relative(parentPath, childPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const isWywCssAssetName = (value: string): boolean =>
  value.endsWith('.wyw-in-js.css');

const normalizeAssetRelativePath = (value: string): string | null => {
  const normalized = path.posix.normalize(
    normalizeToPosix(value).replace(/^\/+/, '')
  );
  if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
    return null;
  }

  return normalized;
};

const stripExtension = (value: string): string => {
  const ext = path.posix.extname(value);
  return ext ? value.slice(0, -ext.length) : value;
};

const getComparableAssetPaths = (
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

const getStringValues = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  return value.filter((item): item is string => typeof item === 'string');
};

const getOutputAssetNames = (asset: OutputAssetLike): string[] => [
  ...(typeof asset.name === 'string' ? [asset.name] : []),
  ...getStringValues(asset.names),
  ...(typeof asset.originalFileName === 'string'
    ? [asset.originalFileName]
    : []),
  ...getStringValues(asset.originalFileNames),
];

const isOutputAssetLike = (value: unknown): value is OutputAssetLike =>
  !!value &&
  typeof value === 'object' &&
  (value as { type?: unknown }).type === 'asset' &&
  typeof (value as { fileName?: unknown }).fileName === 'string';

const isOutputChunkLike = (value: unknown): value is OutputChunkLike =>
  !!value &&
  typeof value === 'object' &&
  (value as { type?: unknown }).type === 'chunk' &&
  typeof (value as { fileName?: unknown }).fileName === 'string' &&
  typeof (value as { code?: unknown }).code === 'string';

const getTrackedModuleIdForChunk = (
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

const findWywCssAssetFileName = (
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

const getRelativeImportPath = (
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

const escapeForRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hasStaticImport = (code: string, specifier: string): boolean =>
  new RegExp(
    `(^|\\n)\\s*import\\s*(?:["']${escapeForRegExp(
      specifier
    )}["']|[^\\n;]+\\s+from\\s+["']${escapeForRegExp(specifier)}["'])`,
    'm'
  ).test(code);

const hasRequireCall = (code: string, specifier: string): boolean =>
  new RegExp(
    `(^|[;\\n])\\s*require\\(\\s*["']${escapeForRegExp(specifier)}["']\\s*\\)`,
    'm'
  ).test(code);

const getCssLoadStatement = (format: unknown, specifier: string): string =>
  format === 'cjs'
    ? `require(${JSON.stringify(specifier)});\n`
    : `import ${JSON.stringify(specifier)};\n`;

const hasCssLoadStatement = (
  code: string,
  specifier: string,
  format: unknown
): boolean =>
  format === 'cjs'
    ? hasRequireCall(code, specifier)
    : hasStaticImport(code, specifier);

const prependCssLoadStatement = (
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

const VITE_FS_PREFIX = '/@fs/';

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeViteFsPath = (value: string): string => {
  const fsPath = value.slice(VITE_FS_PREFIX.length);
  return path.normalize(safeDecodeURIComponent(fsPath));
};

const isCssReloadTarget = (value: unknown): value is CssReloadTarget => {
  if (!value || typeof value !== 'object') return false;

  const reloadTarget = value as Partial<CssReloadTarget>;
  return (
    !!reloadTarget.moduleGraph &&
    typeof reloadTarget.moduleGraph.getModuleById === 'function' &&
    typeof reloadTarget.reloadModule === 'function'
  );
};

const getCssReloadTarget = (
  environment: unknown,
  server: ViteDevServer | undefined
): CssReloadTarget | null => {
  if (isCssReloadTarget(environment)) {
    return environment;
  }

  if (server?.moduleGraph) {
    return {
      moduleGraph: server.moduleGraph,
      reloadModule: (module) => server.reloadModule(module),
    };
  }

  return null;
};

const getWywCssAssetFileNames = (
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

export default function wywInJS({
  debug,
  include,
  exclude,
  sourceMap,
  preserveCssPaths,
  keepComments,
  prefixer,
  preprocessor,
  ssrDevCss,
  ssrDevCssPath,
  transformLibraries,
  ...rest
}: VitePluginOptions = {}): Plugin {
  const supportedModuleExtensions = new Set([
    '.cjs',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.mts',
    '.ts',
    '.tsx',
  ]);
  const filter = createFilter(include, exclude);
  const cssLookup: { [key: string]: string } = {};
  const cssFileLookup: { [key: string]: string } = {};
  const metadataLookup: { [key: string]: string } = {};
  const cssFilesByModuleId = new Map<string, string>();
  const pendingCssReloads = new WeakMap<
    CssReloadTarget,
    { files: Set<string>; timer?: ReturnType<typeof setTimeout> }
  >();
  let ssrDevCssVersion = 0;
  let config: ResolvedConfig;
  let devServer: ViteDevServer;
  let importMetaEnvForEval: {
    client: Record<string, unknown>;
    ssr: Record<string, unknown>;
  } | null = null;
  let nativeResolverAlias: NativeResolverAlias = {};
  // transform() memoizes normalized options by object identity: [client, ssr]
  let pluginOptionsByEnv: Partial<PluginOptions>[] = [];
  const buildOverrideContext =
    (getEnv: () => Record<string, unknown> | undefined): OverrideContext =>
    (context: OverrideContextArgs[0], filename: OverrideContextArgs[1]) => {
      const env = getEnv();
      const withEnv = env
        ? { ...context, __wyw_import_meta_env: env }
        : context;

      return rest.overrideContext
        ? rest.overrideContext(withEnv, filename)
        : withEnv;
    };
  const overrideContextClient: OverrideContext = buildOverrideContext(
    () => importMetaEnvForEval?.client
  );
  const overrideContextSsr: OverrideContext = buildOverrideContext(
    () => importMetaEnvForEval?.ssr
  );

  const ssrDevCssEnabled = Boolean(ssrDevCss);
  const [ssrDevCssPathname, ssrDevCssQuery] = (
    ssrDevCssPath ?? '/_wyw-in-js/ssr.css'
  ).split('?', 2);
  const ssrDevCssRoute = ssrDevCssPathname.startsWith('/')
    ? ssrDevCssPathname
    : `/${ssrDevCssPathname}`;

  const getSsrDevCssHref = () => {
    const versionParam = `v=${ssrDevCssVersion}`;
    const query = ssrDevCssQuery
      ? `${ssrDevCssQuery}&${versionParam}`
      : versionParam;
    return `${ssrDevCssRoute}?${query}`;
  };

  const getSsrDevCssContents = () => {
    const entries = Object.entries(cssLookup);
    if (entries.length === 0) return '';

    const merged = entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, cssText]) => cssText)
      .join('\n');
    return `${merged}\n`;
  };

  const { emitter, onDone } = createFileReporter(debug ?? false);

  const isSafeAssetPath = (fileName: string) =>
    fileName !== '' &&
    fileName !== '..' &&
    !fileName.startsWith(`..${path.posix.sep}`) &&
    !path.posix.isAbsolute(fileName) &&
    !isWindowsAbsolutePath(fileName);

  const replaceModuleExtension = (filename: string, nextExtension: string) => {
    const extension = path.extname(filename);
    return supportedModuleExtensions.has(extension)
      ? `${filename.slice(0, -extension.length)}${nextExtension}`
      : `${filename}${nextExtension}`;
  };

  const toBundleRelativePath = (filename: string) => {
    const relativePath = normalizeToPosix(path.relative(config.root, filename));

    if (isSafeAssetPath(relativePath)) {
      return relativePath;
    }

    if (
      !path.isAbsolute(relativePath) &&
      !isWindowsAbsolutePath(relativePath)
    ) {
      return path.posix.join(
        '_wyw-in-js',
        'external',
        ...relativePath
          .split(path.posix.sep)
          .filter(Boolean)
          .map((segment) => (segment === '..' ? '__up__' : segment))
      );
    }

    return path.posix.join(
      '_wyw-in-js',
      'external',
      ...normalizeToPosix(path.resolve(filename))
        .split(path.posix.sep)
        .filter(Boolean)
        .map((segment) => segment.replace(/:$/, ''))
    );
  };
  const scheduleCssReload = (
    reloadTarget: CssReloadTarget,
    cssFilename: string
  ) => {
    let state = pendingCssReloads.get(reloadTarget);
    if (!state) {
      state = { files: new Set() };
      pendingCssReloads.set(reloadTarget, state);
    }
    state.files.add(cssFilename);

    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;

      const ids = Array.from(state.files);
      state.files.clear();

      const { moduleGraph } = reloadTarget;
      for (const id of ids) {
        const module = moduleGraph.getModuleById(id);
        if (module) reloadTarget.reloadModule(module);
      }
    }, 0);
  };

  // <dependency id, targets>
  const targets: { dependencies: string[]; id: string }[] = [];
  const clientCache = new TransformCacheCollection();
  const ssrCache = new TransformCacheCollection();
  const caches = new Set<TransformCacheCollectionType>([clientCache, ssrCache]);
  let evalBrokersDisposed = false;

  const disposeEvalBrokers = () => {
    if (evalBrokersDisposed) return;
    evalBrokersDisposed = true;
    for (const cache of caches) {
      disposeEvalBroker(cache);
    }
  };

  const getCache = (isSsr: boolean): TransformCacheCollectionType =>
    isSsr ? ssrCache : clientCache;

  type DepInfoLike = { file: string; processing?: Promise<void> };
  type DepsOptimizerLike = {
    init?: () => Promise<void>;
    isOptimizedDepFile?: (id: string) => boolean;
    metadata?: { depInfoList?: DepInfoLike[] };
    scanProcessing?: Promise<void>;
  };

  type ViteServerWithDepsOptimizer = ViteDevServer & {
    _depsOptimizer?: DepsOptimizerLike;
    depsOptimizer?: DepsOptimizerLike;
    environments?: Record<string, { depsOptimizer?: DepsOptimizerLike }>;
  };

  const isInsideCacheDir = (filename: string): boolean => {
    if (!config.cacheDir) {
      return false;
    }

    const relative = path.relative(config.cacheDir, filename);
    return (
      relative !== '' &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative)
    );
  };

  const getDepsOptimizer = (): DepsOptimizerLike | null => {
    if (!devServer) return null;

    const server = devServer as unknown as ViteServerWithDepsOptimizer;
    return (
      server.environments?.client?.depsOptimizer ??
      server.depsOptimizer ??
      server._depsOptimizer ??
      null
    );
  };

  const waitForOptimizedDep = async (filename: string): Promise<boolean> => {
    const depsOptimizer = getDepsOptimizer();
    if (!depsOptimizer?.isOptimizedDepFile?.(filename)) {
      return false;
    }

    await depsOptimizer.init?.();
    await depsOptimizer.scanProcessing;

    const info = depsOptimizer.metadata?.depInfoList?.find(
      (item) => item.file === filename
    );
    if (info?.processing) {
      await info.processing;
    }

    return true;
  };

  type ViteResolver = ReturnType<ResolvedConfig['createResolver']>;
  type ViteResolverResult = Awaited<ReturnType<ViteResolver>>;
  type ResolveFn = (
    what: string,
    importer: string
  ) => Promise<ViteResolverResult>;

  let viteResolver: ViteResolver | null = null;

  const resolveClient: ResolveFn = (what, importer) => {
    if (!viteResolver) {
      throw new Error('Vite resolver is not initialized yet');
    }

    return viteResolver(what, importer, false, false);
  };

  const resolveSsr: ResolveFn = (what, importer) => {
    if (!viteResolver) {
      throw new Error('Vite resolver is not initialized yet');
    }

    return viteResolver(what, importer, false, true);
  };

  const createAsyncResolver = asyncResolverFactory(
    async (
      resolved: ViteResolverResult,
      what: string,
      importer: string,
      stack: string[]
    ): Promise<string | null> => {
      const log = logger.extend('vite').extend(getFileIdx(importer));

      if (resolved) {
        log("resolve ✅ '%s'@'%s -> %O\n%s", what, importer, resolved);

        // Vite adds param like `?v=667939b3` to cached modules
        let resolvedId = resolved.split('?', 1)[0];

        if (resolvedId.startsWith('\0')) {
          // \0 is a special character in Rollup that tells Rollup to not include this in the bundle
          // https://rollupjs.org/guide/en/#outputexports
          return null;
        }

        if (resolvedId.startsWith(VITE_FS_PREFIX)) {
          resolvedId = normalizeViteFsPath(resolvedId);
        }

        if (resolvedId.startsWith('/@')) {
          return null;
        }

        if (!existsSync(resolvedId)) {
          // When Vite resolves to an optimized deps entry (cacheDir) it may not be written yet.
          // Wait for Vite's optimizer instead of calling optimizeDeps() manually (deprecated in Vite 7).
          try {
            await waitForOptimizedDep(resolvedId);
          } catch {
            // If optimizer failed, fall through to preserve previous behavior and surface the error.
          }

          // Vite can return an optimized deps entry (from cacheDir) before it's written to disk.
          // Manually calling optimizeDeps is deprecated in Vite 7 and can also get called many times.
          // Instead, fall back to resolving the original module path directly.
          if (!existsSync(resolvedId) && isInsideCacheDir(resolvedId)) {
            try {
              return syncResolve(what, importer, stack);
            } catch {
              // Fall through to preserve previous behavior: return resolvedId and let WyW surface the error.
            }
          }
        }

        if (!existsSync(resolvedId) && !path.isAbsolute(resolvedId)) {
          // Vite can resolve an import to a bare specifier when bundling for SSR and marking it as external.
          // In that case we still need a real file path for WyW evaluation.
          return syncResolve(what, importer, stack);
        }

        return resolvedId;
      }

      log("resolve ❌ '%s'@'%s", what, importer);

      // Vite can inject virtual ids like /@react-refresh in dev.
      if (what.startsWith('/@') || what.startsWith('\0')) {
        return null;
      }

      if (
        !what.startsWith('.') &&
        !what.startsWith('/') &&
        !path.isAbsolute(what)
      ) {
        // Keep compatibility with SSR externalization: fall back to Node resolution for bare specifiers.
        return syncResolve(what, importer, stack);
      }

      throw new Error(`Could not resolve ${what}`);
    },
    (what: Parameters<ResolveFn>[0], importer: Parameters<ResolveFn>[1]) => [
      what,
      importer,
    ]
  );

  const asyncResolveClient = createAsyncResolver(resolveClient);
  const asyncResolveSsr = createAsyncResolver(resolveSsr);

  return {
    name: 'wyw-in-js',
    enforce: 'post',
    buildStart() {
      Object.keys(metadataLookup).forEach((key) => {
        delete metadataLookup[key];
      });
    },
    buildEnd() {
      onDone(process.cwd());
      if (config.command === 'build') {
        disposeEvalBrokers();
      }
    },
    configResolved(resolvedConfig: ResolvedConfig) {
      config = resolvedConfig;
      viteResolver = config.createResolver();
      nativeResolverAlias = toNativeResolverAlias(config.resolve?.alias);
      const oxcOptions = mergeOxcResolverAlias(
        rest.oxcOptions,
        nativeResolverAlias
      );
      pluginOptionsByEnv = [overrideContextClient, overrideContextSsr].map(
        (overrideContext) => ({ ...rest, oxcOptions, overrideContext })
      );

      if (preserveCssPaths && config.command === 'build') {
        const outputs = config.build.rollupOptions.output;
        let outputEntries: unknown[] = [];
        if (Array.isArray(outputs)) {
          outputEntries = outputs;
        } else if (outputs) {
          outputEntries = [outputs];
        }

        outputEntries.forEach((entry) => {
          if (!entry || typeof entry !== 'object') return;

          const output = entry as RollupOutputLike;
          if (!output.preserveModules) return;

          const template: AssetFileNames =
            output.assetFileNames ??
            `${config.build.assetsDir ?? 'assets'}/[name].[hash].[ext]`;

          const assetFileNames = getWywCssAssetFileNames(
            config,
            output,
            template
          );
          if (assetFileNames) output.assetFileNames = assetFileNames;
        });
      }

      const envPrefix = config.envPrefix ?? 'VITE_';
      const envDir =
        // envDir is absolute in modern Vite, but keep a fallback for older versions
        'envDir' in config && typeof config.envDir === 'string'
          ? config.envDir
          : config.root;

      const loaded = loadEnv(config.mode, envDir, envPrefix);
      const base = {
        ...loaded,
        BASE_URL: config.base,
        MODE: config.mode,
        DEV: config.command === 'serve',
        PROD: config.command === 'build',
      };

      importMetaEnvForEval = {
        client: { ...base, SSR: false },
        ssr: { ...base, SSR: true },
      };
    },
    configureServer(_server) {
      devServer = _server;
      devServer.httpServer?.once('close', disposeEvalBrokers);

      if (ssrDevCssEnabled && config.command === 'serve') {
        devServer.middlewares.use(
          (req: IncomingMessage, res: ServerResponse, next: () => void) => {
            const { url } = req;
            if (!url) {
              next();
              return;
            }

            const [pathname] = url.split('?', 1);
            if (pathname !== ssrDevCssRoute) {
              next();
              return;
            }

            const etag = `W/"${ssrDevCssVersion}"`;
            const ifNoneMatch = req.headers['if-none-match'];
            if (ifNoneMatch === etag) {
              res.statusCode = 304;
              res.end();
              return;
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('ETag', etag);
            res.end(getSsrDevCssContents());
          }
        );
      }
    },
    transformIndexHtml(html) {
      if (!ssrDevCssEnabled || config.command !== 'serve') return undefined;

      return {
        html,
        tags: [
          {
            tag: 'link',
            attrs: { rel: 'stylesheet', href: getSsrDevCssHref() },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
    load(url: string) {
      const [id] = url.split('?', 1);
      return cssLookup[id];
    },
    /* eslint-disable-next-line consistent-return */
    resolveId(importeeUrl: string) {
      const [id] = importeeUrl.split('?', 1);
      if (cssLookup[id]) return id;
      return cssFileLookup[id];
    },
    handleHotUpdate(ctx) {
      // it's module, so just transform it
      if (ctx.modules.length) return ctx.modules;

      // Select affected modules of changed dependency
      const affected = targets.filter(
        (x) =>
          // file is dependency of any target
          x.dependencies.some((dep) => dep === ctx.file) ||
          // or changed module is a dependency of any target
          x.dependencies.some((dep) => ctx.modules.some((m) => m.file === dep))
      );
      const deps = affected.flatMap((target) => target.dependencies);

      // eslint-disable-next-line no-restricted-syntax
      for (const depId of deps) {
        for (const cache of caches) {
          cache.invalidateForFile(depId);
        }
      }

      return affected
        .map((target) => devServer.moduleGraph.getModuleById(target.id))
        .concat(ctx.modules)
        .filter((m): m is ModuleNode => !!m);
    },
    generateBundle(outputOptions, bundle) {
      Object.entries(metadataLookup).forEach(([fileName, source]) => {
        this.emitFile({
          fileName,
          source,
          type: 'asset',
        });
      });

      if (config.command !== 'build') return;
      if (!outputOptions.preserveModules) return;
      if (config.build.cssCodeSplit === false) return;

      Object.values(bundle as OutputBundleLike).forEach((item) => {
        if (!isOutputChunkLike(item)) {
          return;
        }

        const chunk = item;

        const moduleId = getTrackedModuleIdForChunk(chunk, cssFilesByModuleId);
        if (!moduleId) {
          return;
        }

        const cssFilename = cssFilesByModuleId.get(moduleId);
        if (!cssFilename) {
          return;
        }

        const emittedCssFileName = findWywCssAssetFileName(
          bundle as OutputBundleLike,
          cssFilename,
          config.root
        );
        if (!emittedCssFileName) {
          return;
        }

        const relativeCssImport = getRelativeImportPath(
          chunk.fileName,
          emittedCssFileName
        );
        if (
          hasCssLoadStatement(
            chunk.code,
            relativeCssImport,
            outputOptions.format
          )
        ) {
          return;
        }

        chunk.code = prependCssLoadStatement(
          chunk.code,
          relativeCssImport,
          outputOptions.format
        );
      });
    },
    async transform(
      code: string,
      url: string,
      transformOptions?: boolean | { ssr?: boolean }
    ) {
      const [id] = url.split('?', 1);

      // Do not transform ignored and generated files
      if (
        (!transformLibraries && url.includes('node_modules')) ||
        !filter(url) ||
        id in cssLookup
      )
        return;

      const log = logger.extend('vite').extend(getFileIdx(id));

      log('transform %s', id);

      const isSsr =
        typeof transformOptions === 'boolean'
          ? transformOptions
          : Boolean(transformOptions?.ssr);

      const transformServices = {
        options: {
          filename: id,
          root: process.cwd(),
          prefixer,
          keepComments,
          preprocessor,
          pluginOptions: pluginOptionsByEnv[isSsr ? 1 : 0],
        },
        cache: getCache(isSsr),
        emitWarning: (message: string) => this.warn(message),
        eventEmitter: emitter,
      };

      const asyncResolve = isSsr ? asyncResolveSsr : asyncResolveClient;

      const result: TransformResult = await transform(
        transformServices,
        code,
        asyncResolve
      );

      result.diagnostics?.forEach((diagnostic: WYWTransformDiagnostic) => {
        this.warn({
          id: diagnostic.filename,
          loc: diagnostic.start
            ? {
                column: diagnostic.start.column,
                file: diagnostic.filename,
                line: diagnostic.start.line,
              }
            : undefined,
          message: `[wyw-in-js] ${diagnostic.severity} [${diagnostic.category}] ${diagnostic.message}`,
          pluginCode: diagnostic.category,
        });
      });

      const relativeId = normalizeToPosix(path.relative(config.root, id));
      const metadataFilename = replaceModuleExtension(id, '.wyw-in-js.json');
      const metadataRelativePath = toBundleRelativePath(metadataFilename);

      delete metadataLookup[metadataRelativePath];

      if (result.metadata) {
        const cssFile =
          typeof result.cssText === 'string' && result.cssText !== ''
            ? replaceModuleExtension(relativeId, '.wyw-in-js.css')
            : undefined;

        metadataLookup[metadataRelativePath] = stringifyMetadataManifest(
          createMetadataManifest(result.metadata, {
            cssFile,
            source: relativeId,
          })
        );
      }

      let { cssText, dependencies } = result;

      // Heads up, there are three cases:
      // 1. cssText is undefined, it means that file was not transformed
      // 2. cssText is empty, it means that file was transformed, but it does not contain any styles
      // 3. cssText is not empty, it means that file was transformed and it contains styles

      if (typeof cssText === 'undefined') {
        cssFilesByModuleId.delete(id);
        return;
      }

      if (cssText === '') {
        cssFilesByModuleId.delete(id);
        /* eslint-disable-next-line consistent-return */
        return {
          code: result.code,
          map: result.sourceMap,
        };
      }

      dependencies ??= [];

      const cssFilename = normalizeToPosix(
        replaceModuleExtension(id, '.wyw-in-js.css')
      );
      cssFilesByModuleId.set(id, cssFilename);

      const cssRelativePath = normalizeToPosix(
        path.relative(config.root, cssFilename)
      );

      const cssId = `/${cssRelativePath}`;

      if (sourceMap && result.cssSourceMapText) {
        const map = Buffer.from(result.cssSourceMapText).toString('base64');
        cssText += `/*# sourceMappingURL=data:application/json;base64,${map}*/`;
      }

      const didCssChange = cssLookup[cssFilename] !== cssText;
      cssLookup[cssFilename] = cssText;
      cssFileLookup[cssId] = cssFilename;

      result.code += `\nimport ${JSON.stringify(cssFilename)};\n`;

      for (let i = 0, end = dependencies.length; i < end; i++) {
        // eslint-disable-next-line no-await-in-loop
        const depModule = await this.resolve(dependencies[i], url, {
          isEntry: false,
        });
        if (depModule) dependencies[i] = depModule.id;
      }
      const target = targets.find((t) => t.id === id);
      if (!target) targets.push({ id, dependencies });
      else target.dependencies = dependencies;

      if (didCssChange) {
        const reloadTarget = getCssReloadTarget(
          (this as typeof this & { environment?: unknown }).environment,
          devServer
        );
        if (reloadTarget) {
          scheduleCssReload(reloadTarget, cssFilename);
        }
        if (ssrDevCssEnabled && config.command === 'serve') {
          ssrDevCssVersion += 1;
        }
      }
      /* eslint-disable-next-line consistent-return */
      return { code: result.code, map: result.sourceMap };
    },
  };
}
