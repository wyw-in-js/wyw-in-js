---
'@wyw-in-js/transform': patch
---

Return root modules without processor imports before creating an entrypoint. A root that the Oxc shaker would handle, imports nothing mapped to a processor and has no `__wywPreval` export cannot produce artifacts, yet it previously ran the full preeval and prepare stages before the workflow discarded the result. The check reuses the parse cache; files ignored by `rules` or `extensions` keep their previous handling, and transforms with custom handlers still run the full pipeline. When another module depends on such a file, it is loaded from disk and analyzed on demand, as it already was whenever the importer was transformed first.
