# @wyw-in-js/vite

## 2.5.1

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@2.5.1

## 2.5.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@2.5.0
  - @wyw-in-js/transform@2.5.0

## 2.4.4

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@2.4.4

## 2.4.3

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@2.4.3

## 2.4.2

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@2.4.2

## 2.4.1

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@2.4.1

## 2.4.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@2.4.0
  - @wyw-in-js/transform@2.4.0

## 2.3.1

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@2.3.1

## 2.3.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@2.3.0
  - @wyw-in-js/transform@2.3.0

## 2.2.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@2.2.0
  - @wyw-in-js/transform@2.2.0

## 2.1.6

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@2.1.6

## 2.1.5

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@2.1.5

## 2.1.4

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@2.1.4

## 2.1.3

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@2.1.3

## 2.1.2

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@2.1.2

## 2.1.1

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@2.1.1

## 2.1.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@2.1.0
  - @wyw-in-js/transform@2.1.0

## 2.0.2

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@2.0.2

## 2.0.1

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@2.0.1

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

- 2524aa4: Add a supported processor diagnostics API that lets library-owned processors emit structured non-fatal warnings through WyW.

  This adds:

  - `BaseProcessor.addDiagnostic()` and typed diagnostics helpers in `@wyw-in-js/processor-utils`
  - normalized `diagnostics` output from `@wyw-in-js/transform`
  - diagnostics reporting in `@wyw-in-js/vite` and `@wyw-in-js/cli`

  Existing hard failures and metadata sidecar behavior stay intact.

- 2524aa4: Add opt-in metadata manifest output across `@wyw-in-js/shared`, `@wyw-in-js/transform`, `@wyw-in-js/vite`, and `@wyw-in-js/cli`.

  When `outputMetadata` is enabled:

  - `@wyw-in-js/transform` now returns normalized, public metadata alongside the existing transform result.
  - `@wyw-in-js/vite` emits `.wyw-in-js.json` sidecar assets during build.
  - `@wyw-in-js/cli` writes matching `.wyw-in-js.json` sidecar files and supports an `--output-metadata` flag.

  This keeps default JS/CSS output unchanged while exposing stable metadata artifacts for CLI, Vite, and transform consumers.

### Patch Changes

- 2524aa4: Add native Oxc-backed import resolution for build-time evaluation.

  Hybrid eval resolution now tries a custom resolver first, then native resolution, then the bundler resolver. Native resolution is powered by `oxc-resolver`, discovers `tsconfig.json` by default, and receives static string aliases from Vite, esbuild, webpack, and Next Turbopack integrations while preserving explicitly configured `oxcOptions.resolver.alias` entries.

- Updated dependencies
  - @wyw-in-js/shared@2.0.0
  - @wyw-in-js/transform@2.0.0

## 2.0.0-alpha.2

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@2.0.0-alpha.2

## 2.0.0-alpha.1

### Patch Changes

- 4fce392: Rename the eval resolver mode from `node` to `native` and resolve native eval imports with `oxc-resolver`. Hybrid eval resolution now tries the custom resolver, then native resolution, then the bundler resolver.

  Native eval resolution now discovers `tsconfig.json` by default. Vite, esbuild, webpack, and Next Turbopack integrations forward static string aliases from their bundler config into native resolver options, while preserving explicitly configured `oxcOptions.resolver.alias` entries.

- Updated dependencies
  - @wyw-in-js/shared@2.0.0-alpha.1
  - @wyw-in-js/transform@2.0.0-alpha.1

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

- 69004e7: Add a supported processor diagnostics seam that lets library-owned processors emit structured non-fatal warnings through WyW.

  This adds:

  - `BaseProcessor.addDiagnostic()` and typed diagnostics helpers in `@wyw-in-js/processor-utils`
  - normalized `diagnostics` output from `@wyw-in-js/transform`
  - diagnostics reporting in `@wyw-in-js/vite` and `@wyw-in-js/cli`

  Existing hard failures and metadata sidecar behavior stay intact.

- 69004e7: Add opt-in metadata manifest output across `@wyw-in-js/shared`, `@wyw-in-js/transform`, `@wyw-in-js/vite`, and `@wyw-in-js/cli`.

  When `outputMetadata` is enabled:

  - `@wyw-in-js/transform` now returns normalized, public metadata alongside the existing transform result.
  - `@wyw-in-js/vite` emits `.wyw-in-js.json` sidecar assets during build.
  - `@wyw-in-js/cli` writes matching `.wyw-in-js.json` sidecar files and supports an `--output-metadata` flag.

  This keeps default JS/CSS output unchanged while exposing stable metadata artifacts for CLI, Vite, and transform consumers.

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@2.0.0-alpha.0
  - @wyw-in-js/transform@2.0.0-alpha.0

