export { slugify } from '@wyw-in-js/shared';

export { createFileReporter } from './debug/fileReporter';
export type { IFileReporterOptions } from './debug/fileReporter';
export {
  createTransformManifest,
  getTransformMetadata,
  stringifyTransformManifest,
  toTransformResultMetadata,
  withTransformMetadata,
} from './utils/TransformMetadata';
export type {
  WYWTransformManifest,
  WYWTransformMetadata,
  WYWTransformProcessorMetadata,
  WYWTransformResultMetadata,
} from './utils/TransformMetadata';
export { collectTransformDiagnostics } from './utils/TransformDiagnostics';
export type { WYWTransformDiagnostic } from './utils/TransformDiagnostics';
export { Module, DefaultModuleImplementation } from './module';
export { default as shaker, oxcShaker } from './shaker';
export { transform } from './transform';
export { disposeEvalBroker } from './eval/broker';
export {
  isUnprocessedEntrypointError,
  UnprocessedEntrypointError,
} from './transform/actions/UnprocessedEntrypointError';
export {
  CACHE_EPOCH_ABORTED,
  CacheEpochAbortedError,
  isCacheEpochAbortedError,
} from './transform/actions/CacheEpochAbortedError';
export type { CacheRecoveryReason } from './transform/actions/CacheEpochAbortedError';
export {
  CACHE_KEY_SALT_BUSY,
  CacheKeySaltBusyError,
  isCacheKeySaltBusyError,
} from './transform/actions/CacheKeySaltBusyError';
export {
  CACHE_RECOVERY_DID_NOT_CONVERGE,
  CacheRecoveryConvergenceError,
  isCacheRecoveryConvergenceError,
} from './transform/actions/CacheRecoveryConvergenceError';
export type {
  DependencyResolution,
  Dependencies,
  ITransformFileResult,
  JSONArray,
  JSONObject,
  JSONValue,
  Options,
  ParentEntrypoint,
  PluginOptions,
  Preprocessor,
  PreprocessorFn,
  Result,
  Serializable,
  Stage,
  WywInJsProcessorOptions,
} from './types';
export { EvaluatedEntrypoint } from './transform/EvaluatedEntrypoint';
export type { IEvaluatedEntrypoint } from './transform/EvaluatedEntrypoint';
export { parseFile } from './transform/Entrypoint.helpers';
export type { LoadAndParseFn } from './transform/Entrypoint.types';
export { baseHandlers } from './transform/generators';
export { prepareCode } from './transform/generators/transform';
export { Entrypoint } from './transform/Entrypoint';
export { transformUrl } from './transform/generators/createStylisPreprocessor';
export {
  asyncResolveImports,
  syncResolveImports,
} from './transform/generators/resolveImports';
export { loadWywOptions } from './transform/helpers/loadWywOptions';
export { withDefaultServices } from './transform/helpers/withDefaultServices';
export type { Services } from './transform/types';
export { EventEmitter } from './utils/EventEmitter';
export type {
  DebugEventType,
  EntrypointEvent,
  EventEmitterOptions,
  OnEvent,
  OnActionStartArgs,
  OnActionFinishArgs,
} from './utils/EventEmitter';
export { isNode } from './utils/isNode';
export { getFileIdx } from './utils/getFileIdx';
export { getVisitorKeys } from './utils/getVisitorKeys';
export type { VisitorKeys } from './utils/getVisitorKeys';
export { peek } from './utils/peek';
export { TransformCacheCollection } from './cache';
