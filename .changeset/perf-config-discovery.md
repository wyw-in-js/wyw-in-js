---
'@wyw-in-js/transform': patch
'@wyw-in-js/vite': patch
---

Stop repeating config-file discovery for every transformed module. The Vite plugin now passes one options object per environment, so normalized options are reused across files, and `loadWywOptions` remembers the discovered config file (or its absence) per working directory for adapters that still build options per module. A remembered config file that disappears is searched for again; a config file created after the first transform is picked up after a restart.
