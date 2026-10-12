---
'@wyw-in-js/transform': patch
---

Keep a side-effect import of a file in evaluated code when `importOverrides` sets `mock` or `noShake` for it under its documented key, the root-relative path of the resolved file (for example `'./src/polyfill.ts'` for `import './polyfill'`). The shaker looked such overrides up only by the specifier as written and dropped the import. A kept import now runs during evaluation, or its mock does.
