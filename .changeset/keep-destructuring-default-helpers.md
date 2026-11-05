---
"@wyw-in-js/transform": patch
---

Keep the helpers that the default values and computed keys of a destructuring declaration call when that declaration stays in the output. Previously such a helper was removed when a processor template also used it, and the module threw a `ReferenceError` when it ran.
