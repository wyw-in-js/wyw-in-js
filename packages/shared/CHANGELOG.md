# @wyw-in-js/shared

## 2.6.0

### Minor Changes

- Bump versions

### Patch Changes

- fa857b8: Cache `findPackageJSON` results per package name and requesting directory. Processors such as Linaria's `styled` call it for every component wrapped from another module; lookups of bundler aliases (for example `@/components/Button`) previously repeated a failing `require.resolve` through every `node_modules` level and re-read the nearest `package.json` each time.
- 55d9925: Move helpers that adapters kept their own copies of into `@wyw-in-js/shared`: `stripQueryAndHash` and `parseRequest`, `isPlainObject`, `canonicalizeForHash`, `normalizeInputSourceMap`, and the CSS constants shared by the Next.js plugin and the Turbopack loader (`WYW_CSS_MODULE_EXTENSION`, `WYW_CSS_OUTPUT_QUERY`). Adapters and transform now import them. The Babel preset option checks and the Next.js config merging now accept plain objects created in another realm (for example by a `vm` context), as transform already did.

## 2.5.0

### Minor Changes

- Bump versions

## 2.4.0

### Minor Changes

- Bump versions

## 2.3.0

### Minor Changes

- Bump versions

## 2.2.0

### Minor Changes

- Bump versions

## 2.1.0

### Minor Changes

- cfe67d4: Add a typed `processors` option channel for processor package options.

## 2.0.0

### Major Changes

- 2524aa4: Release WyW-in-JS v2.

  The v2 release moves the published packages to an ESM-only, Oxc-backed transform and evaluation pipeline and requires Node.js >= 22.0.0.

  Breaking changes and migration notes from v1:

  - CommonJS package entrypoints were removed. Migrate configs and tooling to ESM (`import()` / `.mjs`).
  - The transform path now uses Oxc for parsing, analysis, pre-evaluation rewrites, shaking, collection, and code generation. `@wyw-in-js/babel-preset` remains available as a deprecated compatibility wrapper around the Oxc pipeline.
  - Build-time evaluation now runs through the async ESM evaluator (`vm.SourceTextModule` + runner RPC).
  - The default value resolver is `eval.strategy: "hybrid"`: WyW tries static-first resolution for provable values and falls back to evaluator execution for values that still need runtime module evaluation. Use `eval.strategy: "execute"` for evaluator-only compatibility, or `eval.strategy: "static"` to reject evaluator fallback.
  - The previous top-level `evaluate` option is replaced by `eval.strategy`.
  - Eval IPC and config handling are stricter: unsupported `__wywPreval`, `eval.globals`, and inline non-serializable preset/plugin options now fail with explicit migration errors instead of being silently coerced.
  - `require()` inside eval follows the configured `eval.require` fallback behavior (`warn-and-run`, `error`, or `off`).
  - CSS rule emission order can differ from v1 for equivalent extracted rule sets because the static-first/Oxc pipeline can process preserved imports and rules in a different order. Projects that rely on cascade ties between generated rules should make precedence explicit in selector specificity, composition, or source structure.

  Migration guide: https://wyw-in-js.dev/migration/v2

### Minor Changes

- 2524aa4: Add native Oxc-backed import resolution for build-time evaluation.

  Hybrid eval resolution now tries a custom resolver first, then native resolution, then the bundler resolver. Native resolution is powered by `oxc-resolver`, discovers `tsconfig.json` by default, and receives static string aliases from Vite, esbuild, webpack, and Next Turbopack integrations while preserving explicitly configured `oxcOptions.resolver.alias` entries.

- 2524aa4: Expose the public Oxc configuration surface used by the v2 transform path.

  This introduces `oxcOptions` and per-rule `EvalRule.oxcOptions` so projects and bundler integrations can configure parser, transform, and resolver behavior for the Oxc-backed pipeline.

- 2524aa4: Enable static-first value resolution by default with `eval.strategy: "hybrid"`.

  WyW can now resolve many imported literals, fixed objects, compiled TypeScript enum objects, zero-argument helper returns, compound component aliases, processor metadata values, and static metadata helper chains without starting the evaluator or loading the full module graph.

  The default `hybrid` mode keeps evaluator fallback for values that are not statically provable. Use `eval.strategy: "execute"` for evaluator-only compatibility and `eval.strategy: "static"` to reject fallback.

  Add `staticBindings` config for declaring additional statically-known imported values and pure helper functions.

