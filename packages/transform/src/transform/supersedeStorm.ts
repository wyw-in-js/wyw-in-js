import type { Services } from './types';

// Guards against supersede storms: an oscillating cache invalidation can
// re-create the same entrypoint with a non-widening `only` on every root
// request, looping until the process OOMs. An unknown graph gives us no proof
// that cached dependency output is safe, so the bounded fallback fails loudly
// instead of returning a stale entrypoint.
const SUPERSEDE_STORM_WINDOW_MS = 10_000;
export const SUPERSEDE_STORM_LIMIT = 100;

export const createSupersedeStormError = (name: string) =>
  Object.assign(
    new Error(
      `[wyw-in-js] Supersede storm detected for ${name}: more than ${SUPERSEDE_STORM_LIMIT} non-widening invalidations within ${SUPERSEDE_STORM_WINDOW_MS}ms. ` +
        'The dependency graph did not converge, so the transform was stopped instead of returning potentially stale output.'
    ),
    {
      code: 'WYW_SUPERSEDE_STORM',
      name: 'SupersedeStormError',
    }
  );

interface ISupersedeWindow {
  blocked?: {
    error: Error;
    sourceCode: string;
  };
  resetVersion: number;
  seenAt: number[];
  lastSeenAt: number;
}

interface ISupersedeTracker {
  byName: Map<string, ISupersedeWindow>;
  lastSweepAt: number;
}

// Keyed by the cache collection so parallel builds and tests don't share
// windows. The per-cache map is swept after a quiet window so a long-lived dev
// server does not retain names that stopped invalidating.
const supersedeWindowsByCache = new WeakMap<object, ISupersedeTracker>();

function getSupersedeTracker(services: Services, now: number) {
  let tracker = supersedeWindowsByCache.get(services.cache);
  if (!tracker) {
    tracker = { byName: new Map(), lastSweepAt: now };
    supersedeWindowsByCache.set(services.cache, tracker);
    return tracker;
  }

  if (now < tracker.lastSweepAt) {
    // Date.now can move backwards when the system clock is adjusted. Old
    // timestamps cannot participate in a meaningful rate window afterwards.
    tracker.byName.clear();
    tracker.lastSweepAt = now;
    return tracker;
  }

  if (now - tracker.lastSweepAt >= SUPERSEDE_STORM_WINDOW_MS) {
    const cutoff = now - SUPERSEDE_STORM_WINDOW_MS;
    for (const [name, window] of tracker.byName) {
      if (window.lastSeenAt <= cutoff) {
        tracker.byName.delete(name);
      }
    }
    tracker.lastSweepAt = now;
  }

  return tracker;
}

export function resetSupersedeWindow(services: Services, name: string): void {
  supersedeWindowsByCache.get(services.cache)?.byName.delete(name);
}

export function getBlockedSupersedeError(
  services: Services,
  name: string,
  currentCode: string | undefined
): Error | null {
  const now = Date.now();
  const tracker = getSupersedeTracker(services, now);
  const window = tracker.byName.get(name);
  if (!window?.blocked) {
    return null;
  }

  if (window.resetVersion !== services.cache.getResetVersion()) {
    tracker.byName.delete(name);
    return null;
  }

  if (currentCode !== undefined && currentCode !== window.blocked.sourceCode) {
    tracker.byName.delete(name);
    return null;
  }

  // Repeated attempts are activity, not a quiet interval. Preserve the exact
  // diagnostic object so every retry of unchanged input fails consistently.
  window.lastSeenAt = now;
  return window.blocked.error;
}

export function blockSupersedeWindow(
  services: Services,
  name: string,
  sourceCode: string,
  error: Error
): void {
  const now = Date.now();
  const tracker = getSupersedeTracker(services, now);
  const window = tracker.byName.get(name) ?? {
    resetVersion: services.cache.getResetVersion(),
    seenAt: [],
    lastSeenAt: now,
  };
  window.blocked = { error, sourceCode };
  window.resetVersion = services.cache.getResetVersion();
  window.lastSeenAt = now;
  tracker.byName.set(name, window);
}

export function recordNonWideningSupersede(
  services: Services,
  name: string
): number {
  const now = Date.now();
  const tracker = getSupersedeTracker(services, now);
  let window = tracker.byName.get(name);
  if (
    !window ||
    now < window.lastSeenAt ||
    window.resetVersion !== services.cache.getResetVersion()
  ) {
    window = {
      resetVersion: services.cache.getResetVersion(),
      seenAt: [],
      lastSeenAt: now,
    };
    tracker.byName.set(name, window);
  }

  const cutoff = now - SUPERSEDE_STORM_WINDOW_MS;
  window.seenAt = window.seenAt.filter((seenAt) => seenAt > cutoff);
  window.seenAt.push(now);
  window.lastSeenAt = now;

  // A caller may catch the diagnostic and retry. Keep enough timestamps to
  // preserve the over-limit state without letting that retry loop grow this
  // bookkeeping array itself.
  if (window.seenAt.length > SUPERSEDE_STORM_LIMIT + 1) {
    window.seenAt.splice(0, window.seenAt.length - (SUPERSEDE_STORM_LIMIT + 1));
  }

  return window.seenAt.length;
}
