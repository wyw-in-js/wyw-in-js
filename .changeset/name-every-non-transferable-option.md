---
'@wyw-in-js/transform': patch
---

When options keep transforms on the main thread, the warning names the options that cannot be sent to a worker (the first five, and how many more), not only the first one, and suggests a config file only for the options a config file can hold: options that only the plugin reads, such as a `preprocessor` function, are named without that advice.
