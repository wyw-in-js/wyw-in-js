---
'@wyw-in-js/cli': minor
'@wyw-in-js/transform': patch
---

Keep vendor prefixes and the `display` normalization in CSS written by the CLI. With `outputFilename` set, the `url()` rewrite stopped the Stylis prefixer, so CLI output had no vendor prefixes and multi-keyword `display` values such as `flex inline` stayed as written. The CLI now writes the same CSS as the bundler plugins with the same options. To keep declarations unprefixed, pass `--no-prefixer`.

Add `--prefixer` (`--no-prefixer`), `--keep-comments`, `--keep-comments-pattern` and `--preprocessor` to the CLI. They match the `prefixer`, `keepComments` and `preprocessor` options of the bundler plugins. A custom preprocessor function cannot be set from the CLI.
