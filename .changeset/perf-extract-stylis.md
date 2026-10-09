---
'@wyw-in-js/transform': patch
---

Speed up CSS extraction for files with many styled components. The rules of all processors in a file are merged in place instead of copying the accumulated set for every processor, which scaled quadratically, and the Stylis preprocessor builds its plugin chain once per file instead of once per rule. The generated CSS is unchanged.
