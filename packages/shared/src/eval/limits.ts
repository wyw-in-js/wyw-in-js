/**
 * The number of resolved specifiers that the eval broker and the eval runner
 * each keep.
 *
 * @internal Shared by the eval broker and the eval runner.
 */
export const EVAL_RESOLVE_CACHE_SIZE = 5000;

/**
 * The number of loaded modules that the eval broker and the eval runner each
 * keep.
 *
 * @internal Shared by the eval broker and the eval runner.
 */
export const EVAL_LOAD_CACHE_SIZE = 1000;
