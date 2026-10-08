/**
 * Bundler requests may carry a `?query` and/or a `#hash` suffix
 * (`./a.ts?raw`, `/abs/a.ts?v=123#x`). These helpers split such a request
 * at the first `?` or `#`, whichever comes first.
 */

export type ParsedRequest = {
  filename: string;
  hash: string;
  query: string;
};

const getFirstSuffixIndex = (request: string): number => {
  const queryIdx = request.indexOf('?');
  const hashIdx = request.indexOf('#');

  if (queryIdx === -1) return hashIdx;
  if (hashIdx === -1) return queryIdx;

  return Math.min(queryIdx, hashIdx);
};

/**
 * Returns the request without its `?query` / `#hash` suffix. The suffix
 * itself is `request.slice(stripQueryAndHash(request).length)`.
 */
export const stripQueryAndHash = (request: string): string => {
  const firstSuffixIndex = getFirstSuffixIndex(request);
  return firstSuffixIndex === -1 ? request : request.slice(0, firstSuffixIndex);
};

/**
 * Splits a request into filename, query and hash. A `?` that follows the
 * first `#` belongs to the hash.
 */
export const parseRequest = (request: string): ParsedRequest => {
  const firstSuffixIndex = getFirstSuffixIndex(request);
  if (firstSuffixIndex === -1) {
    return { filename: request, hash: '', query: '' };
  }

  const filename = request.slice(0, firstSuffixIndex);

  const queryIdx = request.indexOf('?');
  const hashIdx = request.indexOf('#');

  const query =
    queryIdx === -1
      ? ''
      : request.slice(queryIdx + 1, hashIdx !== -1 ? hashIdx : undefined);
  const hash = hashIdx === -1 ? '' : request.slice(hashIdx + 1);

  return { filename, hash, query };
};
