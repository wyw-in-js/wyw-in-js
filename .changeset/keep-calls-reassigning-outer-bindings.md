---
"@wyw-in-js/transform": patch
---

Keep a call to a function or class whose body replaces an outer binding with a plain `=` assignment, such as `let n = 0; function init() { n = 5; } init(); export const V = n;`. Previously the shaker treated the call as free of side effects and removed it, so build-time evaluation silently read the initial value of the binding (`0` instead of `5`). Compound assignments, updates and property writes were already kept; assignments to a local variable or a parameter of the callable are still removed.
