import fs from 'node:fs';
import { createRequire } from 'module';
import path from 'path';

import { cosmiconfigSync } from 'cosmiconfig';

import type {
  EvalOptionsV2,
  FeatureFlags,
  ImportLoaders,
  StrictOptions,
} from '@wyw-in-js/shared';

import { shaker } from '../../shaker';
import { DEFAULT_EVAL_OPTIONS } from '../../utils/evalOptions';
import type { PluginOptions } from '../../types';
import { DEFAULT_EVAL_STRATEGY } from '../../utils/evalStrategy';

const searchPlaces = [
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

const explorerSync = cosmiconfigSync('wyw-in-js', {
  searchPlaces: searchPlaces.filter(
    (searchPlace) => !searchPlace.endsWith('.mjs')
  ),
});

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
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code?: string }).code
        : undefined;
    const message = error instanceof Error ? error.message : String(error);

    if (
      code === 'ERR_REQUIRE_ASYNC_MODULE' ||
      message.includes('require() async module') ||
      message.includes('top-level await')
    ) {
      throw new Error(
        `[wyw-in-js] Failed to load ${resolvedConfigFile}. ` +
          'WyW config loading is synchronous, so .mjs config files must not use top-level await ' +
          'or depend on async ESM modules. Remove top-level await or switch to a synchronous config.'
      );
    }

    throw error;
  }
};

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

const searchConfig = (): Partial<StrictOptions> => {
  const cwd = process.cwd();
  let configFile = discoveredConfigFiles.get(cwd);
  if (
    configFile === undefined ||
    (configFile !== null && !fs.existsSync(configFile))
  ) {
    configFile = findConfigFile(cwd);
    discoveredConfigFiles.set(cwd, configFile);
  }

  return configFile ? loadConfigFromFile(configFile) : {};
};

export function loadWywOptions(
  overrides: PartialOptions = defaultOverrides
): StrictOptions {
  if (cache.has(overrides)) {
    return cache.get(overrides)!;
  }

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

  const config = (() => {
    if (configFile === false) {
      return {};
    }

    if (configFile !== undefined) {
      return loadConfigFromFile(configFile);
    }

    return searchConfig();
  })();
  const configImportLoaders = config.importLoaders;
  const configFeatures = config.features;
  const configEval = config.eval;

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
    oxcOptions,
    ...config,
    ...rest,
    eval: {
      ...defaultEval,
      ...(configEval ?? {}),
      ...(rest.eval ?? {}),
    },
    importLoaders: {
      ...defaultImportLoaders,
      ...(configImportLoaders ?? {}),
      ...(overridesImportLoaders ?? {}),
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

  cache.set(overrides, options);

  return options;
}
