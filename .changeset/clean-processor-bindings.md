---
'@wyw-in-js/transform': patch
---

Avoid constructing binding-pattern caches for plain identifiers and empty declaration lists for other AST nodes while checking whether processor names are shadowed.

Reuse the traversal ancestor stack and take an independent snapshot only when a processor usage is found, instead of copying the chain for every visited AST node.
