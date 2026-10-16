---
'@wyw-in-js/transform': patch
---

When options keep transforms on the main thread, the warning names every option that cannot be sent to a worker, not only the first one, and only suggests a config file for the options a config file can hold: adapter options such as a `preprocessor` function are named without that advice.
