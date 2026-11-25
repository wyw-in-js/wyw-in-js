---
'@wyw-in-js/shared': patch
'@wyw-in-js/transform': patch
---

The eval runner starts faster: it no longer loads `debug` and `find-up` at startup. Functions passed in `eval.globals` or returned by `overrideContext` are restored in the eval runner with access to the Node.js modules `fs`, `path`, `vm`, `NativeModule`, `createRequire`, `pathToFileURL`, `Console` and `Writable`, and no longer see the runner's internal variables. A line on the runner's stdout that is valid JSON but not a protocol message is now reported as a warning and skipped.
