import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import type {
  BabelFile,
  ConfigAPI,
  PluginObj,
  TransformCaller,
} from '@babel/core';
import { parseSync } from '@babel/core';
import { isPlainObject } from '@wyw-in-js/shared';
import type {
  PluginOptions,
  WYWTransformMetadata,
  WYWTransformResultMetadata,
} from '@wyw-in-js/transform';

import { encodeGlobals } from './globals';

type SyncTransformPayload = {
  code: string;
  filename: string;
  inlineEvalGlobals?: unknown;
  inputSourceMap?: unknown;
  pluginOptions: Partial<PluginOptions>;
  root?: string;
};

type SyncTransformOutput = {
  code: string;
  metadata?: WYWTransformResultMetadata;
  sourceMap?: unknown;
};

const buildRunnerPath = () => {
  const jsPath = fileURLToPath(
    new URL('./sync-transform-runner.js', import.meta.url)
  );
  if (existsSync(jsPath)) {
    return jsPath;
  }

  return fileURLToPath(new URL('./sync-transform-runner.ts', import.meta.url));
};

const runnerPath = buildRunnerPath();
const nodeBinary =
  runnerPath.endsWith('.ts') && process.execPath.includes('bun')
    ? process.execPath
    : process.env.WYW_NODE_BINARY ||
      (process.execPath.includes('bun') ? 'node' : process.execPath);

const compatibilityWarnings = new Set<string>();

const emitCompatibilityWarning = (key: string, message: string) => {
  if (compatibilityWarnings.has(key)) {
    return;
  }

  compatibilityWarnings.add(key);

  if (typeof process.emitWarning === 'function') {
    process.emitWarning(message, {
      code: `WYW_${key}`,
      type: 'DeprecationWarning',
    });
    return;
  }

  // eslint-disable-next-line no-console
  console.warn(message);
};

const warnBabelPresetDeprecation = () => {
  emitCompatibilityWarning(
    'BABEL_PRESET_COMPATIBILITY',
    '[wyw-in-js] @wyw-in-js/babel-preset is a deprecated compatibility wrapper around the Oxc-backed transform. Prefer bundler integrations or the transform() API for new setups.'
  );
};

const warnSynchronousModuleConfig = (configFile: unknown) => {
  if (typeof configFile !== 'string' || !/\.(?:mjs|mts)$/iu.test(configFile)) {
    return;
  }

  emitCompatibilityWarning(
    'BABEL_PRESET_SYNC_CONFIG',
    '[wyw-in-js] @wyw-in-js/babel-preset loads .mjs/.mts WyW config files synchronously. Keep them synchronous and avoid top-level await.'
  );
};

function isEnabled(caller?: TransformCaller & { evaluate?: true }) {
  return caller?.name !== 'wyw-in-js' || caller.evaluate === true;
}

const getObjectTypeName = (value: object): string => {
  const { constructor } = value as { constructor?: { name?: unknown } };
  if (
    constructor &&
    typeof constructor.name === 'string' &&
    constructor.name.length > 0
  ) {
    return constructor.name;
  }

  const tag = Object.prototype.toString.call(value);
  return tag.slice(8, -1) || 'Object';
};

const formatOptionPath = (path: Array<string | number>): string =>
  path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') {
      return `${acc}[${segment}]`;
    }

    if (/^[A-Za-z_$][\w$]*$/u.test(segment)) {
      return `${acc}.${segment}`;
    }

    return `${acc}[${JSON.stringify(segment)}]`;
  }, 'options');

const throwNonSerializableOption = (
  path: Array<string | number>,
  reason: string
): never => {
  throw new Error(
    `[wyw-in-js] Babel preset option ${formatOptionPath(
      path
    )} is not serializable (${reason}). ` +
      '@wyw-in-js/babel-preset forwards inline options through a separate sync runner. ' +
      'Move it into a WyW config file or use the async transform() API.'
  );
};

const validateSerializableValue = (
  value: unknown,
  path: Array<string | number>
): void => {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return;
  }

  if (typeof value === 'function') {
    throwNonSerializableOption(path, 'Function');
  }

  if (typeof value === 'symbol') {
    throwNonSerializableOption(path, 'Symbol');
  }

  if (typeof value === 'bigint') {
    throwNonSerializableOption(path, 'BigInt');
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateSerializableValue(item, [...path, index])
    );
    return;
  }

  if (isPlainObject(value)) {
    Object.entries(value).forEach(([key, item]) =>
      validateSerializableValue(item, [...path, key])
    );
    return;
  }

  throwNonSerializableOption(path, getObjectTypeName(value));
};

