import type { ParseRevisionCounter } from './pipelineTelemetry.types';

export const getPipelineParserAttempts = (
  counter: ParseRevisionCounter
): number =>
  (counter.kind === 'cached' ? counter.cacheMisses : counter.requests) +
  counter.jsxFallbackAttempts +
  counter.rawTransferFallbackAttempts;
