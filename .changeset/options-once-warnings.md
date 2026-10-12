---
'@wyw-in-js/transform': patch
---

Warn once per process about options that do not work as written. The options are still applied as before, so the output does not change.

- `eval.resolver: 'custom'` without `eval.customResolver`: imports in evaluated code cannot be resolved. This will be an error in wyw-in-js 3.0.
- `rules` set both in the config file and in the plugin options with different values: the config file `rules` are used, and the plugin `rules` are ignored. In wyw-in-js 3.0, the plugin options will take precedence.
- `prefixer`, `keepComments` or `preprocessor` in the config file: they are read only from the plugin options or CLI flags, so they have no effect there.

Passing the deprecated `customHandlers` argument to `transform()` now emits a one-time `DeprecationWarning` with the code `WYW_CUSTOM_HANDLERS_DEPRECATED`.
