---
'@wyw-in-js/transform': patch
---

Fold a computed `require()` specifier during build-time evaluation only through `const` bindings, resolved in the scope where they are declared. Previously a reassigned `let` or `var` kept its initial value, so `let p = './a.js'; p = './b.js'; require(p)` loaded `./a.js`, and a variable shadowed inside a function or block could be read from an outer scope. Specifiers that cannot be proven constant now take the runtime `require()` fallback instead of folding to a wrong module.
