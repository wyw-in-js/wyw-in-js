---
'@wyw-in-js/transform': patch
---

Count a namespace import stored as an object property value (`export const theme = { colors: tokens }`) as a use of the whole namespace. It was recorded as a side-effect-only import, so build-time evaluation could drop the imported module's exports and read `undefined` through the property. Identifiers that only name an object key or a member (`{ tokens: 1 }`, `x.tokens`) no longer keep the whole namespace.
