---
"@wyw-in-js/transform": patch
---

Evaluate module-level values that a function, constructor, method or callback changes while the module loads, instead of resolving them statically. Previously the default `hybrid` strategy (and `static`) took such a value as its initial declaration, so `let size = 0; function init() { size += 5; } init();` produced `0` in the CSS without any error or warning. Now `hybrid` evaluates these values and `static` fails with its usual message about values it could not resolve. Values that only code running later can change, such as an exported setter or a helper that passes an object to `Object.keys`, are still resolved statically.
