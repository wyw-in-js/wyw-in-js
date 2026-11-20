import fs from 'node:fs';
import Module, { createRequire } from 'module';
import path from 'path';
import { pathToFileURL } from 'url';

import { cosmiconfigSync } from 'cosmiconfig';

import { mergeOxcResolverAlias } from '@wyw-in-js/shared';
import type {
  EvalOptionsV2,
  FeatureFlags,
  ImportLoaders,
  NativeResolverAlias,
  OxcOptions,
  StrictOptions,
} from '@wyw-in-js/shared';

import { shaker } from '../../shaker';
import { DEFAULT_EVAL_OPTIONS } from '../../utils/evalOptions';
import { omitUndefined } from '../../utils/omitUndefined';
import { warnAboutLoadedOptions } from './onceWarnings';
import type { PluginOptions } from '../../types';
import { DEFAULT_EVAL_STRATEGY } from '../../utils/evalStrategy';

/** Where the config file is looked for, relative to each directory. */
export const searchPlaces = [
  `.wyw-in-jsrc`,
  `.wyw-in-jsrc.json`,
  `.wyw-in-jsrc.yaml`,
  `.wyw-in-jsrc.yml`,
  `.wyw-in-jsrc.mjs`,
  `.wyw-in-jsrc.js`,
  `.wyw-in-jsrc.cjs`,
  `.config/wyw-in-jsrc`,
  `.config/wyw-in-jsrc.json`,
  `.config/wyw-in-jsrc.yaml`,
  `.config/wyw-in-jsrc.yml`,
  `.config/wyw-in-jsrc.mjs`,
  `.config/wyw-in-jsrc.js`,
  `.config/wyw-in-jsrc.cjs`,
  `wyw-in-js.config.mjs`,
  `wyw-in-js.config.js`,
  `wyw-in-js.config.cjs`,
];

type TsConfig = { compilerOptions?: Record<string, unknown> };

/** The part of the TypeScript compiler API that compiles a config file. */
type TypeScriptCompiler = {
  ModuleKind: { NodeNext: number };
  ModuleResolutionKind: { NodeNext: number };
  ScriptTarget: { ES2022: number };
  findConfigFile(
    directory: string,
    fileExists: (fileName: string) => boolean
  ): string | undefined;
  readConfigFile(
    fileName: string,
    readFile: (fileName: string) => string | undefined
  ): { config?: TsConfig; error?: { messageText: unknown } };
  sys: {
    fileExists(fileName: string): boolean;
    readFile(fileName: string): string | undefined;
  };
  transpileModule(input: string, options: TsConfig): { outputText: string };
};

const { _nodeModulePaths: nodeModulePaths } = Module as typeof Module & {
  _nodeModulePaths(directory: string): string[];
};

// Resolved like cosmiconfig resolves it. TypeScript 7 ships no compiler API.
let typeScriptCompiler: TypeScriptCompiler | null | undefined;
const getTypeScriptCompiler = (): TypeScriptCompiler | null => {
  if (typeScriptCompiler === undefined) {
    try {
      const candidate = createRequire(
        createRequire(import.meta.url).resolve('cosmiconfig')
      )('typescript') as Partial<TypeScriptCompiler>;
      typeScriptCompiler =
        typeof candidate.transpileModule === 'function'
          ? (candidate as TypeScriptCompiler)
          : null;
    } catch {
      typeScriptCompiler = null;
    }
  }

  return typeScriptCompiler;
};

const getErrorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error
    ? (error as { code?: string }).code
    : undefined;

const typeScriptErrorPrefix = (filepath: string): string =>
  `TypeScript Error in ${filepath}:\n`;

// Config loading is synchronous, so a config with top-level await cannot load.
const synchronousLoadingError = (
  configFile: string,
  error: unknown
): Error | null => {
  const message = error instanceof Error ? error.message : String(error);
  if (
    getErrorCode(error) !== 'ERR_REQUIRE_ASYNC_MODULE' &&
    !message.includes('require() async module') &&
    !message.includes('top-level await')
  ) {
    return null;
  }

  return new Error(
    `[wyw-in-js] Failed to load ${configFile}. ` +
      `WyW config loading is synchronous, so ${path.extname(
        configFile
      )} config files must not use top-level await ` +
      'or depend on async ESM modules. Remove top-level await or switch to a synchronous config.'
  );
};

