---
'@wyw-in-js/transform': patch
---

Treat TypeScript expression wrappers (`as`, `!`, `satisfies` and `<T>` assertions) as runtime code during dangerous-code removal. Browser globals reached through them, such as `(window as any).innerWidth` or `document!.body`, are now stubbed like a bare `window.innerWidth` instead of reaching build-time evaluation and failing with `window is not defined`. Members assigned through a wrapped `window` are recognized as browser globals too. Type-only positions such as annotations, generic arguments and `typeof` in types are still ignored.
