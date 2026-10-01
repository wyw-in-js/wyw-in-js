---
"@wyw-in-js/webpack-loader": patch
---

Pass extracted CSS directly to the output loader for every cache mode. This prevents Rspack watch builds from emitting the previous build's CSS and removes the dependency on loader execution order.