// Compiles like cosmiconfig's .ts loader but evaluates the output in memory:
// cosmiconfig writes it to a shared <name>.cjs next to the config, which loads
// from several worker threads delete under each other.
const compileTypeScriptConfig = (
  filepath: string,
  content: string
): unknown => {
  const typescript = getTypeScriptCompiler();
  if (!typescript) {
    throw new Error(
      `[wyw-in-js] Loading ${filepath} needs the TypeScript compiler API or a runtime that strips types.`
    );
  }

  try {
    const tsconfigPath = typescript.findConfigFile(
      path.dirname(filepath),
      (fileName) => typescript.sys.fileExists(fileName)
    );
    let tsconfig: TsConfig = {};
    if (tsconfigPath !== undefined) {
      const { config, error } = typescript.readConfigFile(
        tsconfigPath,
        (fileName) => typescript.sys.readFile(fileName)
      );
      if (error) {
        throw new Error(
          `Error in ${tsconfigPath}: ${String(error.messageText)}`
        );
      }
      tsconfig = config ?? {};
    }

    const { outputText } = typescript.transpileModule(content, {
      ...tsconfig,
      compilerOptions: {
        ...tsconfig.compilerOptions,
        module: typescript.ModuleKind.NodeNext,
        moduleResolution: typescript.ModuleResolutionKind.NodeNext,
        target: typescript.ScriptTarget.ES2022,
        noEmit: false,
      },
    });
    // Where require() of the compiled <name>.cjs next to the config ran it.
    const realFilepath = path.join(
      fs.realpathSync(path.dirname(filepath)),
      path.basename(filepath)
    );
    const compiled = new Module(realFilepath) as Module & {
      _compile(code: string, filename: string): void;
    };
    compiled.filename = realFilepath;
    compiled.paths = nodeModulePaths(path.dirname(realFilepath));
    compiled._compile(outputText, realFilepath);
    return (compiled.exports as { default?: unknown }).default;
  } catch (error) {
    const asyncError = synchronousLoadingError(filepath, error);
    if (asyncError) {
      throw asyncError;
    }

    // Node can rethrow the same error object for the same source.
    const prefix = typeScriptErrorPrefix(filepath);
    if (error instanceof Error && !error.message.startsWith(prefix)) {
      error.message = `${prefix}${error.message}`;
    }
    throw error;
  }
};

const isBun = 'bun' in process.versions;

// Node.js 22.18+ and 23.6+ and Bun strip types themselves, so require() loads a
// TypeScript config; .mts and .cts configs need that (cosmiconfig has no loader
// for them).
const runtimeStripsTypes = Boolean(process.features.typescript) || isBun;

export type PartialOptions = Partial<Omit<PluginOptions, 'features'>> & {
  features?: Partial<FeatureFlags>;
};

const cache = new WeakMap<Partial<PartialOptions>, StrictOptions>();
const defaultOverrides = {};
const nodeModulesRegExp = /[\\/]node_modules[\\/]/;
const evalResolverModes = new Set(['bundler', 'hybrid', 'native', 'custom']);
const evalStrategies = new Set(['execute', 'hybrid', 'static']);
const evalRuntimes = new Set(['nodejs']);
const evalErrorModes = new Set(['strict', 'loose']);
const defaultImportLoaders: ImportLoaders = {
  raw: 'raw',
  url: 'url',
};
const resolveConfigFilePath = (configFile: string): string =>
  path.isAbsolute(configFile)
    ? configFile
    : path.resolve(process.cwd(), configFile);

// Bundler integrations add their aliases to the plugin oxcOptions. The
// oxcOptions of the config file still replace the plugin ones, except for
// those aliases: they stay, under the aliases set in the config file.
const withPluginResolverAlias = (
  configOxcOptions: OxcOptions,
  pluginOxcOptions: OxcOptions
): OxcOptions => {
  const alias = pluginOxcOptions.resolver?.alias;
  if (
    !configOxcOptions ||
    typeof configOxcOptions !== 'object' ||
    !alias ||
    typeof alias !== 'object' ||
    Array.isArray(alias)
  ) {
    return configOxcOptions;
  }

  return (
    mergeOxcResolverAlias(configOxcOptions, alias as NativeResolverAlias) ??
    configOxcOptions
  );
};

const normalizeLoadedConfig = (loadedConfig: unknown): Partial<StrictOptions> =>
  (loadedConfig && typeof loadedConfig === 'object' && 'default' in loadedConfig
    ? (loadedConfig as { default: unknown }).default
    : loadedConfig) as Partial<StrictOptions>;

