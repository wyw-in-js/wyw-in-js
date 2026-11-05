---
'@wyw-in-js/vite': patch
---

Serve the generated CSS of a module as a stylesheet in dev when it is requested with `?direct`, as Vite does for a `<link rel="stylesheet">`. The plugin dropped the query while resolving the id, so Vite answered with the JavaScript module that injects the styles instead of CSS. Requests without a query are unchanged.
