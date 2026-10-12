---
'@wyw-in-js/transform': patch
---

Treat an option set to `undefined` as not set. Before, `undefined` replaced the default or the value from the config file:

- `eval.resolver: undefined` left evaluation without a resolver, so every import failed with "Unable to resolve" (or became `undefined` with `errors: 'loose'`); it now resolves through the bundler, the default.
- `eval.require: undefined` turned an import that reached the native resolver fallback into a build error instead of the default warning.
- `eval.errors`, `eval.runtime` and `importLoaders` entries set to `undefined` now get their defaults as well.
- A top-level plugin option set to `undefined` no longer replaces the value from the config file. With `outputMetadata: true` in the config file, the CLI now writes metadata without `--output-metadata`. If a plugin passes, for example, `classNameSlug` or `displayName` as `undefined`, the value from the config file now applies, which can change generated class names.

`features` flags are merged as before.