const loadMjsConfig = (configFile: string): Partial<StrictOptions> => {
  const resolvedConfigFile = resolveConfigFilePath(configFile);
  const configRequire = createRequire(resolvedConfigFile);

  try {
    const cacheKey = configRequire.resolve(resolvedConfigFile);
    delete configRequire.cache[cacheKey];
  } catch {
    // Ignore cache cleanup failures and let the require call surface the real error.
  }

  try {
    return normalizeLoadedConfig(configRequire(resolvedConfigFile));
  } catch (error) {
    throw synchronousLoadingError(resolvedConfigFile, error) ?? error;
  }
};

const usesImportMeta = (content: string): boolean =>
  /\bimport\.meta\b/.test(content);

// The compiled CommonJS output of a .ts config cannot hold import.meta, so a
// runtime that strips types loads such a config with require(), and every .ts
// config when there is no compiler API.
const loadsTypeScriptThroughRequire = (content: string): boolean =>
  runtimeStripsTypes &&
  (getTypeScriptCompiler() === null || usesImportMeta(content));

// The compiled config behaves as with cosmiconfig's .ts loader, on Node.js and
// Bun alike.
const loadTypeScriptConfig = (filepath: string, content: string): unknown => {
  if (loadsTypeScriptThroughRequire(content)) {
    return loadMjsConfig(filepath);
  }

  try {
    return compileTypeScriptConfig(filepath, content);
  } catch (error) {
    // Bun refuses CommonJS output it cannot run, such as one that keeps
    // top-level await or a syntax error, with an error of its own that names
    // neither. Loading the config as Bun would names the cause.
    if (
      !isBun ||
      !(error instanceof Error) ||
      !error.message.includes(
        'Expected CommonJS module to have a function wrapper'
      )
    ) {
      throw error;
    }

    try {
      return loadMjsConfig(filepath);
    } catch (bunError) {
      if (
        bunError instanceof Error &&
        bunError.message.startsWith('[wyw-in-js]')
      ) {
        throw bunError;
      }

      // Bun throws build messages, which are not Errors.
      const message =
        bunError && typeof bunError === 'object' && 'message' in bunError
          ? String(bunError.message)
          : String(bunError);
      throw new Error(`${typeScriptErrorPrefix(filepath)}${message}`);
    }
  }
};

const loadStrippedTypeScriptConfig = (filepath: string): unknown => {
  if (!runtimeStripsTypes) {
    throw new Error(
      `[wyw-in-js] Loading ${filepath} needs a runtime that strips types (Node.js 22.18+ or 23.6+, or Bun).`
    );
  }

  return loadMjsConfig(filepath);
};

// TypeScript configs go through the explorer for its per-path cache.
const explorerSync = cosmiconfigSync('wyw-in-js', {
  loaders: {
    '.ts': loadTypeScriptConfig,
    '.mts': loadStrippedTypeScriptConfig,
    '.cts': loadStrippedTypeScriptConfig,
  },
  searchPlaces: searchPlaces.filter(
    (searchPlace) => !searchPlace.endsWith('.mjs')
  ),
});

const loadConfigFromFile = (configFile: string): Partial<StrictOptions> => {
  const resolvedConfigFile = resolveConfigFilePath(configFile);
  if (path.extname(resolvedConfigFile) === '.mjs') {
    return loadMjsConfig(resolvedConfigFile);
  }

  return (explorerSync.load(resolvedConfigFile)?.config ??
    {}) as Partial<StrictOptions>;
};

