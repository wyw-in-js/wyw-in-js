---
'@wyw-in-js/shared': patch
'@wyw-in-js/transform': patch
'@wyw-in-js/babel-preset': patch
'@wyw-in-js/bun': patch
'@wyw-in-js/nextjs': patch
'@wyw-in-js/rollup': patch
'@wyw-in-js/turbopack-loader': patch
'@wyw-in-js/webpack-loader': patch
---

Move helpers that adapters kept their own copies of into `@wyw-in-js/shared`: `stripQueryAndHash` and `parseRequest`, `isPlainObject`, `canonicalizeForHash`, `normalizeInputSourceMap`, and the CSS constants shared by the Next.js plugin and the Turbopack loader (`WYW_CSS_MODULE_EXTENSION`, `WYW_CSS_OUTPUT_QUERY`). Adapters and transform now import them. The Babel preset option checks and the Next.js config merging now accept plain objects created in another realm (for example by a `vm` context), as transform already did.
