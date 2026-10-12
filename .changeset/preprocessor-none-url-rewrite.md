---
'@wyw-in-js/cli': patch
'@wyw-in-js/transform': patch
---

Rewrite relative `url()` paths for `preprocessor: 'none'` when `outputFilename` is set, as the default Stylis preprocessor does. With `--preprocessor none`, the CLI now writes CSS whose relative `url()` paths point at the assets from the CSS file in `--out-dir`. Callers of `transform()` that pass `preprocessor: 'none'` together with `outputFilename` get the rewritten paths too. Bundler plugins do not set `outputFilename` and are not affected. A custom preprocessor function still gets the original paths.
