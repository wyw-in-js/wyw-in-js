---
'@wyw-in-js/transform': patch
---

Decide whether a file imports a processor from its top-level import declarations when they are all the imports it has, instead of walking the whole module. A file whose text has no `require`, no `\u` escape, no namespace import and no other `import` keyword (`import()`, `import.meta`, nested declarations) is now answered from `program.body` alone, which makes the check cheaper for the many modules of a project that use no processor. Other files are walked as before, and the answer does not change.
