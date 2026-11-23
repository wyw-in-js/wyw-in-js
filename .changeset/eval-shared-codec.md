---
'@wyw-in-js/shared': patch
'@wyw-in-js/transform': patch
'@wyw-in-js/babel-preset': patch
---

The eval broker, the eval runner and the Babel preset now share one codec for the values, errors and `eval.globals` that cross the eval protocol, instead of keeping a copy each. An error thrown while a module is evaluated now reaches the build with its original `name` and its whole chain of `cause` errors, where it used to lose its name and the causes created by the evaluated code; the same holds for error values exported by evaluated modules. The Babel preset reports an invalid `eval.globals` value with the same messages as `@wyw-in-js/transform`. The codec is exported from `@wyw-in-js/shared` for wyw-in-js packages only and is not a public API.
