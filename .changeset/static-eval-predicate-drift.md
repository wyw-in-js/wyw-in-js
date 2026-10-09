---
'@wyw-in-js/transform': patch
---

Treat side-effect imports such as `import './polyfill'` as runtime imports when deciding whether a dependency module is statically evaluatable. Such modules are no longer widened to all exports during evaluation.

Fall back to the `hybrid` eval strategy in every stage when `eval.strategy` is left undefined, for example `eval: { strategy: undefined }`. Previously the static resolver treated it as `execute` while the other stages used `hybrid`, so imported values that could be resolved statically were evaluated instead.

Pass static resolution options through object spreads, so `{ ...helper() }` with a helper from `staticBindings` resolves statically like other helper calls.
