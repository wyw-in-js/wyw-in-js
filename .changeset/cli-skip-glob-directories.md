---
'@wyw-in-js/cli': patch
---

Skip directories and symbolic links to directories matched by file patterns instead of stopping the run. Previously, a pattern that also matched a directory left every file unprocessed, printed no summary, and skipped the debug report, and a link to a directory stopped the run with `EISDIR`. A broken link still fails the run.
