---
'@wyw-in-js/transform': patch
---

Stop keeping every earlier version of an edited module in memory. A dev server that edits a file imported by styled modules used to grow by the size of its code and syntax tree on every edit, with or without a shared `TransformCacheCollection`, until the process ran out of memory. The parse cache now keeps at most 16 versions of each file, the static resolution caches of a cache collection keep one version per file, and `invalidateForFile` also clears the static resolution entries of that file.