- 2524aa4: Add opt-in metadata manifest output across `@wyw-in-js/shared`, `@wyw-in-js/transform`, `@wyw-in-js/vite`, and `@wyw-in-js/cli`.

  When `outputMetadata` is enabled:

  - `@wyw-in-js/transform` now returns normalized, public metadata alongside the existing transform result.
  - `@wyw-in-js/vite` emits `.wyw-in-js.json` sidecar assets during build.
  - `@wyw-in-js/cli` writes matching `.wyw-in-js.json` sidecar files and supports an `--output-metadata` flag.

  This keeps default JS/CSS output unchanged while exposing stable metadata artifacts for CLI, Vite, and transform consumers.

### Patch Changes

- 2524aa4: Stabilize the v2 Oxc-backed transform and evaluator path for v1-compatible output.

  This covers import/order preservation, export shaking, CommonJS and live-binding emit, runtime source map composition, processor-added imports, hoisted template dependencies, React wrapper handling, Node 22 parse compatibility, dependency graph cache invalidation, and hot-path parse/cache performance.

## 2.0.0-alpha.1

### Minor Changes

- 4fce392: Rename the eval resolver mode from `node` to `native` and resolve native eval imports with `oxc-resolver`. Hybrid eval resolution now tries the custom resolver, then native resolution, then the bundler resolver.

  Native eval resolution now discovers `tsconfig.json` by default. Vite, esbuild, webpack, and Next Turbopack integrations forward static string aliases from their bundler config into native resolver options, while preserving explicitly configured `oxcOptions.resolver.alias` entries.

## 2.0.0-alpha.0

### Major Changes

- bd2a46a: WyW-in-JS packages are now ESM-only and require Node.js >= 22.0.0.

  Breaking changes in v2:

  - CJS `require()` package entrypoints were removed; migrate configs/tooling to ESM (`import()` / `.mjs`).
  - Eval moved to the async ESM runner-based pipeline (`vm.SourceTextModule` + broker RPC), which is now the default path in v2.
  - Eval IPC and Babel preset config handling are stricter:
    - unsupported values in `__wywPreval` now fail explicitly instead of being silently coerced through JSON
    - function-valued preset/plugin options are supported when loaded from config files, while inline non-serializable options now error with migration guidance
    - `eval.globals` encoding and invalidation are more predictable and reject unsupported values earlier
  - `require()` inside eval now follows fallback semantics controlled by `eval.require` (`warn-and-run` / `error` / `off`).

  This release also updates the published bundler integrations, adapter coverage,
  and migration/docs around the v2 evaluator contract, and includes cache and
  warm-runner reuse fixes to keep the new evaluator on the expected performance
  path.

  Migration guide: https://wyw-in-js.dev/migration/v2

- d553b68: Complete the v2 Oxc migration across the core transform and evaluator pipeline.

  This cutover moves the runtime transform path to the Oxc-backed implementation, including module analysis, preeval rewrites, dangerous-code removal, processor application, template dependency extraction, shaker, collect, emit, and the async ESM evaluator flow.

  The public configuration contract is now Oxc-first, with `oxcOptions`, `EvalRule.oxcOptions`, and the `hybrid` resolver mode available across the updated packages. Processor integrations now rely on the engine-neutral `AstService` surface, and the migration includes cache, concurrency, and hot-path performance fixes needed to keep downstream behavior stable after the cutover. `@wyw-in-js/babel-preset` stays available only as a deprecated compatibility wrapper around the Oxc pipeline.

### Minor Changes

- 7754792: Expose the public Oxc configuration surface for the v2 transform path.

  This introduces `oxcOptions`, per-rule `EvalRule.oxcOptions`, and the opt-in `hybrid` eval resolver mode contract used by the Oxc-first pipeline. The default resolver remains `bundler`.

- 1a72b47: Inline statically resolvable imported literals, fixed objects, compiled TypeScript enum objects, zero-argument helper returns, compound component alias metadata, same-module and post-declaration alias metadata, primitive processor metadata, and static metadata helper chains during Oxc pre-evaluation. Static-first value resolution is enabled by default with `eval.strategy: "hybrid"`, while `eval.strategy: "static"` rejects evaluator fallback.

  Cache per-file static metadata pre-evaluation results so multiple static exports from the same module do not repeat the same processor pre-evaluation work.

- 69004e7: Add opt-in metadata manifest output across `@wyw-in-js/shared`, `@wyw-in-js/transform`, `@wyw-in-js/vite`, and `@wyw-in-js/cli`.

  When `outputMetadata` is enabled:

  - `@wyw-in-js/transform` now returns normalized, public metadata alongside the existing transform result.
  - `@wyw-in-js/vite` emits `.wyw-in-js.json` sidecar assets during build.
  - `@wyw-in-js/cli` writes matching `.wyw-in-js.json` sidecar files and supports an `--output-metadata` flag.

  This keeps default JS/CSS output unchanged while exposing stable metadata artifacts for CLI, Vite, and transform consumers.

