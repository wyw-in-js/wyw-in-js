---
"@wyw-in-js/cli": patch
---

Update `glob` to 14.0.4 in `@wyw-in-js/cli`, so that the CLI uses `minimatch` 11 with the fix for the denial-of-service advisory GHSA-g3hv-75wg-m249 instead of the vulnerable `minimatch` 9 that `glob` 10 required.
