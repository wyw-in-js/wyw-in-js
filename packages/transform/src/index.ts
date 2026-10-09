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
export {
  /**
   * @deprecated Legacy in-process evaluator. `transform()` evaluates modules
   * in a separate runner process and never uses it. Will be removed in 3.0;
   * call `transform()` instead.
   */
  Module,
  /**
   * @deprecated Used only by the legacy `Module` evaluator. Will be removed in
   * 3.0 together with `Module`.
   */
  DefaultModuleImplementation,
} from './module';
export { default as shaker, oxcShaker } from './shaker';
export { transform } from './transform';
export {
  createParallelTransforms,
  createTransformWorkerPool,
  findNonTransferableOption,
  getDefaultTransformWorkerCount,
  TransformWorkerPool,
  TransformWorkerScope,
} from './parallel';
export type {
  ParallelTransforms,
  ParallelTransformsOption,
  ParallelTransformsOptions,
  TransformWorkerJob,
  TransformWorkerPoolOptions,
  TransformWorkerScopeConfig,
} from './parallel';
export { disposeEvalBroker } from './eval/broker';
export {
  /**
   * @deprecated `UnprocessedEntrypointError` is thrown only by the legacy
   * `Module` evaluator; `transform()` never throws it. Will be removed in 3.0
   * together with `Module`.
   */
  isUnprocessedEntrypointError,
  /**
   * @deprecated Thrown only by the legacy `Module` evaluator; `transform()`
   * never throws it. Will be removed in 3.0 together with `Module`.
   */
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
  /**
   * @deprecated Internal result of the transform stage of a single module.
   * Will be removed from the public API in 3.0.
   */
  ITransformFileResult,
  JSONArray,
  JSONObject,
  JSONValue,
  Options,
  /**
   * @deprecated Internal shape of a dependency-graph node. Will be removed
   * from the public API in 3.0.
   */
  ParentEntrypoint,
  PluginOptions,
  Preprocessor,
  PreprocessorFn,
  Result,
  Serializable,
  Stage,
  WywInJsProcessorOptions,
} from './types';
export {
  /**
   * @deprecated Internal dependency-graph node. Will be removed from the
   * public API in 3.0.
   */
  EvaluatedEntrypoint,
} from './transform/EvaluatedEntrypoint';
export type {
  /**
   * @deprecated Internal dependency-graph node. Will be removed from the
   * public API in 3.0.
   */
  IEvaluatedEntrypoint,
} from './transform/EvaluatedEntrypoint';
export {
  /**
   * @deprecated Internal parsing helper. Will be removed from the public API
   * in 3.0.
   */
  parseFile,
} from './transform/Entrypoint.helpers';
export type {
  /**
   * @deprecated Internal service type. Will be removed from the public API in
   * 3.0.
   */
  LoadAndParseFn,
} from './transform/Entrypoint.types';
export {
  /**
   * @deprecated Internal action handlers, exposed only for the deprecated
   * `customHandlers` argument of `transform()`. Will be removed in 3.0.
   */
  baseHandlers,
} from './transform/generators';
export {
  /**
   * @deprecated Internal step of the transform stage. Will be removed from
   * the public API in 3.0.
   */
  prepareCode,
} from './transform/generators/transform';
export {
  /**
   * @deprecated Internal dependency-graph node. Will be removed from the
   * public API in 3.0.
   */
  Entrypoint,
} from './transform/Entrypoint';
export { transformUrl } from './transform/generators/createStylisPreprocessor';
export {
  /**
   * @deprecated Internal handler of the `resolveImports` action. `transform()`
   * always installs its own resolver, so this handler cannot be replaced.
   * Will be removed in 3.0.
   */
  asyncResolveImports,
  /**
   * @deprecated Internal handler for the synchronous action runner, which
   * `transform()` does not use. Will be removed in 3.0.
   */
  syncResolveImports,
} from './transform/generators/resolveImports';
export { loadWywOptions } from './transform/helpers/loadWywOptions';
export {
  /**
   * @deprecated Internal helper; `transform()` fills in default services
   * itself. Will be removed from the public API in 3.0.
   */
  withDefaultServices,
} from './transform/helpers/withDefaultServices';
export type {
  /**
   * @deprecated Internal services type. To type the first argument of
   * `transform()`, use `Parameters<typeof transform>[0]`. Will be removed
   * from the public API in 3.0.
   */
  Services,
} from './transform/types';
export { EventEmitter } from './utils/EventEmitter';
export type {
  DebugEventType,
  EntrypointEvent,
  EventEmitterOptions,
  OnEvent,
  OnActionStartArgs,
  OnActionFinishArgs,
} from './utils/EventEmitter';
export {
  /**
   * @deprecated Internal AST utility. Will be removed from the public API in
   * 3.0.
   */
  isNode,
} from './utils/isNode';
export { getFileIdx } from './utils/getFileIdx';
export {
  /**
   * @deprecated Internal AST utility. Will be removed from the public API in
   * 3.0.
   */
  getVisitorKeys,
} from './utils/getVisitorKeys';
export type {
  /**
   * @deprecated Internal AST utility type. Will be removed from the public
   * API in 3.0.
   */
  VisitorKeys,
} from './utils/getVisitorKeys';
export {
  /**
   * @deprecated Internal utility. Will be removed from the public API in 3.0.
   */
  peek,
} from './utils/peek';
export { TransformCacheCollection } from './cache';
