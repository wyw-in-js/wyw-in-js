// Request suffix parsing lives in @wyw-in-js/shared so bundler adapters and
// transform split `?query` / `#hash` the same way.
export { parseRequest, stripQueryAndHash } from '@wyw-in-js/shared';
export type { ParsedRequest } from '@wyw-in-js/shared';
