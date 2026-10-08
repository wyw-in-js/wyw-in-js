---
'@wyw-in-js/transform': patch
---

Honor `conditionNames` when the eval runner resolves a module itself: a `require()` reached by evaluated code, the re-resolution of an extensionless resolved id, and a bare external id now use the configured export conditions (or `oxcOptions.resolver.conditionNames`) like the rest of eval-time resolution, instead of Node's defaults. Without configured conditions, resolution is unchanged.

The eval runner no longer exits on a malformed input line: it reports the line on stderr and skips it.
