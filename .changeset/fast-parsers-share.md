---
'@wyw-in-js/transform': patch
---

Parsing is cheaper on large projects. Compatible parses on supported runtimes now receive Oxc ASTs via the raw-transfer buffer instead of JSON, parse results are shared across filenames with equivalent parser semantics and across compatible source types, and cache lookups no longer allocate whole-file key strings.
