---
'@wyw-in-js/transform': patch
---

Keep the build process alive when the eval runner exits during a write to its stdin. A failed write (for example `EPIPE` after the runner was killed) now only rejects that write: the `'error'` event that Node emits after the write callback no longer crashes the process with `Unhandled 'error' event`, and the failed write queue no longer leaves an unhandled promise rejection behind.
