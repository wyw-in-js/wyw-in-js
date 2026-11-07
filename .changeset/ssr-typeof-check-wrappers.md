---
"@wyw-in-js/transform": patch
---

Treat an SSR `typeof` check as `"undefined"` during build-time evaluation also when its operand is in parentheses or under a TypeScript wrapper, such as `typeof(window)`, `typeof (window as any)`, `typeof window!` or `typeof (window satisfies object)`. Previously only the bare `typeof window` form was folded, so these forms took the browser branch when styles were evaluated.
