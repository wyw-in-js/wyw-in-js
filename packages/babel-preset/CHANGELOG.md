# @wyw-in-js/babel-preset

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

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@2.0.0
  - @wyw-in-js/transform@2.0.0

## 2.0.0-alpha.2

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@2.0.0-alpha.2

## 2.0.0-alpha.1

### Patch Changes

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

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@2.0.0-alpha.0
  - @wyw-in-js/transform@2.0.0-alpha.0

## 1.0.8

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@1.0.8

## 1.0.7

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@1.0.7

## 1.0.6

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@1.0.6

## 1.0.5

### Patch Changes

- a936749: Drop Node.js <20 support (Node 18 is EOL).

  Note: WyW `1.0.0` already effectively required Node 20 in practice; this change makes the support policy explicit and
  aligns docs/CI accordingly.

  If DOM emulation is enabled (`features.happyDOM`), but `happy-dom` cannot be loaded via `require()` (ESM-only), WyW will
  fall back to running without DOM and print a one-time warning with guidance.

- Updated dependencies
  - @wyw-in-js/transform@1.0.5

## 1.0.4

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@1.0.4

## 1.0.3

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@1.0.3

## 1.0.2

### Patch Changes

- Bump versions
- Updated dependencies
  - @wyw-in-js/transform@1.0.2

## 1.0.1

### Patch Changes

- 5882514: Fix publishing so released packages don't contain `workspace:*` dependency ranges (npm install compatibility).
- Updated dependencies
  - @wyw-in-js/transform@1.0.1

## 1.0.0

### Major Changes

- 94c5efa: Release **1.0.0** introduces no breaking changes compared to previous releases.

  This release establishes a stable baseline for future development, including upcoming releases focused on performance
  and build-time optimizations.

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@1.0.0

## 0.8.1

### Patch Changes

- fcfdf52: Avoid infinite recursion when encountering import cycles while invalidating the cache.
- Updated dependencies [691f946]
- Updated dependencies [b33ed9c]
- Updated dependencies [fcfdf52]
  - @wyw-in-js/transform@0.8.1

## 0.8.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies [4212218]
  - @wyw-in-js/transform@0.8.0

## 0.7.0

### Minor Changes

- 58da575: Ensure cache invalidates correctly when dependency content changes.

### Patch Changes

- Updated dependencies [168341b]
- Updated dependencies [58da575]
  - @wyw-in-js/transform@0.7.0

## 0.6.0

### Minor Changes

- 4c0071d: Configurable code remover can detect and remove from evaluation HOCs and components with specific explicit types.

### Patch Changes

- Updated dependencies [4c0071d]
- Updated dependencies [fc07b6b]
  - @wyw-in-js/transform@0.6.0

## 0.5.5

### Patch Changes

- Updated dependencies [830d6df]
- Updated dependencies [fcfc357]
- Updated dependencies [81bcb65]
  - @wyw-in-js/transform@0.5.5

## 0.5.4

### Patch Changes

- Updated dependencies [3cadae5]
  - @wyw-in-js/transform@0.5.4

## 0.5.3

### Patch Changes

- Updated dependencies [21f175c]
  - @wyw-in-js/transform@0.5.3

## 0.5.2

### Patch Changes

- @wyw-in-js/transform@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies [cd7b7f0]
  - @wyw-in-js/transform@0.5.1

## 0.5.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies [9d7cb05]
- Updated dependencies
  - @wyw-in-js/transform@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies [399d5b4]
- Updated dependencies [3a494ef]
  - @wyw-in-js/transform@0.4.1

## 0.4.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies [edf8c81]
- Updated dependencies [8eca477]
  - @wyw-in-js/transform@0.4.0

## 0.3.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies [e2c567a]
  - @wyw-in-js/transform@0.3.0

## 0.2.3

### Patch Changes

- Updated dependencies [ec051b7]
- Updated dependencies [769653f]
  - @wyw-in-js/transform@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [e1701d5]
- Updated dependencies [740e336]
- Updated dependencies [a8e5da0]
  - @wyw-in-js/transform@0.2.2

## 0.2.1

### Patch Changes

- Bump versions
- Updated dependencies
  - @wyw-in-js/transform@0.2.1

## 0.2.0

### Minor Changes

- ca5c2e7: All Linaria-related things were renamed.

### Patch Changes

- Updated dependencies [4b869aa]
- Updated dependencies [ca5c2e7]
  - @wyw-in-js/transform@0.2.0
