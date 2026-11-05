---
'@wyw-in-js/webpack-loader': patch
---

Forward processor diagnostics from transform results to webpack as warnings, with their severity, category and source location, even when no CSS is extracted. Diagnostics with severity `error` are reported as warnings too, so they do not fail a build.
