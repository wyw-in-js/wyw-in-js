---
'@wyw-in-js/transform': patch
---

Run the CommonJS emit of the transform stage only when its output is read. The stage converted every transformed root and dependency to CommonJS, but only the in-process `Module` evaluator reads that code; transforms that evaluate through the eval broker prepare their own code and never needed it. `Entrypoint.transformedCode` and `EvaluatedEntrypoint.transformResultCode` return the same code as before, computed on first access.
