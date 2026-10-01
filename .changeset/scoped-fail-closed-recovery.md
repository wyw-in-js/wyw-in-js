---
'@wyw-in-js/transform': patch
---

Scope a fail-closed cache recovery so it no longer takes down the transforms running beside it. A `TransformCacheCollection` shared across a compilation (the webpack/Rspack loader keeps one per compiler and runs loader calls concurrently) reset its whole lifecycle on every recovery: one module's `UnknownDependencyGraphResetError` failed every transform in flight with an error naming a file they never referenced, and `clear('all')` evicted the in-flight rebuild of the very dependency whose graph was incomplete, so it never got a dependency snapshot and every later check reset again.

Recovery still evicts every completed entrypoint, because nothing reachable through an unknown graph can be trusted and that closure cannot be enumerated. It now keeps the in-flight rebuilds, the dependency snapshots that keep evicted graphs known, and the content hashes; the error is recorded per file, and a traversal is retired only when a recovery reset a file it actually read.
