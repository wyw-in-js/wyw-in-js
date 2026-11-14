---
"@wyw-in-js/shared": patch
"@wyw-in-js/transform": patch
---

Update `minimatch` to 11.0.5 in `@wyw-in-js/shared` and `@wyw-in-js/transform`. The 9.x line has no fix for the denial-of-service advisory GHSA-g3hv-75wg-m249 (globparts amplification), which is fixed only in 11.0.1 and later. Feature flag globs and `importOverrides` keys match as before.
