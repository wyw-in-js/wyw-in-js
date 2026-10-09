---
'@wyw-in-js/transform': patch
---

Separate static processor results from executable evaluation artifacts. Fully resolved static roots now generate and prepare evaluation code only when execution is requested, avoiding unused pruning, tree-shaking, and CommonJS emission while preserving dependency tracking and runtime output.

Reduce repeated AST traversals, source hashing, and line-array copying during the remaining transform stages.
