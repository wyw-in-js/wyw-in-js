---
'@wyw-in-js/transform': minor
---

An explicit `configFile` can now be a `.mts` or `.cts` file, and a `.ts` one can load without the TypeScript compiler API (TypeScript 7 ships none) or use `import.meta`: a runtime that strips types itself (Node.js 22.18+ and 23.6+, Bun) loads such files with `require()`. Node.js only strips erasable syntax: no `enum`, and relative imports name their extension.
