import { createRequire } from 'module';

import {
  isPlainObject,
  mergeOxcResolverAlias,
  toNativeResolverAlias,
  WYW_CSS_MODULE_EXTENSION,
  WYW_CSS_OUTPUT_QUERY,
} from '@wyw-in-js/shared';
import type { LoaderOptions as WywTurbopackLoaderOptions } from '@wyw-in-js/turbopack-loader';
import type { LoaderOptions as WywWebpackLoaderOptions } from '@wyw-in-js/webpack-loader';
import type { NextConfig } from 'next';
import type {
  Configuration,
  RuleSetRule,
  RuleSetUseFunction,
  RuleSetUseItem,
} from 'webpack';

const CSS_OUTPUT_QUERY_RE = new RegExp(`^\\??${WYW_CSS_OUTPUT_QUERY}$`);
const NODE_MODULES_RE = /[\\/]node_modules[\\/]/;

const DEFAULT_TURBO_RULE_KEYS = ['*.js', '*.jsx', '*.ts', '*.tsx'];

const DEFAULT_REACT_IMPORT_OVERRIDES = {
  react: { mock: 'react' },
  'react/jsx-runtime': { mock: 'react/jsx-runtime' },
  'react/jsx-dev-runtime': { mock: 'react/jsx-dev-runtime' },
} satisfies WywWebpackLoaderOptions['importOverrides'];

const nodeRequire = createRequire(import.meta.url);

export type WywNextPluginOptions = {
  loaderOptions?: Omit<WywWebpackLoaderOptions, 'extension' | 'sourceMap'> &
    Partial<Pick<WywWebpackLoaderOptions, 'extension' | 'sourceMap'>>;
  turbopackLoaderOptions?: Partial<WywTurbopackLoaderOptions>;
};

type NextWebpackConfigFn = NonNullable<NextConfig['webpack']>;
type NextWebpackOptions = Parameters<NextWebpackConfigFn>[1];
type NextVersion = {
  major: number;
  minor: number;
};
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUseLoaderObject(
  item: RuleSetUseItem
): item is Exclude<RuleSetUseItem, string> & { loader: string } {
  return (
    isObject(item) &&
    typeof (item as Record<string, unknown>).loader === 'string'
  );
}

function normalizeUseItems(use: RuleSetRule['use']): RuleSetUseItem[] | null {
  if (!use) return null;
  if (typeof use === 'function') return null;

  const list = (Array.isArray(use) ? use : [use]).filter(Boolean);
  return list.length ? (list as RuleSetUseItem[]) : null;
}

function getLoaderName(item: RuleSetUseItem): string {
  if (typeof item === 'string') return item;
  if (isUseLoaderObject(item)) return item.loader;
  return '';
}

function createWywLoaderUseFunction(
  use: RuleSetUseItem[],
  loaderItem: RuleSetUseItem
): RuleSetUseFunction {
  return ({ realResource, resource }) => {
    const resourcePath = realResource ?? resource;
    return resourcePath && NODE_MODULES_RE.test(resourcePath)
      ? use
      : [...use, loaderItem];
  };
}

function isWywLoaderPath(loader: string) {
  return (
    loader.includes('@wyw-in-js/webpack-loader') ||
    /[\\/]webpack-loader[\\/]/.test(loader)
  );
}

function convertLoaderRuleToUseRule(rule: RuleSetRule) {
  const { loader } = rule as { loader?: unknown };
  if (typeof loader !== 'string') return;

  const alreadyInjected = isWywLoaderPath(loader);
  if (alreadyInjected) return;

  const isNextJsTranspileRule = [
    'next-swc-loader',
    'next-babel-loader',
    'babel-loader',
  ].some((needle) => loader.includes(needle));
  if (!isNextJsTranspileRule) return;

  const { options } = rule as { options?: unknown };

  const nextRule = rule as RuleSetRule & {
    loader?: unknown;
    options?: unknown;
  };

  delete nextRule.loader;
  delete nextRule.options;

  // Loader order is right-to-left. We want WyW to run first, so it should be last.
  Object.assign(nextRule, {
    use: [{ loader, ...(options !== undefined ? { options } : {}) }],
  });
}

