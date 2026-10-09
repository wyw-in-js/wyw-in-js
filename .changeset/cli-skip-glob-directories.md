---
'@wyw-in-js/cli': patch
---

Skip directories matched by file patterns instead of stopping the run. Previously, a pattern that also matched a directory left every file unprocessed, printed no summary, and skipped the debug report.
