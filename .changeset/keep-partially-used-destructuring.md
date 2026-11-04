---
"@wyw-in-js/transform": patch
---

Keep a destructuring declaration, and the helpers it calls, when only some of its bindings are consumed by a processor and the rest are still used at runtime. Previously the whole declaration was removed as soon as one binding was only used in a template, leaving the other bindings undefined in the emitted code.
