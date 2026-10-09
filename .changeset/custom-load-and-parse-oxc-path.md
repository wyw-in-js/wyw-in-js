---
'@wyw-in-js/transform': patch
---

Use the Oxc pipeline for every entrypoint returned by a custom `loadAndParseFn`, whatever evaluator it reports. Previously, an evaluator other than the built-in Oxc shaker made the prepare, collect and export collection stages throw `matched a legacy evaluator`. The `ast` such a function returns is no longer read. Rules whose `action` names a non-Oxc evaluator are still rejected when the file is loaded.
