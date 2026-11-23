export type { Debugger } from './debugger';

export { asyncResolveFallback, syncResolve } from './asyncResolveFallback';
export { asyncResolverFactory } from './asyncResolverFactory';
export {
  WYW_CSS_MODULE_EXTENSION,
  WYW_CSS_OUTPUT_QUERY,
} from './cssOutputProtocol';
// @internal The codec of the eval protocol, shared by the eval broker and the
// eval runner of `@wyw-in-js/transform` and by the Babel preset. Not for use
// outside wyw-in-js.
export { isBuiltinSpecifier } from './eval/builtins';
export { decodeGlobals, encodeGlobals } from './eval/globals';
export type { EncodedGlobal } from './eval/globals';
export { EVAL_LOAD_CACHE_SIZE, EVAL_RESOLVE_CACHE_SIZE } from './eval/limits';
export { LruCache } from './eval/lru';
export { deserializeError, serializeError } from './eval/serializeError';
export type { SerializedError } from './eval/serializeError';
export {
  deserializeValue,
  serializePreval,
  serializeValue,
} from './eval/serializeValue';
export type { SerializedValue } from './eval/serializeValue';
export { createWriteQueue, writeToStream } from './eval/writeQueue';
export type { WriteQueue } from './eval/writeQueue';
export { hasEvalMeta } from './hasEvalMeta';
export { findPackageJSON } from './findPackageJSON';
export { isBoxedPrimitive } from './isBoxedPrimitive';
export { canonicalizeForHash, isPlainObject } from './isPlainObject';
export { enableDebug, logger } from './logger';
export { isFeatureEnabled } from './options/isFeatureEnabled';
export {
  mergeOxcResolverAlias,
  toNativeResolverAlias,
} from './options/nativeResolverOptions';
export type { NativeResolverAlias } from './options/nativeResolverOptions';
export { normalizeInputSourceMap } from './normalizeInputSourceMap';
export type {
  InputSourceMap,
  NormalizedInputSourceMap,
} from './normalizeInputSourceMap';
export { parseRequest, stripQueryAndHash } from './parseRequest';
export type { ParsedRequest } from './parseRequest';
export { slugify } from './slugify';
export { ValueType } from './types';

export type { IVariableContext } from './IVariableContext';
export type {
  ClassNameSlugVars,
  ClassNameFn,
  CodeRemoverOptions,
  EvalErrorMode,
  EvalOptionsV2,
  EvalRequireMode,
  EvalResolverKind,
  EvalResolverMode,
  EvalRuntime,
  EvalStrategy,
  EvalWarning,
  EvalWarningCode,
  ImportLoader,
  ImportLoaderContext,
  ImportLoaders,
  ImportOverride,
  ImportOverrides,
  OxcOptions,
  TagResolverMeta,
  StrictOptions,
  EvalRule,
  EvaluatorOptions,
  TransformEngineOptions,
  Evaluator,
  FeatureFlag,
  EvaluatorConfig,
  FeatureFlags,
  VariableNameFn,
  WywInJsProcessorOptions,
} from './options/types';
export type {
  Artifact,
  AstExpression,
  AstNode,
  BigIntLiteral,
  BooleanLiteral,
  BuildCodeFrameErrorFn,
  ConstValue,
  DecimalLiteral,
  ExpressionValue,
  FunctionValue,
  Identifier,
  ICSSRule,
  LazyValue,
  Location,
  NullLiteral,
  NumericLiteral,
  Replacement,
  Replacements,
  Rules,
  SourceLocation,
  StringLiteral,
  WYWEvalMeta,
} from './types';