const findConfigFile = (cwd: string): string | null => {
  let currentDir: string | null = cwd;

  while (currentDir) {
    for (const searchPlace of searchPlaces) {
      const candidate = path.join(currentDir, searchPlace);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const parentDir = path.dirname(currentDir);
    currentDir = parentDir === currentDir ? null : parentDir;
  }

  return null;
};

// Discovery probes every search place in every directory up to the root, and
// adapters that build fresh option objects per module reach it once per file.
// Remember the outcome per working directory; loading stays uncached.
const discoveredConfigFiles = new Map<string, string | null>();

const discoverConfigFile = (): string | null => {
  const cwd = process.cwd();
  let configFile = discoveredConfigFiles.get(cwd);
  if (
    configFile === undefined ||
    (configFile !== null && !fs.existsSync(configFile))
  ) {
    configFile = findConfigFile(cwd);
    discoveredConfigFiles.set(cwd, configFile);
  }

  return configFile;
};

const searchConfig = (): Partial<StrictOptions> => {
  const configFile = discoverConfigFile();
  return configFile ? loadConfigFromFile(configFile) : {};
};

/**
 * The config file that `loadWywOptions(overrides)` reads, as an absolute
 * path, or `null` when it reads none.
 */
export const getWywConfigSource = (
  overrides: PartialOptions = defaultOverrides
): string | null => {
  const { configFile } = overrides;
  if (configFile === false) {
    return null;
  }

  if (configFile !== undefined) {
    return resolveConfigFilePath(configFile);
  }

  return discoverConfigFile();
};

/**
 * Drops what the config loader remembers of loaded files, so that the next
 * options read `configFile`, a path on disk, again. Discovery stays
 * remembered.
 */
export const forgetWywConfigFile = (configFile: string): void => {
  if (path.extname(configFile) === '.mjs') {
    // Loaded without a cache of the loader: each load reads the file again.
    return;
  }

  explorerSync.clearLoadCache();
};

// Whether the loader reads the config with require() as a file that may be
// an ES module. Node evaluates an ES module once per URL, also when the
// evaluation fails, so require() cannot read such a config again. For a .js
// and a stripped .ts config the package type and the syntax decide the
// format.
const mayLoadAsEsModule = (configFile: string): boolean => {
  switch (path.extname(configFile)) {
    case '.js':
    case '.mjs':
      return true;
    case '.mts':
      return runtimeStripsTypes;
    case '.ts':
      try {
        return loadsTypeScriptThroughRequire(
          fs.readFileSync(configFile, 'utf8')
        );
      } catch {
        return false;
      }
    default:
      return false;
  }
};

// Each import of a config gets a URL of its own for the life of the process,
// as the ES module registry of the runtime keys evaluations by URL.
let configImports = 0;

const replaceAll = (text: string, from: string, to: string): string =>
  text.split(from).join(to);

// What a config throws names the config file, not the URL of its import.
const namingConfigFile = (
  error: unknown,
  configFile: string,
  fileUrl: string,
  importUrl: string
): unknown => {
  if (!(error instanceof Error)) {
    return error;
  }

  const message = replaceAll(error.message, importUrl, fileUrl);
  // eslint-disable-next-line no-param-reassign
  error.message = message.includes(configFile)
    ? message
    : `[wyw-in-js] Failed to load ${configFile}: ${message}`;
  if (error.stack) {
    // eslint-disable-next-line no-param-reassign
    error.stack = replaceAll(error.stack, importUrl, fileUrl).replace(
      message,
      error.message
    );
  }

  return error;
};

// Evaluates the config again under a new URL; a CommonJS config comes as the
// default export of its namespace.
const importConfigAgain = async (
  configFile: string
): Promise<Partial<StrictOptions>> => {
  const configRequire = createRequire(configFile);
  try {
    // A CommonJS config is evaluated again only without its cache entry.
    delete configRequire.cache[configRequire.resolve(configFile)];
  } catch {
    // Let the import surface the real error.
  }

  configImports += 1;
  const fileUrl = pathToFileURL(configFile).href;
  const importUrl = `${fileUrl}?wyw-generation=${configImports}`;
  // The import() stays out of the text of this module: tools that parse the
  // module warn about an import of a computed URL, as webpack does in every
  // Next.js build that tracks the dependencies of its config.
  // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
  const importModule = new Function(
    'specifier',
    'return import(specifier)'
  ) as (specifier: string) => Promise<{ default?: unknown }>;
  try {
    const namespace = await importModule(importUrl);
    return normalizeLoadedConfig(namespace.default ?? namespace);
  } catch (error) {
    throw namingConfigFile(error, configFile, fileUrl, importUrl);
  }
};

function buildWywOptions(
  overrides: PartialOptions,
  config: Partial<StrictOptions>
): StrictOptions {
  const {
    configFile,
    ignore,
    rules,
    oxcOptions = {},
    importLoaders: overridesImportLoaders,
    ...rest
  } = overrides;

  const defaultFeatures = {
    dangerousCodeRemover: true,
    globalCache: true,
    happyDOM: true,
    softErrors: false,
    useWeakRefInEval: true,
  } satisfies FeatureFlags;
  const defaultEval: EvalOptionsV2 = {
    ...DEFAULT_EVAL_OPTIONS,
    runtime: 'nodejs',
    strategy: DEFAULT_EVAL_STRATEGY,
  };

  const configImportLoaders = config.importLoaders;
  const configFeatures = config.features;
  const configEval = config.eval;
  // An option set to `undefined` is not set: it keeps the default, and an
  // option of the plugin keeps the value from the config file. Feature flags
  // still merge as given.
  const definedConfig = omitUndefined(config);
  const definedRest = omitUndefined(rest);

  const options: StrictOptions = {
    displayName: false,
    evalConsole: 'pipe',
    extensions: ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'],
    outputMetadata: false,
    rules: rules ?? [
      {
        action: shaker,
      },
      {
        // The old `ignore` option is used as a default value for `ignore` rule.
        test: ignore ?? nodeModulesRegExp,
        action: 'ignore',
      },
      {
        // Do not ignore ES-modules
        test: (filename, code) => {
          if (!nodeModulesRegExp.test(filename)) {
            return false;
          }

          // If a file contains `export` or `import` keywords, we assume it's an ES-module
          return /(?:^|\*\/|;|})\s*(?:export|import)[\s{]/m.test(code);
        },
        action: shaker,
      },
    ],
    highPriorityPlugins: ['module-resolver'],
    ...definedConfig,
    ...definedRest,
    oxcOptions:
      definedConfig.oxcOptions === undefined
        ? oxcOptions
        : withPluginResolverAlias(definedConfig.oxcOptions, oxcOptions),
    eval: {
      ...defaultEval,
      ...omitUndefined(configEval),
      ...omitUndefined(rest.eval),
    },
    importLoaders: {
      ...defaultImportLoaders,
      ...omitUndefined(configImportLoaders),
      ...omitUndefined(overridesImportLoaders),
    },
    features: {
      ...defaultFeatures,
      ...(configFeatures ?? {}),
      ...rest.features,
    },
  };

  const evalResolver = options.eval?.resolver;
  if (evalResolver && !evalResolverModes.has(evalResolver)) {
    throw new Error(
      `[wyw-in-js] Unsupported eval.resolver "${evalResolver}". Use "bundler", "hybrid", "native", or "custom".`
    );
  }
  const evalStrategy = options.eval?.strategy;
  if (evalStrategy && !evalStrategies.has(evalStrategy)) {
    throw new Error(
      `[wyw-in-js] Unsupported eval.strategy "${evalStrategy}". Use "execute", "hybrid", or "static".`
    );
  }
  const evalRuntime = options.eval?.runtime;
  if (evalRuntime && !evalRuntimes.has(evalRuntime)) {
    throw new Error(
      `[wyw-in-js] Unsupported eval.runtime "${evalRuntime}". Use "nodejs".`
    );
  }
  const evalErrors = options.eval?.errors;
  if (evalErrors && !evalErrorModes.has(evalErrors)) {
    throw new Error(
      `[wyw-in-js] Unsupported eval.errors "${evalErrors}". Use "strict" or "loose".`
    );
  }

  warnAboutLoadedOptions({
    configFileOptions: definedConfig,
    options,
    pluginRules: rules,
  });

  cache.set(overrides, options);

  return options;
}

export function loadWywOptions(
  overrides: PartialOptions = defaultOverrides
): StrictOptions {
  if (cache.has(overrides)) {
    return cache.get(overrides)!;
  }

  const { configFile } = overrides;
  const config = (() => {
    if (configFile === false) {
      return {};
    }

    if (configFile !== undefined) {
      return loadConfigFromFile(configFile);
    }

    return searchConfig();
  })();

  return buildWywOptions(overrides, config);
}

/**
 * Loads the options as `loadWywOptions(overrides)` does, but reads
 * `configFile`, the path on disk that it reads, from disk again, whatever the
 * loaders remember of it. A config that may be an ES module is evaluated
 * again under a new URL, also after its last evaluation failed; any other
 * config is read again by the loader. The options are remembered for
 * `overrides` as `loadWywOptions` remembers them.
 */
export async function reloadWywOptions(
  overrides: PartialOptions,
  configFile: string
): Promise<StrictOptions> {
  if (!mayLoadAsEsModule(configFile)) {
    forgetWywConfigFile(configFile);
    return buildWywOptions(overrides, loadConfigFromFile(configFile));
  }

  return buildWywOptions(overrides, await importConfigAgain(configFile));
}