## 1.0.9

### Patch Changes

- 0a0b12f: Restore preserved-module JS-to-CSS links for WyW-generated CSS assets in Vite library builds.

## 1.0.8

### Patch Changes

- ba60b51: Add Vite 8 support without dropping Vite 5-7 compatibility, and fix destructured binding evaluation in `@wyw-in-js/transform` on newer Babel versions.
- Updated dependencies
  - @wyw-in-js/transform@1.0.8

## 1.0.7

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@1.0.5
  - @wyw-in-js/transform@1.0.7

## 1.0.6

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@1.0.6

## 1.0.5

### Patch Changes

- 3dec017: Fix cache invalidation storms when loader-provided code differs from filesystem code, keep the Vite resolver stable across repeated `configResolved` calls, and avoid eagerly walking dynamic import targets during eval-only runs (prevents `action handler is already set` and improves build performance on large projects).
- a936749: Drop Node.js <20 support (Node 18 is EOL).

  Note: WyW `1.0.0` already effectively required Node 20 in practice; this change makes the support policy explicit and
  aligns docs/CI accordingly.

  If DOM emulation is enabled (`features.happyDOM`), but `happy-dom` cannot be loaded via `require()` (ESM-only), WyW will
  fall back to running without DOM and print a one-time warning with guidance.

- 9e08238: Fix cache invalidation when a file is first read from the filesystem and later provided by a bundler/loader, preventing stale transforms and related Vite build/dev issues.
- ed6a3e6: Fix a Vite dev error ("action handler is already set") by isolating WyW transform cache per plugin context.
- Updated dependencies
  - @wyw-in-js/shared@1.0.4
  - @wyw-in-js/transform@1.0.5

## 1.0.4

### Patch Changes

- b3bc127: Fix async module resolution by calling the bundler `resolve()` with the correct plugin context.
- Updated dependencies
  - @wyw-in-js/shared@1.0.3
  - @wyw-in-js/transform@1.0.4

## 1.0.3

### Patch Changes

- adbd48c: Avoid falling back to Node resolution for Vite `external` resolved file ids (incl. `external: "absolute"`), which could break aliased imports during build-time evaluation (SSR/dev).
- Updated dependencies
  - @wyw-in-js/transform@1.0.3

## 1.0.2

### Patch Changes

- 30121b1: Handle Vite `/@fs/` resolved ids so alias imports resolve during eval instead of falling back to Node.
- Updated dependencies
  - @wyw-in-js/shared@1.0.2
  - @wyw-in-js/transform@1.0.2

## 1.0.1

### Patch Changes

- 5882514: Fix publishing so released packages don't contain `workspace:*` dependency ranges (npm install compatibility).
- Updated dependencies
  - @wyw-in-js/shared@1.0.1
  - @wyw-in-js/transform@1.0.1

## 1.0.0

### Major Changes

- 94c5efa: Release **1.0.0** introduces no breaking changes compared to previous releases.

  This release establishes a stable baseline for future development, including upcoming releases focused on performance
  and build-time optimizations.

### Patch Changes

- 08475ce: Add an opt-in `ssrDevCss` mode to avoid SSR dev FOUC by serving aggregated CSS and injecting a stylesheet link in transformed HTML.
- 16a64ad: Document the `prefixer: false` option to disable vendor prefixing in bundler plugins.
- fcb118a: Add a `keepComments` option for the stylis preprocessor to preserve selected CSS comments.
- 64b7698: Prevent concurrent transforms from reusing cached actions with different handler instances by stabilizing resolvers across bundlers.
- 870b07b: Handle unknown/dynamic import specifiers without transform-time crashes, add `importOverrides` (mock/noShake/unknown policy), and emit a deduped warning only when eval reaches Node resolver fallback (bundler-native where possible).
- ae740bf: Add `transformLibraries` option to allow transforming selected dependencies inside `node_modules` (opt-in; still recommended to narrow via filters).
- f8744ad: Avoid manually calling `optimizeDeps()` from the plugin resolve path when Vite returns a missing optimized-deps entry. This prevents Vite 7 deprecation spam and reduces dev server startup overhead.
- a5302b2: Defer reloading generated `*.wyw-in-js.css` modules to avoid Vite dev-server soft-invalidation errors.
- 4c268ad: Support Vite's `import.meta.env.*` during build-time evaluation.
- bd93f67: Add `preserveCssPaths` option to keep directory structure for generated `*.wyw-in-js.css` assets when using Rollup `preserveModules`.
- Updated dependencies
  - @wyw-in-js/shared@1.0.0
  - @wyw-in-js/transform@1.0.0

## 0.8.1

### Patch Changes

