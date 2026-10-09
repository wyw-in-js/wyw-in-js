---
'@wyw-in-js/transform': patch
---

Treat `undefined` as a known value when statically evaluating template interpolations. Values such as `{ accent: undefined }`, `[undefined]`, `flag ? undefined : value` and calls with an `undefined` or `void 0` argument no longer stop static evaluation, so interpolations like `${theme.accent ?? 'red'}` resolve without build-time evaluation. The handling of `process.env` reads is unchanged.
