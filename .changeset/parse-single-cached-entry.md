---
'@wyw-in-js/transform': patch
---

Fix `Unexpected JSX expression` errors on `.js` dependencies that contain JSX. The eval broker's static-module check, barrel analysis, the `__wywPreval` export and CommonJS emit parsed code on their own and skipped the `.js` JSX fallback used by the rest of the pipeline. They now go through the shared parse cache, so they accept the same syntax and reuse an existing parse of the same code instead of parsing it again. `parseFile` also accepts JSX in `.js` files and still returns a fresh AST that the caller owns.

Pipeline telemetry reports the internal parses as cached requests; `uncachedRequests` now counts only `parseFile` calls.
