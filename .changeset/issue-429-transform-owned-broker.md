---
'@wyw-in-js/transform': patch
---

Dispose the eval broker of a transform-owned cache when the transform finishes. With `features.globalCache: false`, or when a caller passes no `cache`, `transform()` mints a `TransformCacheCollection` for that one call and the broker registry keys the eval runner by it. Bundler plugins only dispose brokers of the caches they own, so every such transform leaked a `runner.js` child process and `vite build` never exited (#429). The plugin-owned cache path and `evalBrokerScope` are unchanged.
