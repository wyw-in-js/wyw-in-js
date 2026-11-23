import { readFileSync } from 'fs';

import { asyncResolveFallback, decodeGlobals } from '@wyw-in-js/shared';
import {
  disposeEvalBroker,
  transform,
  TransformCacheCollection,
} from '@wyw-in-js/transform';
import type { PluginOptions, Result } from '@wyw-in-js/transform';

type SyncTransformPayload = {
  code: string;
  filename: string;
  inlineEvalGlobals?: unknown;
  inputSourceMap?: unknown;
  pluginOptions: Partial<PluginOptions>;
  root?: string;
};

type SyncTransformOutput = Pick<Result, 'code' | 'metadata' | 'sourceMap'>;
type TransformInputSourceMap = Parameters<
  typeof transform
>[0]['options']['inputSourceMap'];

const readStdin = () => {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};

const fail = (message: string) => {
  // eslint-disable-next-line no-console
  console.error(message);
  process.exit(1);
};

const rawInput = readStdin();
if (!rawInput.trim()) {
  fail('[wyw-in-js] babel preset sync runner: empty input');
}

let payload!: SyncTransformPayload;
try {
  payload = JSON.parse(rawInput) as SyncTransformPayload;
} catch (error) {
  fail(
    `[wyw-in-js] babel preset sync runner: failed to parse input: ${String(
      error
    )}`
  );
}

const {
  filename,
  root,
  code,
  inputSourceMap,
  pluginOptions,
  inlineEvalGlobals,
} = payload;
const normalizedInputSourceMap = inputSourceMap as
  | TransformInputSourceMap
  | undefined;
const pluginOptionsForTransform: Partial<PluginOptions> = { ...pluginOptions };

if (inlineEvalGlobals !== undefined) {
  pluginOptionsForTransform.eval = {
    ...(pluginOptionsForTransform.eval ?? {}),
    globals: decodeGlobals(inlineEvalGlobals) as Record<string, unknown>,
  };
}

const cache = new TransformCacheCollection();
let output!: SyncTransformOutput;
let transformError: unknown = null;

try {
  const result = await transform(
    {
      cache,
      options: {
        filename,
        root,
        inputSourceMap: normalizedInputSourceMap,
        pluginOptions: pluginOptionsForTransform,
      },
    },
    code,
    asyncResolveFallback
  );

  output = {
    code: result.code,
    metadata: result.metadata,
    sourceMap: result.sourceMap,
  };
} catch (error) {
  transformError = error;
} finally {
  disposeEvalBroker(cache);
}

if (transformError) {
  fail(
    `[wyw-in-js] babel preset sync runner: transform failed for ${filename}\n${String(
      transformError
    )}`
  );
}

process.stdout.write(JSON.stringify(output));
