---
'@wyw-in-js/rollup': patch
---

Return the transformed code for modules from which WyW extracts no CSS. Previously Rollup kept the original source of such modules, so processor replacements and removed processor imports were lost, and the runtime implementation of a tag could end up in the bundle.
