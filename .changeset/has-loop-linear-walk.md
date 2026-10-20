---
'@wyw-in-js/transform': patch
---

Fix exponential time in the entrypoint loop check. When many modules share deep dependencies, walking every ancestor path took exponentially long and could block the main thread. Each ancestor is now visited once.
