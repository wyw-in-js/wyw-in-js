---
'@wyw-in-js/transform': patch
---

Validate processor classes when a tag is looked up. A processor module whose default export is not a class extending `BaseProcessor` now fails with an error that names the file, the tag and the export, instead of being treated as a processor (any function) and failing later, or being silently ignored (a missing default export). Processors built against a different copy of `@wyw-in-js/processor-utils` are still recognized.

Resolve tag processors relative to the importing file. When different packages of a monorepo resolve different versions of a processor package, each importer now gets the processor (and the `wyw-in-js.tags` mapping) of the version it resolves, instead of the version that was looked up first.
