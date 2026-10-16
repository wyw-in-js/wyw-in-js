---
'@wyw-in-js/vite': patch
---

Dispose the transform workers and eval runners when the dev server closes, also in middleware mode. The plugin listened only for the `close` event of `httpServer`, which a middleware-mode server does not have, and Vite does not call `closeWatcher` in dev, so the workers stayed alive until the process exited.
