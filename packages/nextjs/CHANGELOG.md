# @wyw-in-js/nextjs

## 2.5.1

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.5.1

## 2.5.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@2.5.0
  - @wyw-in-js/turbopack-loader@2.5.0
  - @wyw-in-js/webpack-loader@2.5.0

## 2.4.4

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.4.4
  - @wyw-in-js/webpack-loader@2.4.4

## 2.4.3

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.4.3
  - @wyw-in-js/webpack-loader@2.4.3

## 2.4.2

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.4.2
  - @wyw-in-js/webpack-loader@2.4.2

## 2.4.1

### Patch Changes

- 9a2f01a: Fix Next.js builds with `next-rspack` by keeping conditional loader selection at the `use` rule level instead of placing a function inside the loader array.
- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.4.1
  - @wyw-in-js/webpack-loader@2.4.1

## 2.4.0

### Minor Changes

- Bump versions

### Patch Changes

- cf306ed: Fix Next.js webpack builds that combine App and Pages Routers by preserving WyW class names in every CSS issuer layer and skipping direct transforms of `node_modules` dependencies.
- Updated dependencies
  - @wyw-in-js/shared@2.4.0
  - @wyw-in-js/turbopack-loader@2.4.0
  - @wyw-in-js/webpack-loader@2.4.0

## 2.3.1

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.3.1
  - @wyw-in-js/webpack-loader@2.3.1

## 2.3.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@2.3.0
  - @wyw-in-js/turbopack-loader@2.3.0
  - @wyw-in-js/webpack-loader@2.3.0

## 2.2.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@2.2.0
  - @wyw-in-js/turbopack-loader@2.2.0
  - @wyw-in-js/webpack-loader@2.2.0

## 2.1.7

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.1.7
  - @wyw-in-js/webpack-loader@2.1.6

## 2.1.6

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.1.6
  - @wyw-in-js/webpack-loader@2.1.5

## 2.1.5

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.1.5
  - @wyw-in-js/webpack-loader@2.1.4

## 2.1.4

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.1.4

## 2.1.3

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.1.3
  - @wyw-in-js/webpack-loader@2.1.3

## 2.1.2

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.1.2
  - @wyw-in-js/webpack-loader@2.1.2

## 2.1.1

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.1.1
  - @wyw-in-js/webpack-loader@2.1.1

## 2.1.0

### Minor Changes

- Bump versions

### Patch Changes

- 792b6df: Fix Next.js Turbopack production builds by routing generated WyW CSS through a Turbopack query loader path on versions that support query conditions, while preserving sidecar output as the fallback for older Turbopack configs.
- Updated dependencies
  - @wyw-in-js/shared@2.1.0
  - @wyw-in-js/turbopack-loader@2.1.0
  - @wyw-in-js/webpack-loader@2.1.0

## 2.0.2

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.0.2
  - @wyw-in-js/webpack-loader@2.0.2

## 2.0.1

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.0.1
  - @wyw-in-js/webpack-loader@2.0.1

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

### Patch Changes

- 2524aa4: Add native Oxc-backed import resolution for build-time evaluation.

  Hybrid eval resolution now tries a custom resolver first, then native resolution, then the bundler resolver. Native resolution is powered by `oxc-resolver`, discovers `tsconfig.json` by default, and receives static string aliases from Vite, esbuild, webpack, and Next Turbopack integrations while preserving explicitly configured `oxcOptions.resolver.alias` entries.

- Updated dependencies
  - @wyw-in-js/shared@2.0.0
  - @wyw-in-js/turbopack-loader@2.0.0
  - @wyw-in-js/webpack-loader@2.0.0

## 2.0.0-alpha.2

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.0.0-alpha.2
  - @wyw-in-js/webpack-loader@2.0.0-alpha.2

## 2.0.0-alpha.1

### Patch Changes

- 4fce392: Rename the eval resolver mode from `node` to `native` and resolve native eval imports with `oxc-resolver`. Hybrid eval resolution now tries the custom resolver, then native resolution, then the bundler resolver.

  Native eval resolution now discovers `tsconfig.json` by default. Vite, esbuild, webpack, and Next Turbopack integrations forward static string aliases from their bundler config into native resolver options, while preserving explicitly configured `oxcOptions.resolver.alias` entries.

- Updated dependencies
  - @wyw-in-js/shared@2.0.0-alpha.1
  - @wyw-in-js/turbopack-loader@2.0.0-alpha.1
  - @wyw-in-js/webpack-loader@2.0.0-alpha.1

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

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@2.0.0-alpha.0
  - @wyw-in-js/webpack-loader@2.0.0-alpha.0

## 1.0.9

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@1.0.8
  - @wyw-in-js/webpack-loader@1.0.8

## 1.0.8

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@1.0.7
  - @wyw-in-js/webpack-loader@1.0.7

## 1.0.7

### Patch Changes

- c1218dd: Fix Next.js eval crashes by defaulting `importOverrides` for `react` (and JSX runtimes) so build-time evaluation resolves React via Node instead of Next's vendored RSC runtime.

## 1.0.6

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@1.0.6
  - @wyw-in-js/webpack-loader@1.0.6

## 1.0.5

### Patch Changes

- a936749: Drop Node.js <20 support (Node 18 is EOL).

  Note: WyW `1.0.0` already effectively required Node 20 in practice; this change makes the support policy explicit and
  aligns docs/CI accordingly.

  If DOM emulation is enabled (`features.happyDOM`), but `happy-dom` cannot be loaded via `require()` (ESM-only), WyW will
  fall back to running without DOM and print a one-time warning with guidance.

- Updated dependencies
  - @wyw-in-js/turbopack-loader@1.0.5
  - @wyw-in-js/webpack-loader@1.0.5

## 1.0.4

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@1.0.4
  - @wyw-in-js/webpack-loader@1.0.4

## 1.0.3

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@1.0.3
  - @wyw-in-js/webpack-loader@1.0.3

## 1.0.2

### Patch Changes

- Bump versions
- Updated dependencies
  - @wyw-in-js/turbopack-loader@1.0.2
  - @wyw-in-js/webpack-loader@1.0.2

## 1.0.1

### Patch Changes

- 5882514: Fix publishing so released packages don't contain `workspace:*` dependency ranges (npm install compatibility).
- Updated dependencies
  - @wyw-in-js/turbopack-loader@1.0.1
  - @wyw-in-js/webpack-loader@1.0.1

## 1.0.0

### Major Changes

- 94c5efa: Release **1.0.0** introduces no breaking changes compared to previous releases.

  This release establishes a stable baseline for future development, including upcoming releases focused on performance
  and build-time optimizations.

### Minor Changes

- 0b87b81: Add official Next.js integration via `withWyw()` and make `@wyw-in-js/webpack-loader` compatible with Next.js CSS extraction.
- 4cf8447: Add Turbopack support for Next.js via `turbopack.rules` and introduce `@wyw-in-js/turbopack-loader`.

### Patch Changes

- 16a64ad: Document the `prefixer: false` option to disable vendor prefixing in bundler plugins.
- Updated dependencies
  - @wyw-in-js/turbopack-loader@1.0.0
  - @wyw-in-js/webpack-loader@1.0.0
