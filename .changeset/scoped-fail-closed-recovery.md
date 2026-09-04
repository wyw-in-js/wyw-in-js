---
'@wyw-in-js/transform': patch
---

Scope a fail-closed cache recovery to the file whose dependency graph is incomplete. A `TransformCacheCollection` shared across a compilation (the webpack/Rspack loader keeps one per compiler and runs loader calls concurrently) reset its whole lifecycle on every recovery, so one module's `UnknownDependencyGraphResetError` failed every transform in flight with an error naming a file they never referenced. Recovery still clears the caches fail-closed; the error is now recorded per file, and a traversal is retired only when it read state that a recovery reset or when it owns an unconverged recovery of its own.
