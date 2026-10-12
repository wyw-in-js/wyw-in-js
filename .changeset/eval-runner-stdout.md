---
'@wyw-in-js/transform': patch
---

Keep the eval runner working when evaluated code writes to `process.stdout`. The runner talks to the build process over its stdout, and a module that reached the real `process.stdout` (through `require('process')`, or `require('console')`, which returns the original console) could corrupt a message, so the build waited until the eval timeout. Such output now goes to stderr with a `[wyw-runner:host stdout]` prefix, like other console output of the runner.
