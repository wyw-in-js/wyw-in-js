---
'@wyw-in-js/shared': patch
---

Share `findPackageJSON` lookups between the directories of a package. A bare specifier is now resolved once for every directory that resolves it the same way (up to the nearest directory with its own `node_modules`, `package.json`, `tsconfig.json` or `jsconfig.json`), instead of once for every importer directory, which makes processor lookups across a project cheaper.
