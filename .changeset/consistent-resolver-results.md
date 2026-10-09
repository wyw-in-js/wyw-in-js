---
'@wyw-in-js/transform': patch
---

Treat an empty string returned by the bundler resolver during the prepare stage as an unresolved import, as evaluation already did. Such an import is now ignored and retried once, like any other unresolved import, instead of staying in the dependency list with an empty resolved id. The same applies to a resolver that returns `undefined` instead of `null`.

Read the result of `eval.customResolver` once, `id` before `external`, in both the prepare stage and evaluation. Results built from getters or proxies now see the same reads on every path.