### Patch Changes

- d553b68: Fix several remaining Oxc parity gaps around processor-added imports, hoisted template dependencies, CommonJS export analysis, runtime source map composition, and live-binding CommonJS emit behavior.

## 1.0.5

### Patch Changes

- 225d70d: Add support for custom `conditionNames` during eval-time fallback resolution so transform can honor package export conditions in monorepo development setups, while keeping extension retry limited to extensionless subpath requests.

## 1.0.4

### Patch Changes

- a936749: Drop Node.js <20 support (Node 18 is EOL).

  Note: WyW `1.0.0` already effectively required Node 20 in practice; this change makes the support policy explicit and
  aligns docs/CI accordingly.

  If DOM emulation is enabled (`features.happyDOM`), but `happy-dom` cannot be loaded via `require()` (ESM-only), WyW will
  fall back to running without DOM and print a one-time warning with guidance.

## 1.0.3

### Patch Changes

- 0f443ab: Avoid installing `@types/debug` as a runtime dependency to prevent leaking global `debug` types into consumer TypeScript projects.

## 1.0.2

### Patch Changes

- Bump versions

## 1.0.1

### Patch Changes

- 5882514: Fix publishing so released packages don't contain `workspace:*` dependency ranges (npm install compatibility).

## 1.0.0

### Major Changes

- 94c5efa: Release **1.0.0** introduces no breaking changes compared to previous releases.

  This release establishes a stable baseline for future development, including upcoming releases focused on performance
  and build-time optimizations.

### Patch Changes

- 62fef83: Fix shaker keeping unused imports in eval bundles (named/namespace/side-effect imports), which could trigger build-time evaluation crashes (e.g. `@radix-ui/react-tooltip`).

  `@wyw-in-js/shared` now passes `importOverrides`/`root` through the evaluator config so the shaker can keep or mock side-effect imports when configured.

  Note: eval bundles for `__wywPreval` now drop `import '...';` side-effect imports by default, to avoid executing unrelated runtime code in Node.js during build. If you rely on a side-effect import at eval time, keep it or stub it via `importOverrides`:

  - `{ noShake: true }` to keep the import (and disable tree-shaking for that dependency).
  - `{ mock: './path/to/mock' }` to redirect the import to a mock module.

- 61fb173: Fix TypeScript consumer builds by shipping `@types/debug` as a dependency (public `.d.ts` imports `debug`).
- 64b7698: Prevent concurrent transforms from reusing cached actions with different handler instances by stabilizing resolvers across bundlers.
- 870b07b: Handle unknown/dynamic import specifiers without transform-time crashes, add `importOverrides` (mock/noShake/unknown policy), and emit a deduped warning only when eval reaches Node resolver fallback (bundler-native where possible).
- 2a8ab79: Extend `tagResolver` with a third `meta` argument (`sourceFile`, `resolvedSource`) so custom tag processors can be resolved reliably.

## 0.8.1

### Patch Changes

- fcfdf52: Avoid infinite recursion when encountering import cycles while invalidating the cache.

## 0.8.0

### Minor Changes

- Bump versions

## 0.7.0

### Minor Changes

- 58da575: Ensure cache invalidates correctly when dependency content changes.

## 0.6.0

### Minor Changes

- 4c0071d: Configurable code remover can detect and remove from evaluation HOCs and components with specific explicit types.

## 0.5.5

### Patch Changes

- 6bd612a: fix(shared): invalid export of interface

## 0.5.4

### Patch Changes

- Bump versions

## 0.5.3

### Patch Changes

- Bump versions

## 0.5.2

### Patch Changes

- Bump versions

## 0.5.1

### Patch Changes

- Bump versions

## 0.5.0

### Minor Changes

- aa1ca75: Add `index` to ClassNameSlugVars

## 0.4.1

### Patch Changes

- Bump versions

## 0.4.0

### Minor Changes

- Bump versions

### Patch Changes

- c1a83e4: Fix crash while resolving esm-only package. Fixes #43
- 0af626b: Removed `<reference types="node" />` from `@wyw-in-js/shared`. Fixes #33.

## 0.3.0

### Minor Changes

- Bump versions

## 0.2.3

### Patch Changes

- Bump versions

## 0.2.2

### Patch Changes

- Bump versions

## 0.2.1

### Patch Changes

- Bump versions

## 0.2.0

### Minor Changes

- ca5c2e7: All Linaria-related things were renamed.

## 0.1.1

### Patch Changes

- Bump versions

## 0.1.0

### Minor Changes

- e02d5d2: `@linaria/babel-preset` and `@linaria/shaker` have been merged into `@wyw-in-js/transform`.
