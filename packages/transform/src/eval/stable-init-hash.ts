/* eslint-disable no-void */
import { createHash } from 'crypto';

import { canonicalizeForHash } from '@wyw-in-js/shared';

import type { EvalRunnerInitPayload } from './protocol';

// Hash everything in the init payload that affects whether the runner needs
// a fresh INIT. `entrypoint` only controls __filename/__dirname rebinding and
// is deliberately excluded so callers can memoize the stable configuration.
export const getStableInitPayloadHash = (
  payload: EvalRunnerInitPayload
): string => {
  const { entrypoint, sessionId, ...stable } = payload;
  void entrypoint;
  void sessionId;

  return createHash('sha256')
    .update(JSON.stringify(canonicalizeForHash(stable)))
    .digest('hex');
};
