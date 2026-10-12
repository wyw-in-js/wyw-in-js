---
'@wyw-in-js/transform': patch
---

Evaluate `.js` dependencies that contain JSX and `.cts` dependencies with TypeScript syntax. Preparing such a module for evaluation stripped it as plain JavaScript and failed with "Unexpected JSX expression" or a syntax error. A `.js` file is now stripped as JSX only when the plain JavaScript grammar rejects its JSX, as the parser already does, so the output for other files does not change.
