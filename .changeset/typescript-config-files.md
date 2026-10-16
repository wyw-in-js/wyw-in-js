---
'@wyw-in-js/transform': minor
---

Load an explicit `configFile` written in TypeScript without the TypeScript compiler API (TypeScript 7 ships none), and `.mts` and `.cts` config files, which had no loader: a runtime that strips types itself (Node.js 22.18+ and 23.6+, Bun) loads them with `require()`. Node.js only strips erasable syntax: no `enum`, and relative imports name their extension.
