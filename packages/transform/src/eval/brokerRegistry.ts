import type { TransformCacheEpoch } from '../cache';
import type { CacheRecoveryReason } from '../transform/actions/CacheEpochAbortedError';

export interface EvalBrokerRecoveryParticipant {
  readonly isDisposed: boolean;
  resetAfterCacheInvalidation(
    cache: TransformCacheEpoch['owner'],
    error: Error,
    reason: CacheRecoveryReason
  ): void;
}

const participantsByCache = new WeakMap<
  TransformCacheEpoch['owner'],
  Set<WeakRef<EvalBrokerRecoveryParticipant>>
>();

export const registerEvalBrokerRecoveryParticipant = (
  cache: TransformCacheEpoch['owner'],
  participant: EvalBrokerRecoveryParticipant
): void => {
  const participants = participantsByCache.get(cache) ?? new Set();
  let registered = false;
  for (const reference of participants) {
    const current = reference.deref();
    if (!current || current.isDisposed) {
      participants.delete(reference);
    } else if (current === participant) {
      registered = true;
    }
  }

  if (!registered) {
    participants.add(new WeakRef(participant));
  }
  participantsByCache.set(cache, participants);
};

export const resetEvalBrokersAfterCacheInvalidation = (
  cache: TransformCacheEpoch['owner'],
  error: Error,
  reason: CacheRecoveryReason
): void => {
  const participants = participantsByCache.get(cache);
  if (!participants) return;

  const failures: unknown[] = [];
  for (const reference of participants) {
    const participant = reference.deref();
    if (!participant || participant.isDisposed) {
      participants.delete(reference);
    } else {
      try {
        participant.resetAfterCacheInvalidation(cache, error, reason);
      } catch (resetError) {
        failures.push(resetError);
      }
    }
  }

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      '[wyw-in-js] Failed to reset every evaluation broker'
    );
  }
};
