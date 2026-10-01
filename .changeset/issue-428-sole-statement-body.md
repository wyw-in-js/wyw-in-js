---
'@wyw-in-js/transform': patch
---

Remove control statements whose bodies become empty during dangerous-code removal, fixing invalid syntax for brace-less bodies (#428) and preventing emptied loops from running indefinitely during build-time evaluation. Preserve conditional branches and loop bodies that still contain useful code, as well as loops that were already empty in the original source.
