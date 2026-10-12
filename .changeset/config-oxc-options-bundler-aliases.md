---
'@wyw-in-js/transform': patch
---

Keep the bundler aliases when the config file sets `oxcOptions`. Bundler integrations pass the aliases of the bundler config to the native resolver through `oxcOptions.resolver.alias`, but `oxcOptions` from the config file replaced them, so `eval.resolver: 'native'` and the native step of `'hybrid'` could not resolve aliased imports. These aliases now stay, and `oxcOptions.resolver.alias` entries from the config file take precedence over them, as documented. Other `oxcOptions` fields from the config file still replace those passed to the plugin.
