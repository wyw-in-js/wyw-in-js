---
"@wyw-in-js/transform": patch
---

Keep statements that read `new.target` when a module is prepared for evaluation. Previously every such statement was removed as if it read `import.meta`, so constructors that branch on `new.target`, or set `this.name = new.target.name` and `Object.setPrototypeOf(this, new.target.prototype)` in an `Error` subclass, behaved differently at build time: an interpolation evaluated to `undefined`, threw, or got the wrong value. Only statements that read `import.meta` are removed now.
