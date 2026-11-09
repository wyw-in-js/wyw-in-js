---
"@wyw-in-js/transform": patch
---

Evaluate code with DOM emulation (`features.happyDOM`, on by default) in a single JavaScript realm. Previously the global `Object`, `Array`, `TypeError` and other built-in constructors came from the build process while object and array literals and errors thrown by the engine came from the evaluation context, so checks such as `({}).constructor === Object`, `[] instanceof Array` or `error instanceof TypeError` were `false` in evaluated code. They now give the same results as with `happyDOM: false`; the host `Buffer` and `Uint8Array` are still provided. Where happy-dom's `Window` does not get the built-ins of its evaluation context, as on StackBlitz, the previous window is still used.
