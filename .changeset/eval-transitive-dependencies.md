---
'@wyw-in-js/transform': patch
---

Report every module an evaluated value depends on in `dependencies`, not only the file's direct imports. When a value is computed at build time through a chain such as `index.ts` → `theme.ts` → `palette.ts`, `palette.ts` is now listed by its resolved path, so bundlers in watch mode rebuild the file when it changes. Direct imports are reported as before. Modules inside `node_modules` are not listed.
