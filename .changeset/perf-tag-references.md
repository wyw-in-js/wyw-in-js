---
'@wyw-in-js/transform': patch
---

Determine whether processor tags are referenced with a single walk per program instead of one walk per tag. Files with many styled components no longer scale quadratically in the preeval and collect passes.