function traverseRules(rules: unknown[], visitor: (rule: RuleSetRule) => void) {
  for (const rule of rules) {
    if (rule && typeof rule === 'object') {
      visitor(rule as RuleSetRule);

      if (Array.isArray((rule as RuleSetRule).oneOf)) {
        traverseRules((rule as RuleSetRule).oneOf!, visitor);
      }
      if (Array.isArray((rule as RuleSetRule).rules)) {
        traverseRules((rule as RuleSetRule).rules!, visitor);
      }
    }
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertJsonSerializable(value: unknown, name: string) {
  const queue: Array<{ path: string; value: unknown }> = [
    { path: name, value },
  ];
  const seen = new Set<unknown>();

  while (queue.length) {
    const current = queue.shift()!;

    if (current.value === null) {
      // skip
    } else if (typeof current.value === 'undefined') {
      // skip
    } else if (
      typeof current.value === 'string' ||
      typeof current.value === 'number' ||
      typeof current.value === 'boolean'
    ) {
      // primitives are ok
    } else if (
      typeof current.value === 'function' ||
      typeof current.value === 'symbol' ||
      typeof current.value === 'bigint'
    ) {
      throw new Error(
        `${current.path} must be JSON-serializable (functions, symbols and bigint are not supported in Turbopack loader options). Use "configFile" to pass non-JSON config.`
      );
    } else if (Array.isArray(current.value)) {
      if (!seen.has(current.value)) {
        seen.add(current.value);
        current.value.forEach((item, idx) =>
          queue.push({ path: `${current.path}[${idx}]`, value: item })
        );
      }
    } else if (isPlainObject(current.value)) {
      if (!seen.has(current.value)) {
        seen.add(current.value);
        Object.entries(current.value).forEach(([key, item]) =>
          queue.push({ path: `${current.path}.${key}`, value: item })
        );
      }
    } else {
      throw new Error(
        `${current.path} must be JSON-serializable (only plain objects, arrays, and primitives are supported in Turbopack loader options). Use "configFile" to pass non-JSON config.`
      );
    }
  }
}

function createWywCssModuleRule(
  baseRule: RuleSetRule,
  extensionSuffix: string
): RuleSetRule {
  const use = normalizeUseItems(baseRule.use) ?? [];

  const patchedUse = use.map((item) => {
    if (!isUseLoaderObject(item) || !item.loader.includes('css-loader')) {
      return item;
    }

    const itemOptions = (item as { options?: unknown }).options;
    if (!isObject(itemOptions)) {
      return item;
    }

    const { modules } = itemOptions as { modules?: unknown };
    if (!isObject(modules)) {
      return item;
    }

    const nextModules = {
      ...(modules as Record<string, unknown>),
      mode: 'global',
      getLocalIdent: (
        _context: unknown,
        _localIdentName: string,
        localName: string
      ) => localName,
    };

    return {
      ...item,
      options: {
        ...(itemOptions as Record<string, unknown>),
        modules: nextModules,
      },
    };
  });

  const nextRule: RuleSetRule = {
    ...baseRule,
    sideEffects: true,
    test: new RegExp(`${escapeRegExp(extensionSuffix)}$`),
    use: patchedUse,
  };

  return nextRule;
}

function ensureWywCssModuleRules(
  config: Configuration,
  extensionSuffix: string
) {
  traverseRules(config.module?.rules ?? [], (rule) => {
    if (!Array.isArray(rule.oneOf) || rule.oneOf.length === 0) {
      return;
    }

    const expectedTestSource = `${escapeRegExp(extensionSuffix)}$`;

    const oneOf = rule.oneOf as unknown[];
    for (let idx = 0; idx < oneOf.length; idx += 1) {
      const candidate = oneOf[idx];
      if (candidate && typeof candidate === 'object') {
        const candidateRule = candidate as RuleSetRule;
        const { test } = candidateRule;

        const isModuleCssRule =
          test instanceof RegExp &&
          test.source !== expectedTestSource &&
          test.source.includes('\\.module\\.css');

        if (isModuleCssRule) {
          const use = normalizeUseItems(candidateRule.use);
          if (use) {
            const hasCssLoader = use.some(
              (item) =>
                isUseLoaderObject(item) && item.loader.includes('css-loader')
            );
            const previous = oneOf[idx - 1];
            const previousIsWywCssRule =
              previous !== null &&
              typeof previous === 'object' &&
              (previous as RuleSetRule).test instanceof RegExp &&
              ((previous as RuleSetRule).test as RegExp).source ===
                expectedTestSource;

            if (hasCssLoader && !previousIsWywCssRule) {
              oneOf.splice(
                idx,
                0,
                createWywCssModuleRule(candidateRule, extensionSuffix)
              );
              idx += 1;
            }
          }
        }
      }
    }
  });
}

function injectWywLoader(
  config: Configuration,
  nextOptions: NextWebpackOptions,
  wywNext: WywNextPluginOptions
) {
  const loader = nodeRequire.resolve('@wyw-in-js/webpack-loader');

  const extension =
    wywNext.loaderOptions?.extension ?? WYW_CSS_MODULE_EXTENSION;

  const userImportOverrides = wywNext.loaderOptions?.importOverrides;
  const importOverrides = userImportOverrides
    ? { ...DEFAULT_REACT_IMPORT_OVERRIDES, ...userImportOverrides }
    : DEFAULT_REACT_IMPORT_OVERRIDES;

  const loaderOptions = {
    cssImport: 'import',
    ...wywNext.loaderOptions,
    extension,
    importOverrides,
    sourceMap: wywNext.loaderOptions?.sourceMap ?? nextOptions.dev,
  } satisfies WywWebpackLoaderOptions;

  traverseRules(config.module?.rules ?? [], (rule) => {
    convertLoaderRuleToUseRule(rule);

    const use = normalizeUseItems(rule.use);
    if (!use) return;

    const loaders = use.map(getLoaderName);

    const alreadyInjected = loaders.some(
      (l) => l === loader || isWywLoaderPath(l)
    );
    if (alreadyInjected) return;

    const isNextJsTranspileRule = loaders.some((l) =>
      ['next-swc-loader', 'next-babel-loader', 'babel-loader'].some((needle) =>
        l.includes(needle)
      )
    );
    if (!isNextJsTranspileRule) return;

    const wywLoaderItem: RuleSetUseItem = {
      loader,
      options: loaderOptions,
    };
    const wywLoaderUse = createWywLoaderUseFunction(use, wywLoaderItem);

    // Loader order is right-to-left. We want WyW to run first, so it should be last.
    Object.assign(rule, { use: wywLoaderUse });
  });

  ensureWywCssModuleRules(config, extension);
}

function getInstalledNextVersion(): NextVersion | null {
  try {
    const pkgPath = nodeRequire.resolve('next/package.json', {
      paths: [process.cwd()],
    });
    const pkg = nodeRequire(pkgPath) as { version?: unknown };
    const version = typeof pkg.version === 'string' ? pkg.version : '';
    const [majorPart, minorPart] = version.split('.');
    const major = Number.parseInt(majorPart ?? '', 10);
    const minor = Number.parseInt(minorPart ?? '', 10);

    if (!Number.isFinite(major) || !Number.isFinite(minor)) {
      return null;
    }

    return { major, minor };
  } catch {
    return null;
  }
}

function shouldUseTurbopackConfig(
  nextConfig: NextConfig,
  nextVersion: NextVersion | null
) {
  const explicit = (nextConfig as unknown as Record<string, unknown>).turbopack;
  if (typeof explicit !== 'undefined') {
    return true;
  }

  return nextVersion !== null && nextVersion.major >= 16;
}

function supportsTurbopackQueryConditions(nextVersion: NextVersion | null) {
  if (nextVersion === null) {
    return false;
  }

  return (
    nextVersion.major > 16 ||
    (nextVersion.major === 16 && nextVersion.minor >= 2)
  );
}

function injectWywTurbopackRules(
  nextConfig: NextConfig,
  wywNext: WywNextPluginOptions
): NextConfig {
  const loader = nodeRequire.resolve('@wyw-in-js/turbopack-loader');

  const userOptions = wywNext.turbopackLoaderOptions ?? {};

  assertJsonSerializable(userOptions, 'turbopackLoaderOptions');

  const turbopackConfig = (nextConfig as unknown as Record<string, unknown>)
    .turbopack;
  const userTurbopack = isPlainObject(turbopackConfig) ? turbopackConfig : {};
  const userExperimental = isPlainObject(nextConfig.experimental)
    ? (nextConfig.experimental as Record<string, unknown>)
    : {};
  const userTurbo = isPlainObject(userExperimental.turbo)
    ? (userExperimental.turbo as Record<string, unknown>)
    : {};

  const nativeResolverAlias = toNativeResolverAlias(
    userTurbopack.resolveAlias ?? userTurbo.resolveAlias
  );
  const oxcOptions = mergeOxcResolverAlias(
    userOptions.oxcOptions,
    nativeResolverAlias
  );

  const userImportOverrides = isPlainObject(userOptions.importOverrides)
    ? (userOptions.importOverrides as Record<string, unknown>)
    : undefined;

  const loaderOptions = {
    sourceMap: process.env.NODE_ENV !== 'production',
    ...userOptions,
    ...(oxcOptions ? { oxcOptions } : {}),
    importOverrides: userImportOverrides
      ? { ...DEFAULT_REACT_IMPORT_OVERRIDES, ...userImportOverrides }
      : DEFAULT_REACT_IMPORT_OVERRIDES,
  };

  const nextVersion = getInstalledNextVersion();
  const useTurbopackConfig = shouldUseTurbopackConfig(nextConfig, nextVersion);
  const useCssQueryOutput = supportsTurbopackQueryConditions(nextVersion);

  const commonConditions = [
    { not: 'foreign' },
    { not: { path: /(?:^|[\\/])middleware\.[jt]sx?$/ } },
  ];

  const jsLoaderOptions = {
    ...loaderOptions,
    cssOutputMode: useCssQueryOutput ? 'query' : 'sidecar',
  };

  const ruleValue = useTurbopackConfig
    ? {
        loaders: [{ loader, options: jsLoaderOptions }],
        condition: {
          all: commonConditions,
        },
      }
    : [{ loader, options: jsLoaderOptions }];

  const jsRuleValue = {
    loaders: [{ loader, options: jsLoaderOptions }],
    condition: {
      all: [...commonConditions, { not: { query: CSS_OUTPUT_QUERY_RE } }],
    },
  };

  const cssRuleValue = {
    loaders: [
      {
        loader,
        options: {
          ...loaderOptions,
          cssOutputMode: 'query',
          outputCss: true,
        },
      },
    ],
    as: '*.module.css',
    condition: {
      all: [...commonConditions, { query: CSS_OUTPUT_QUERY_RE }],
    },
  };

  const wywRules = Object.fromEntries(
    DEFAULT_TURBO_RULE_KEYS.map((key) => [
      key,
      useCssQueryOutput ? [cssRuleValue, jsRuleValue] : ruleValue,
    ])
  );

  if (useTurbopackConfig) {
    const userRules = isPlainObject(userTurbopack.rules)
      ? (userTurbopack.rules as Record<string, unknown>)
      : {};

    return {
      ...nextConfig,
      turbopack: {
        ...userTurbopack,
        rules: {
          ...wywRules,
          ...userRules,
        },
      },
    } as NextConfig;
  }

  const userRules = isPlainObject(userTurbo.rules)
    ? (userTurbo.rules as Record<string, unknown>)
    : {};

  return {
    ...nextConfig,
    experimental: {
      ...userExperimental,
      turbo: {
        ...userTurbo,
        rules: {
          ...wywRules,
          ...userRules,
        },
      },
    },
  } as NextConfig;
}

export function withWyw(
  nextConfig: NextConfig = {},
  wywNext: WywNextPluginOptions = {}
): NextConfig {
  const userWebpack = nextConfig.webpack;

  return {
    ...injectWywTurbopackRules(nextConfig, wywNext),
    webpack(config: Configuration, options: NextWebpackOptions) {
      const resolvedConfig =
        typeof userWebpack === 'function'
          ? userWebpack(config, options)
          : config;

      injectWywLoader(resolvedConfig, options, wywNext);

      return resolvedConfig;
    },
  };
}
