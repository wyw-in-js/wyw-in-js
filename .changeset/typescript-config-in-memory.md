---
'@wyw-in-js/transform': patch
---

Compile `.ts` config files in memory instead of through cosmiconfig's loader, which writes the output to a shared `<name>.cjs` next to the config. Worker threads loading the same config at once (`parallel`) no longer delete that file under each other, and a read-only config directory works. On Bun, `.ts` configs load through Bun's own TypeScript support.
