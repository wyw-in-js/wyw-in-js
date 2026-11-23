---
'@wyw-in-js/transform': patch
---

Update `happy-dom` to `^21.0.4`, which fixes GHSA-c8p4-j97h-3vg8 and GHSA-834v-8h66-3h79. With `happy-dom` 21, code evaluated at build time no longer loads external stylesheets or iframe pages: `<link rel="stylesheet">` and `<iframe>` elements it creates fire an `error` event instead of sending a request.
