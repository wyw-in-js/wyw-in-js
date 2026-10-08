---
'@wyw-in-js/transform': patch
---

Fix `Unexpected JSX expression` errors on `.js` dependencies that contain JSX. The eval broker's static-module check, barrel analysis, the `__wywPreval` export, CommonJS emit and `parseFile` parsed code on their own and skipped the `.js` JSX fallback used by the rest of the pipeline. They now go through the shared parse cache, so they accept the same syntax and reuse an existing parse of the same code instead of parsing it again. `parseFile` returns the cached program, which callers must treat as read-only.

Pipeline telemetry reports these parses as cached requests; `uncachedRequests` stays in the schema and is now 0.
