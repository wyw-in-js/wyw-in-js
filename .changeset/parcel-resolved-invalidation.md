---
'@wyw-in-js/parcel-transformer': patch
---

Rebuild a file in watch mode when a module its styles depend on changes. The transformer registered import specifiers such as `./theme` as watched files, so Parcel never matched them to a real file. It now registers the resolved file paths, resolves any dependency the transform did not resolve through Parcel, and warns when a dependency cannot be resolved to a file.
