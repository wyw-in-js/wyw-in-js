---
'@wyw-in-js/transform': patch
---

Retry a transform instead of failing with `superseded` when concurrent transforms that share a cache disturb its root module. The root is restarted when another transform evicts it from the cache, including the eviction of a later generation that superseded it, and when another transform widens it into a new generation while it is being evaluated. Action publication fences now report a removed publication as an eviction. Previously, `wyw-in-js --parallel` could fail when a file was evaluated as a dependency of other files while its own transform was in progress, and builds that shared one cache across concurrent transforms, for example two Vite builds with one plugin instance, could fail intermittently under load.
