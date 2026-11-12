---
'@wyw-in-js/transform': patch
---

Share one abort listener per cache epoch signal between the action steps that wait on it, instead of adding and removing a listener for every step. Adding or removing a listener costs as much as the number of listeners already on the signal, so with many transforms in flight at once, as when a bundler starts every transform together, each step got slower as more steps waited. A waiting step still stops with the same error when its epoch is retired.
