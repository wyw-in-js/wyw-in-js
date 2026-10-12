---
'@wyw-in-js/transform': patch
---

Fix the shaker hanging on minified bundles. In a function that runs when the module loads, many reassignments of a few short names form a dense alias graph, and resolving an alias walked every path of that graph, so the work grew exponentially. A minified polyfill bundle that did not finish within a minute now takes about 0.1 s. With the default `rules`, such files in `node_modules` are not shaken; a bundle vendored into the project or `rules` that shake `node_modules` could hit it. The shaken output does not change.
