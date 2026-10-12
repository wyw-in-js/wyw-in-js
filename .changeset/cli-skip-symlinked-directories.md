---
'@wyw-in-js/cli': patch
---

Skip symbolic links to directories matched by file patterns, like the directories themselves. Previously, such a link stopped the run with `EISDIR`. A broken link still fails the run.
