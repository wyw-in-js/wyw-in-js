// @internal The `@wyw-in-js/shared/eval` entry: the codec of the eval protocol
// and the helpers the eval runner of `@wyw-in-js/transform` uses, without the
// rest of the package root (which loads `debug` and `find-up`). The runner
// imports it at startup, so the modules behind it must stay light. Not for
// use outside wyw-in-js.
export { isBuiltinSpecifier } from './builtins';
export { decodeGlobals, encodeGlobals } from './globals';
export type { EncodedGlobal } from './globals';
export { EVAL_LOAD_CACHE_SIZE, EVAL_RESOLVE_CACHE_SIZE } from './limits';
export { LruCache } from './lru';
export { deserializeError, serializeError } from './serializeError';
export type { SerializedError } from './serializeError';
export {
  deserializeValue,
  serializePreval,
  serializeValue,
} from './serializeValue';
export type { SerializedValue } from './serializeValue';
export { createWriteQueue, writeToStream } from './writeQueue';
export type { WriteQueue } from './writeQueue';
export { canonicalizeForHash, isPlainObject } from '../isPlainObject';
export { isFeatureEnabled } from '../options/isFeatureEnabled';
export { stripQueryAndHash } from '../parseRequest';
