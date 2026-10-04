---
'@wyw-in-js/transform': patch
---

Avoid repeated shared-cache recovery for static-analysis dependencies and ignored assets while retaining strict graph checks for executable JavaScript. Keep loaded source separate from filesystem freshness evidence and invalidate every affected consumer after a shared dependency changes.

Retain the JavaScript supplied by preceding bundler transforms when concurrent analysis reads TypeScript from disk, including repeated builds using the same cache.

Retry a transform up to three times when dependency invalidation evicts its active root, while preserving publication checks for unrelated replacements.

Detect same-size filesystem edits with unchanged mtime during ordinary freshness probes by checking the complete file stat fingerprint with nanosecond timestamps, including writes within one millisecond.

Preserve supersede errors and retries across analysis, action creation, and evaluation runner callbacks. Prevent same-instance reentrant module evaluation from deadlocking. Bound retries caused by other cache owners to 100, with owned and total counts on convergence errors.