- 691f946: Handle Vite virtual modules like `/@react-refresh` without filesystem lookups to prevent ENOENT in dev.
- fcfdf52: Avoid infinite recursion when encountering import cycles while invalidating the cache.
- Updated dependencies [691f946]
- Updated dependencies [b33ed9c]
- Updated dependencies [fcfdf52]
  - @wyw-in-js/transform@0.8.1
  - @wyw-in-js/shared@0.8.1

## 0.8.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies [4212218]
- Updated dependencies
  - @wyw-in-js/transform@0.8.0
  - @wyw-in-js/shared@0.8.0

## 0.7.0

### Minor Changes

- 168341b: New option `prefixer` that allows disabling the built-in CSS-prefixed.
- 58da575: Ensure cache invalidates correctly when dependency content changes.

### Patch Changes

- Updated dependencies [168341b]
- Updated dependencies [58da575]
  - @wyw-in-js/transform@0.7.0
  - @wyw-in-js/shared@0.7.0

## 0.6.0

### Minor Changes

- 4c0071d: Configurable code remover can detect and remove from evaluation HOCs and components with specific explicit types.

### Patch Changes

- Updated dependencies [4c0071d]
- Updated dependencies [fc07b6b]
  - @wyw-in-js/transform@0.6.0
  - @wyw-in-js/shared@0.6.0

## 0.5.5

### Patch Changes

- Updated dependencies [6bd612a]
- Updated dependencies [830d6df]
- Updated dependencies [fcfc357]
- Updated dependencies [81bcb65]
  - @wyw-in-js/shared@0.5.5
  - @wyw-in-js/transform@0.5.5

## 0.5.4

### Patch Changes

- Updated dependencies [3cadae5]
- Updated dependencies
  - @wyw-in-js/transform@0.5.4
  - @wyw-in-js/shared@0.5.4

## 0.5.3

### Patch Changes

- Updated dependencies [21f175c]
- Updated dependencies
  - @wyw-in-js/transform@0.5.3
  - @wyw-in-js/shared@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@0.5.2
  - @wyw-in-js/transform@0.5.2

## 0.5.1

### Patch Changes

- ee9e680: Fix CSS updation during Vite HMR where the new change wouldn't get correctly applied
- Updated dependencies
- Updated dependencies [cd7b7f0]
  - @wyw-in-js/shared@0.5.1
  - @wyw-in-js/transform@0.5.1

## 0.5.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies [aa1ca75]
- Updated dependencies [9d7cb05]
- Updated dependencies
  - @wyw-in-js/shared@0.5.0
  - @wyw-in-js/transform@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies
- Updated dependencies [399d5b4]
- Updated dependencies [3a494ef]
  - @wyw-in-js/shared@0.4.1
  - @wyw-in-js/transform@0.4.1

## 0.4.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies [edf8c81]
- Updated dependencies [c1a83e4]
- Updated dependencies
- Updated dependencies [8eca477]
- Updated dependencies [0af626b]
  - @wyw-in-js/transform@0.4.0
  - @wyw-in-js/shared@0.4.0

## 0.3.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies
- Updated dependencies [e2c567a]
  - @wyw-in-js/shared@0.3.0
  - @wyw-in-js/transform@0.3.0

## 0.2.3

### Patch Changes

- cdb2578: fix: handle cases when transforms don't generate CSS
- Updated dependencies
- Updated dependencies [ec051b7]
- Updated dependencies [769653f]
  - @wyw-in-js/shared@0.2.3
  - @wyw-in-js/transform@0.2.3

## 0.2.2

### Patch Changes

- 740e336: Fix regression from #19 that kills some exports.
- Updated dependencies
- Updated dependencies [e1701d5]
- Updated dependencies [740e336]
- Updated dependencies [a8e5da0]
  - @wyw-in-js/shared@0.2.2
  - @wyw-in-js/transform@0.2.2

## 0.2.1

### Patch Changes

- Bump versions
- Updated dependencies
  - @wyw-in-js/transform@0.2.1
  - @wyw-in-js/shared@0.2.1

## 0.2.0

### Minor Changes

- ca5c2e7: All Linaria-related things were renamed.

### Patch Changes

- e3b1583: docs: add README file
- Updated dependencies [4b869aa]
- Updated dependencies [ca5c2e7]
  - @wyw-in-js/transform@0.2.0
  - @wyw-in-js/shared@0.2.0

## 0.1.1

### Patch Changes

- 334833c: Plugin for Vite.
- 6166aa6: Plugin for esbuild.
- Updated dependencies [6f8ae08]
- Updated dependencies
  - @wyw-in-js/transform@0.1.1
  - @wyw-in-js/shared@0.1.1
