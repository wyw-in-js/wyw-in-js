---
'@wyw-in-js/transform': patch
---

Read a module `var` that an interpolation uses above its declaration with the value evaluation sees. Interpolations run at the end of the module, so `${color ?? 'blue'}` above `var color = 'red'` now gives `red` in `eval.strategy` `hybrid` and `static`, as it does in `execute`; the same applies to `||`, `&&`, `typeof`, comparisons, plain reads and functions called from an interpolation. An initializer such as `const c = color ?? 'blue'` above the `var` runs at its declaration and now gives `blue`, as evaluation does, instead of `red`.

When the value of the `var` where the code runs is not statically known, for example because it is assigned again later or passed to a function the static evaluator cannot prove pure, `hybrid` leaves the expression to evaluation. `static` keeps the value earlier versions computed and warns once for each such place; the warning becomes an error in 3.0.
