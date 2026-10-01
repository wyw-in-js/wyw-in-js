---
'@wyw-in-js/transform': patch
'@wyw-in-js/rollup': patch
'@wyw-in-js/parcel-transformer': patch
---

Recover shared transform and evaluation caches as one transaction when a dependency graph is incomplete or a supersede storm is detected. Recovery now retires the complete cache epoch, clears completed and in-flight state, resets every evaluation broker that serves the cache, and gives stale concurrent transform attempts a fresh entrypoint and action context when they retry. The transform that detects a terminal supersede storm still reports that diagnostic. Late work from the retired epoch cannot publish into the rebuilt cache, while a bounded retry budget reports graphs that do not converge.

Transforms that share a cache also hold a semantic cache-key lease for their full retry lifecycle. Compatible sessions can still run concurrently, while incompatible independent transform sessions are applied in FIFO order without clearing cache state underneath an active transform. A nested transform with incompatible cache semantics fails closed instead of waiting in a dependency cycle.

Typed cache-recovery errors, codes, and guards are exported from `@wyw-in-js/transform` so integrations can identify failures without relying on error messages.

Rollup now supplies separate graph-scoped identities for its resolver and dependency loader, allowing recursive dependency transforms to re-enter the same cache lease without losing Rollup's shared-cache handoff while keeping later Rollup graphs isolated.

Parcel transforms now keep their transform cache and resolver-derived semantic session local to each asset lifecycle while sharing one detached evaluation runner across concurrent assets and disposing it when the batch settles. This preserves concurrent asset transforms without allowing asset-local resolver callbacks—or resolver configuration changes during watch mode—to rotate or reuse another asset's cache state, and avoids accumulating child processes.
