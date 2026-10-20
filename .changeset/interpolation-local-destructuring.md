---
'@wyw-in-js/transform': patch
---

Fix interpolation functions that declare variables with destructuring, such as `${({ size }) => { const { radius } = sizes[size]; return radius; }}`. They no longer fail with "local snapshot depends on executed side effects that cannot be safely hoisted": a declaration inside the function runs when the function is called, so nothing has to be hoisted for it.
