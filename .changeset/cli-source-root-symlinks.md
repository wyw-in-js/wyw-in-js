---
'@wyw-in-js/cli': patch
---

Write CSS into `--out-dir` when `--source-root` and the file patterns reach the same directory by different paths, for example through a symbolic link (on macOS, `/tmp` is a link to `/private/tmp`). Previously, such files were written outside `--out-dir`, often next to the source files, and `--insert-css-requires` could append the `require` to the source file instead of the compiled one. `--out-dir` and `--insert-css-requires` are still used as given, so the inserted `require` paths do not change.
