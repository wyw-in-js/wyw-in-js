---
'@wyw-in-js/transform': patch
---

Checking which options can be sent to a worker no longer throws `RangeError: Maximum call stack size exceeded` on an option that refers to itself, such as a `window` stub in `eval.globals` whose `self` points back at it.