const stringifyPayload = (payload: SyncTransformPayload) => {
  validateSerializableValue(payload.inputSourceMap, ['inputSourceMap']);
  validateSerializableValue(payload.pluginOptions, ['pluginOptions']);
  return JSON.stringify(payload);
};

const buildTransformPayload = (
  file: BabelFile,
  options: Partial<PluginOptions>
): SyncTransformPayload => {
  const filename = file.opts.filename!;
  const evalOptions = options.eval ?? {};
  const inlineEvalGlobals =
    evalOptions.globals === undefined
      ? undefined
      : encodeGlobals(evalOptions.globals);
  const nextEvalOptions =
    'globals' in evalOptions
      ? Object.fromEntries(
          Object.entries(evalOptions).filter(([key]) => key !== 'globals')
        )
      : evalOptions;

  const pluginOptionsForChild: Partial<PluginOptions> = {
    ...options,
    eval: nextEvalOptions,
    outputMetadata: true,
  };

  if (
    pluginOptionsForChild.eval &&
    Object.keys(pluginOptionsForChild.eval).length === 0
  ) {
    delete pluginOptionsForChild.eval;
  }

  return {
    filename,
    root: file.opts.root ?? undefined,
    code: file.code ?? '',
    inputSourceMap: file.opts.inputSourceMap ?? undefined,
    pluginOptions: pluginOptionsForChild,
    inlineEvalGlobals,
  };
};

const runSyncTransform = (
  payload: SyncTransformPayload
): SyncTransformOutput => {
  let input: string;
  try {
    input = stringifyPayload(payload);
  } catch (error) {
    throw new Error(
      `[wyw-in-js] Failed to serialize babel preset options: ${String(error)}`
    );
  }

  const result = spawnSync(nodeBinary, [runnerPath], {
    input,
    encoding: 'utf8',
    cwd: payload.root ?? process.cwd(),
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      WYW_EVAL_OXC_SYNC: '1',
    },
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `[wyw-in-js] Babel preset sync transform failed:\n${result.stderr ?? ''}`
    );
  }

  return result.stdout
    ? (JSON.parse(result.stdout) as SyncTransformOutput)
    : { code: payload.code };
};

const toBabelMetadata = (
  metadata: WYWTransformResultMetadata
): WYWTransformMetadata => ({
  dependencies: metadata.dependencies,
  processors: metadata.processors.map((processor) => ({
    artifacts: processor.artifacts,
    className: processor.className,
    displayName: processor.displayName,
    location: processor.start
      ? {
          end: processor.start,
          start: processor.start,
        }
      : null,
  })),
  replacements: metadata.replacements,
  rules: metadata.rules,
});

function oxcCompatibilityPlugin(
  _babel: ConfigAPI,
  options: Partial<PluginOptions>
): PluginObj {
  return {
    name: '@wyw-in-js/babel-preset/oxc-compatibility',
    pre(file: BabelFile) {
      const payload = buildTransformPayload(file, options);
      const result = runSyncTransform(payload);

      if (result.code && result.code !== payload.code) {
        const ast = parseSync(result.code, {
          babelrc: false,
          configFile: false,
          filename: payload.filename,
          sourceType: 'module',
        });

        if (ast?.program) {
          const programNode = file.path.node;
          programNode.body = ast.program.body;
          programNode.directives = ast.program.directives;
        }
      }

      if (result.metadata) {
        const metadata = file.metadata as { wywInJS?: WYWTransformMetadata };
        metadata.wywInJS = toBabelMetadata(result.metadata);
      }
    },
    visitor: {},
  };
}

export default function wywInJS(babel: ConfigAPI, options: PluginOptions) {
  if (!babel.caller(isEnabled)) {
    return {};
  }

  warnBabelPresetDeprecation();
  warnSynchronousModuleConfig(options.configFile);

  return {
    plugins: [[oxcCompatibilityPlugin, options]],
  };
}
