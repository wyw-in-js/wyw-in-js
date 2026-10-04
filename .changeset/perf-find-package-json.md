---
'@wyw-in-js/shared': patch
---

Cache `findPackageJSON` results per package name and requesting directory. Processors such as Linaria's `styled` call it for every component wrapped from another module; lookups of bundler aliases (for example `@/components/Button`) previously repeated a failing `require.resolve` through every `node_modules` level and re-read the nearest `package.json` each time.
