---
'@wyw-in-js/transform': patch
---

Parsing got dramatically cheaper on large projects. ASTs now transfer from oxc via the raw-transfer buffer instead of JSON, the parse cache is shared across filenames and source types (identical snippets and files parse once), and cache lookups no longer allocate whole-file key strings. Measured on a 6.5k-module monorepo build: oxc-parser self-time 5.8s → 1.5s, wyw transform −32%, collect −47%.
