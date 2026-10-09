---
'@wyw-in-js/transform': patch
---

Evaluate template literals exactly as written. Code prepared for evaluation no longer collapses blank lines, rewrites lines starting with `const ` to `var `, or drops a comma before a closing brace across the whole module text, so these rewrites no longer change the contents of multi-line template literals used in styles.
