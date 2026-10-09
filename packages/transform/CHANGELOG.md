# @wyw-in-js/transform

## 2.6.0

### Minor Changes

- ed2a380: Deprecate public exports of `@wyw-in-js/transform` that the transform pipeline no longer needs. They keep working in 2.x and will be removed in 3.0.

  - `Module` and `DefaultModuleImplementation`: the legacy in-process evaluator. `transform()` evaluates modules in a separate runner process and never constructs `Module`. Constructing `Module` now emits a one-time `DeprecationWarning` with the code `WYW_MODULE_DEPRECATED`. `UnprocessedEntrypointError` and `isUnprocessedEntrypointError` are thrown only by this evaluator and are deprecated with it.
  - The `customHandlers` argument of `transform()`, together with `baseHandlers`, `asyncResolveImports` and `syncResolveImports`. They replace internal stages of the action runner, which is not a stable API. To observe stages, pass an `eventEmitter`.
  - Internal helpers and types: `Entrypoint`, `EvaluatedEntrypoint`, `IEvaluatedEntrypoint`, `ParentEntrypoint`, `ITransformFileResult`, `parseFile`, `LoadAndParseFn`, `prepareCode`, `withDefaultServices`, `Services`, `isNode`, `getVisitorKeys`, `VisitorKeys` and `peek`. To type the first argument of `transform()`, use `Parameters<typeof transform>[0]` instead of `Services`.

  Nothing is removed, and runtime behavior is unchanged apart from the new warning.

- a8e53b1: Add opt-in worker threads for transforms. The Vite, esbuild and Bun plugins and the webpack loader accept `parallel: true` (up to four workers) or a worker count, and the CLI accepts `--workers <count>`. Each worker keeps its own cache, a file always returns to the worker that transformed it first, and module resolution still goes through the bundler on the main thread. Options are sent to the workers as data, so function options must be defined in a wyw-in-js config file; with function options or debug reporting, transforms stay on the main thread and a warning explains why. Workers split the parsed-AST cache budget of one process between them and start with a 1.5 GB heap limit, which is raised when a worker runs out of memory. `@wyw-in-js/transform` exports the underlying `TransformWorkerPool` and the `createParallelTransforms` helper for other integrations.

### Patch Changes

- 208752d: Keep vendor prefixes and the `display` normalization in CSS written by the CLI. With `outputFilename` set, the `url()` rewrite stopped the Stylis prefixer, so CLI output had no vendor prefixes and multi-keyword `display` values such as `flex inline` stayed as written. The CLI now writes the same CSS as the bundler plugins with the same options. To keep declarations unprefixed, pass `--no-prefixer`.

  Add `--prefixer` (`--no-prefixer`), `--keep-comments`, `--keep-comments-pattern` and `--preprocessor` to the CLI. They match the `prefixer`, `keepComments` and `preprocessor` options of the bundler plugins. A custom preprocessor function cannot be set from the CLI.

- b45dde6: Treat an empty string returned by the bundler resolver during the prepare stage as an unresolved import, as evaluation already did. Such an import is now ignored and retried once, like any other unresolved import, instead of staying in the dependency list with an empty resolved id. The same applies to a resolver that returns `undefined` instead of `null`.

  Read the result of `eval.customResolver` once, `id` before `external`, in both the prepare stage and evaluation. Results built from getters or proxies now see the same reads on every path.

- 89ad489: Use the Oxc pipeline for every entrypoint returned by a custom `loadAndParseFn`, whatever evaluator it reports. Previously, an evaluator other than the built-in Oxc shaker made the prepare, collect and export collection stages throw `matched a legacy evaluator`. The `ast` such a function returns is no longer read. Rules whose `action` names a non-Oxc evaluator are still rejected when the file is loaded.
- 3514a83: Evaluate template literals exactly as written. Code prepared for evaluation no longer collapses blank lines, rewrites lines starting with `const ` to `var `, or drops a comma before a closing brace across the whole module text, so these rewrites no longer change the contents of multi-line template literals used in styles.
- 4baf51c: Honor `conditionNames` when the eval runner resolves a module itself: a `require()` reached by evaluated code, the re-resolution of an extensionless resolved id, and a bare external id now use the configured export conditions (or `oxcOptions.resolver.conditionNames`) like the rest of eval-time resolution, instead of Node's defaults. Without configured conditions, resolution is unchanged.

  The eval runner no longer exits on a malformed input line: it reports the line on stderr and skips it.

- fd5d24b: Report every module an evaluated value depends on in `dependencies`, not only the file's direct imports. When a value is computed at build time through a chain such as `index.ts` → `theme.ts` → `palette.ts`, `palette.ts` is now listed by its resolved path, so bundlers in watch mode rebuild the file when it changes. Direct imports are reported as before. Modules inside `node_modules` are not listed.
- d1e41d0: Retry a transform instead of failing with `superseded` when concurrent transforms that share a cache disturb its root module. The root is restarted when another transform evicts it from the cache, including the eviction of a later generation that superseded it, and when another transform widens it into a new generation while it is being evaluated. Action publication fences now report a removed publication as an eviction. Previously, `wyw-in-js --parallel` could fail when a file was evaluated as a dependency of other files while its own transform was in progress, and builds that shared one cache across concurrent transforms, for example two Vite builds with one plugin instance, could fail intermittently under load.
- 192e441: Avoid repeated shared-cache recovery for static-analysis dependencies and ignored assets while retaining strict graph checks for executable JavaScript. Keep loaded source separate from filesystem freshness evidence and invalidate every affected consumer after a shared dependency changes.

  Retain the JavaScript supplied by preceding bundler transforms when concurrent analysis reads TypeScript from disk, including repeated builds using the same cache.

  Retry a transform up to three times when dependency invalidation evicts its active root, while preserving publication checks for unrelated replacements.

  Detect same-size filesystem edits with unchanged mtime during ordinary freshness probes by checking the complete file stat fingerprint with nanosecond timestamps, including writes within one millisecond.

  Preserve supersede errors and retries across analysis, action creation, and evaluation runner callbacks. Prevent same-instance reentrant module evaluation from deadlocking. Bound retries caused by other cache owners to 100, with owned and total counts on convergence errors.

- 7191313: Remove control statements whose bodies become empty during dangerous-code removal, fixing invalid syntax for brace-less bodies (#428) and preventing emptied loops from running indefinitely during build-time evaluation. Preserve conditional branches and loop bodies that still contain useful code, as well as loops that were already empty in the original source.
- 192e441: Dispose the eval broker of a transform-owned cache when the transform finishes. With `features.globalCache: false`, or when a caller passes no `cache`, `transform()` mints a `TransformCacheCollection` for that one call and the broker registry keys the eval runner by it. Bundler plugins only dispose brokers of the caches they own, so every such transform leaked a `runner.js` child process and `vite build` never exited (#429). The plugin-owned cache path and `evalBrokerScope` are unchanged.
- c3c0215: Count a namespace import stored as an object property value (`export const theme = { colors: tokens }`) as a use of the whole namespace. It was recorded as a side-effect-only import, so build-time evaluation could drop the imported module's exports and read `undefined` through the property. Identifiers that only name an object key or a member (`{ tokens: 1 }`, `x.tokens`) no longer keep the whole namespace.
- 2055843: Fix build-wide failures of a shared `TransformCacheCollection` (`@wyw-in-js/webpack-loader` and any other consumer that keeps one cache per compilation) in 2.5.0. Six defects, each reproducible in a large Storybook/Rspack build and each fatal for every transform in flight:

  - `UnknownDependencyGraphResetError` for a file that was only read, never loaded. Static preeval and side-effect provenance register the files they read (a value behind a barrel, the target of `styled(Component)` resolved as an opaque runtime component) as invalidation dependencies through `checkFreshness`. Such a file never gets an entrypoint or a dependency snapshot, so `didDependencyChange` reported it as an unknown graph on every check; the fail-closed recovery cleared the whole cache and could never converge. The hops of a re-export chain have the opposite problem: static preeval publishes an analysis root for each of them (`Entrypoint.createRoot(hop, [imported])` in `resolveDependency`) that only resolves imports and never starts processing, so its graph never completes and the first re-check of every importing module reset the cache once more. The cache now tracks which files it has published as entrypoints in the current lifecycle, and entrypoints record whether processing ever started; an invalidation or barrel-manifest dependency that was never published, or whose live entrypoint never started processing, is verified by its content hash alone. Module-graph edges, modules that started processing and evicted once-published modules stay fail-closed.
  - `UnknownDependencyGraphResetError` after a spurious eviction. A bundler loader hands `transform()` the output of the loaders before it, so the `loaded` code of an entrypoint routinely differs from the bytes on disk. The first fs read of such a file compared the disk hash against the `loaded` hash, reported a change, evicted the entrypoint and forgot its snapshot. The cache now captures a separate hash of the raw disk bytes when it first accepts loaded code. Freshness probes compare disk bytes against that baseline, preserving transformed entrypoints while detecting edits even when mtime is unchanged. Republishing loaded code does not replace the baseline; virtual files without one remain conservative.
  - `UnknownDependencyGraphResetError` for asset imports. An ignored entrypoint (`import bg from './bg.svg'`, or any file matched by an ignore rule) is never processed, so `transformed` stays false for its whole life and `isEntrypointGraphIncomplete` treated it as an unfinished graph forever. Ignored entrypoints now count as complete, empty graphs; their content hash is still verified, and their dependency snapshot is retained on eviction.
  - `AbortError: superseded` escaping from a transform whose own entrypoint was never superseded. Static preeval resolves a value imported through another file on an analysis root for that file (`Entrypoint.createRoot(importer, [imported])` in `resolveDependency`). Concurrent transforms resolving different exports of the same barrel create competing analysis roots and supersede each other; since 2.5.0 `resolveImports` aborts for the superseded root, and the abort handlers of `processEntrypoint` and `workflow` only restart their own entrypoint. `resolveDependency` now continues on the superseding generation, which shares the pending resolve tasks.
  - `UnknownDependencyGraphResetError` for a module that a concurrent transform is still processing. A dependency check that walked into the partially filled dependency map of an in-flight module treated the unverifiable transitive graph as a change and evicted every module on the path, including the in-flight one. An evicted in-flight module never gets a dependency snapshot and its transform result lands on an object the cache no longer holds, so the file stays a once-published module without a graph for the rest of the lifecycle and the next bundler request for any reader resets the cache. An unknown graph is now reported to the caller without evicting anything; only a verified change evicts. A file that a reader only read (invalidation dependency) is a hash-verified leaf while a concurrent transform processes it as a module, exactly as when it was never loaded.
  - `UnknownDependencyGraphResetError` after a root created without code. On-demand eval preparation and analysis roots create entrypoints without bundler code; `loadAndParse` reuses the loaded code of the cached generation for them, but the new generation hashed that code as the disk content. The mismatch with the real disk hash looked like an edit: it evicted the cached generation, forgot its dependency snapshot and flipped the fs hash, so the next check of an importer found an unfinished module without a graph. Such a root now carries the reused code as loaded code.

- ced6f3c: Fix `Unexpected JSX expression` errors on `.js` dependencies that contain JSX. The eval broker's static-module check, barrel analysis, the `__wywPreval` export and CommonJS emit parsed code on their own and skipped the `.js` JSX fallback used by the rest of the pipeline. They now go through the shared parse cache, so they accept the same syntax and reuse an existing parse of the same code instead of parsing it again. `parseFile` also accepts JSX in `.js` files and still returns a fresh AST that the caller owns.

  Pipeline telemetry reports the internal parses as cached requests; `uncachedRequests` now counts only `parseFile` calls.

- df2c701: Stop repeating config-file discovery for every transformed module. The Vite plugin now passes one options object per environment, so normalized options are reused across files, and `loadWywOptions` remembers the discovered config file (or its absence) per working directory for adapters that still build options per module. A remembered config file that disappears is searched for again; a config file created after the first transform is picked up after a restart.
- 43a9d3e: Speed up CSS extraction for files with many styled components. The rules of all processors in a file are merged in place instead of copying the accumulated set for every processor, which scaled quadratically, and the Stylis preprocessor builds its plugin chain once per file instead of once per rule. The generated CSS is unchanged.
- d057bdb: Run the CommonJS emit of the transform stage only when its output is read. The stage converted every transformed root and dependency to CommonJS, but only the in-process `Module` evaluator reads that code; transforms that evaluate through the eval broker prepare their own code and never needed it. `Entrypoint.transformedCode` and `EvaluatedEntrypoint.transformResultCode` return the same code as before, computed on first access.
- b554719: Return root modules without processor imports before creating an entrypoint. A root that the Oxc shaker would handle, imports nothing mapped to a processor and has no `__wywPreval` export cannot produce artifacts, yet it previously ran the full preeval and prepare stages before the workflow discarded the result. The check reuses the parse cache; files ignored by `rules` or `extensions` keep their previous handling, and transforms with custom handlers still run the full pipeline. When another module depends on such a file, it is loaded from disk and analyzed on demand, as it already was whenever the importer was transformed first.
- f39ed31: Determine whether processor tags are referenced with a single walk per program instead of one walk per tag. Files with many styled components no longer scale quadratically in the preeval and collect passes.
- 34338ac: Treat TypeScript expression wrappers (`as`, `!`, `satisfies` and `<T>` assertions) as runtime code during dangerous-code removal. Browser globals reached through them, such as `(window as any).innerWidth` or `document!.body`, are now stubbed like a bare `window.innerWidth` instead of reaching build-time evaluation and failing with `window is not defined`. Members assigned through a wrapped `window` are recognized as browser globals too. Type-only positions such as annotations, generic arguments and `typeof` in types are still ignored.
- ffad22e: Validate processor classes when a tag is looked up. A processor module whose default export is not a class extending `BaseProcessor` is now skipped with a one-time warning that names the file, the tag and the export, instead of being treated as a processor (any function) and failing later, or being silently ignored (a missing default export). This warning will become an error in wyw-in-js 3.0. Processors built against a different copy of `@wyw-in-js/processor-utils` are still recognized.

  Resolve tag processors relative to the importing file. When different packages of a monorepo resolve different versions of a processor package, each importer now gets the processor (and the `wyw-in-js.tags` mapping) of the version it resolves, instead of the version that was looked up first.

- b775d3a: Fall back to JSON parsing when Oxc cannot allocate its raw-transfer buffer, and keep using JSON for subsequent parses. This fixes builds failing with `Array buffer allocation failed` on systems with limited allocation capacity.

  Report the switch through the parser debug namespace. Pipeline telemetry schema version 2 adds `rawTransferFallbackAttempts` and includes JSON retries in physical parser attempts and byte totals without inflating logical requests or errors.

- 274bf8e: Separate static processor results from executable evaluation artifacts. Fully resolved static roots now generate and prepare evaluation code only when execution is requested, avoiding unused pruning, tree-shaking, and CommonJS emission while preserving dependency tracking and runtime output.

  Reduce repeated AST traversals, source hashing, and line-array copying during the remaining transform stages.

- f7216c8: Fold a computed `require()` specifier during build-time evaluation only through `const` bindings, resolved in the scope where they are declared. Previously a reassigned `let` or `var` kept its initial value, so `let p = './a.js'; p = './b.js'; require(p)` loaded `./a.js`, and a variable shadowed inside a function or block could be read from an outer scope. Specifiers that cannot be proven constant now take the runtime `require()` fallback instead of folding to a wrong module.
- 192e441: Recover shared transform and evaluation caches as one transaction when a dependency graph is incomplete or a supersede storm is detected. Recovery now retires the complete cache epoch, clears completed and in-flight state, resets every evaluation broker that serves the cache, and gives stale concurrent transform attempts a fresh entrypoint and action context when they retry. The transform that detects a terminal supersede storm still reports that diagnostic. Late work from the retired epoch cannot publish into the rebuilt cache, while a bounded retry budget reports graphs that do not converge.

  Transforms that share a cache also hold a semantic cache-key lease for their full retry lifecycle. Compatible sessions can still run concurrently, while incompatible independent transform sessions are applied in FIFO order without clearing cache state underneath an active transform. A nested transform with incompatible cache semantics fails closed instead of waiting in a dependency cycle.

  Typed cache-recovery errors, codes, and guards are exported from `@wyw-in-js/transform` so integrations can identify failures without relying on error messages.

  Rollup now supplies separate graph-scoped identities for its resolver and dependency loader, allowing recursive dependency transforms to re-enter the same cache lease without losing Rollup's shared-cache handoff while keeping later Rollup graphs isolated.

  Parcel transforms now keep their transform cache and resolver-derived semantic session local to each asset lifecycle while sharing one detached evaluation runner across concurrent assets and disposing it when the batch settles. This preserves concurrent asset transforms without allowing asset-local resolver callbacks—or resolver configuration changes during watch mode—to rotate or reuse another asset's cache state, and avoids accumulating child processes.

- 55d9925: Move helpers that adapters kept their own copies of into `@wyw-in-js/shared`: `stripQueryAndHash` and `parseRequest`, `isPlainObject`, `canonicalizeForHash`, `normalizeInputSourceMap`, and the CSS constants shared by the Next.js plugin and the Turbopack loader (`WYW_CSS_MODULE_EXTENSION`, `WYW_CSS_OUTPUT_QUERY`). Adapters and transform now import them. The Babel preset option checks and the Next.js config merging now accept plain objects created in another realm (for example by a `vm` context), as transform already did.
- be05359: Treat side-effect imports such as `import './polyfill'` as runtime imports when deciding whether a dependency module is statically evaluatable. Such modules are no longer widened to all exports during evaluation.

  Fall back to the `hybrid` eval strategy in every stage when `eval.strategy` is left undefined, for example `eval: { strategy: undefined }`. Previously the static resolver treated it as `execute` while the other stages used `hybrid`, so imported values that could be resolved statically were evaluated instead.

  Pass static resolution options through object spreads, so `{ ...helper() }` with a helper from `staticBindings` resolves statically like other helper calls.

- 29296bc: Treat `undefined` as a known value when statically evaluating template interpolations. Values such as `{ accent: undefined }`, `[undefined]`, `flag ? undefined : value` and calls with an `undefined` or `void 0` argument no longer stop static evaluation, so interpolations like `${theme.accent ?? 'red'}` resolve without build-time evaluation. The handling of `process.env` reads is unchanged.
- Updated dependencies
  - @wyw-in-js/processor-utils@2.6.0
  - @wyw-in-js/shared@2.6.0

## 2.5.1

### Patch Changes

- ed2b607: Fix CSS source map line offsets for multi-line rules. The map generated by `@wyw-in-js/transform` placed every rule on its own line by index, which is wrong as soon as a rule spans several lines: a multi-line comment kept with `keepComments`, a backslash-newline string continuation, or `preprocessor: 'none'`. The generated line is now derived from the emitted CSS. In `@wyw-in-js/turbopack-loader`, wrapping selectors in `:global()` changes the line count (a split selector list duplicates its body, a multi-line selector collapses to one line), so the loader now remaps the generated lines of that map to the wrapped CSS. In query output mode the map is returned to Turbopack from the loader, which is the only way Turbopack picks up a CSS source map; it does not read `sourceMappingURL` comments.

  `@wyw-in-js/turbopack-loader` gains `source-map` as a runtime dependency for the rebuild. Sidecar output mode keeps the inline `sourceMappingURL` comment, which Turbopack ignores; only query mode reaches Turbopack. Turbopack itself drops loader source maps in production builds unless `productionBrowserSourceMaps` is enabled, so the map is visible in `next dev` and in builds with that flag.

## 2.5.0

### Minor Changes

- 2d589b5: Keep later static interpolations resolvable when opaque calls receive immutable primitive values or fresh containers built only from them. Specific calls and constructors can also be declared side-effect-free with a `/*#__PURE__*/` or `/*@__PURE__*/` annotation; static evaluation errors point to eligible call sites and show the exact placement.
- 50299a4: Add root-scoped pipeline counters to file reporter output without changing transform results.
- cf44565: Add evaluation broker, cache, preparation, and transport counters to file reporter output.
- 522df8b: Reuse the Turbopack eval child process across files without sharing resolver or transform-cache semantics between loader invocations. Switching resolver semantics now recreates the runner's VM context and clears its WyW-managed modules and broker caches while retaining the child process, so concurrent server/client transforms of the same file cannot resolve through each other's loader context or observe top-level globals created by the other's evaluated modules. Node built-ins, environment values, and external module instances remain process-scoped. Advanced integrations can opt into full cache, module, and VM-context reuse with a `resolverScopeKey` only when the complete transform and eval configuration, aliases, conditions, and compilation graph semantics match. Importer paths are also stripped of query and hash before deriving the resolve context.

### Patch Changes

- 59ab82d: Run actions and entrypoint lifecycle updates with the services of the transform run that created them, instead of the services captured when an entrypoint first entered a shared cache. This prevents reused entrypoints from applying an earlier importer's filename, source map, output path, warning handler, or event emitter to the current file. Nested actions inherit their parent's run services by default, while internal analysis actions can retain their intentionally isolated cache and telemetry scope.
- 08daf08: Keep answering resolve and load requests from a fire-and-forget dynamic import after its evaluation has finished. The eval broker scoped request liveness to the entrypoint that was active when the request arrived, so a `RESOLVE` sent right before `EVAL_RESULT` and delivered in the same stdout chunk was silently dropped once the eval completed. The runner then waited for that answer forever and the next load for the same semantic session never started, which surfaced as sporadic eval timeouts on busy machines. Liveness is now scoped by the semantic session (runner, session id, request epoch, services and cache generation); the next entrypoint still invalidates stale continuations through the request epoch.
- 1421841: Parsing is cheaper on large projects. Compatible parses on supported runtimes now receive Oxc ASTs via the raw-transfer buffer instead of JSON, parse results are shared across filenames with equivalent parser semantics and across compatible source types, and cache lookups no longer allocate whole-file key strings.
- 82ffa16: Reload invalidated evaluation modules even when their importing module's source is unchanged.
- d8e2903: Stop reporting a false `PrevalPayload disagreement` for `styled(X)` targets whose evaluated and static values describe the same selector chain. The hybrid evaluator spells a proven opaque component as a bare function stub, while the static resolver spells it as `null`; these representations are now treated as equivalent only for helpers that the static analysis identified as opaque and for matching generated `__wyw_meta` chains. Static precedence is unchanged, and malformed metadata, extra value fields, or genuine selector drift are still reported.
- 4aaea17: Prevent an unbounded supersede loop from growing a bundler process until it runs out of memory without weakening dependency invalidation. If an entrypoint replacement is evicted while it is still processing, retain the last complete dependency snapshot. When no complete graph exists, keep invalidating conservatively and restart transform and evaluation caches before rebuilding, so a warm evaluated module can never hide a changed transitive dependency.

  As a final fail-closed safeguard, stop more than 100 identical-source, non-widening supersedes within a true sliding 10 second window with a diagnostic error. Unchanged retries remain blocked instead of reusing stale output; the guard resets after a successful transform, a real source edit, or a quiet window, and cleans up inactive filename counters.

- Updated dependencies
  - @wyw-in-js/processor-utils@2.5.0
  - @wyw-in-js/shared@2.5.0

## 2.4.4

### Patch Changes

- 155d867: Treat opaque calls as capability-bounded during mutation analysis, keeping later static interpolations eligible when direct imported member arguments resolve to immutable primitives. Calls can still invalidate object-valued arguments; ambient writes through globals, closures, or the callee's own imports remain the application author's responsibility.

## 2.4.3

### Patch Changes

- 00eb7c3: Preserve resolved transform dependency paths so the Turbopack loader can register them without resolving package specifiers a second time.

## 2.4.2

### Patch Changes

- 73f5ed6: Bound OXC invocation analysis and conservatively retain statement-local effects when callable provenance exceeds its work budget.
- 1dbff79: Include extracted CSS rules in transform metadata.
- aefa541: Avoid expanding direct imported calls through the opaque imported-result callable cohort during OXC shaking.
- 2898739: Fix an `Unexpected module status 0` assertion thrown while evaluating a re-export barrel that the broker had to take over. When a barrel's native load fails part-way — for example because one of its re-exported siblings is an unsupported asset — Node's ESM registry is left holding an uninstantiated job for the children that were already resolved during linking. The runner then loaded those children with a synchronous `require()`, which trips Node's require-ESM bridge assertion, and that failed `require()` also poisons the entry for any later `import()`, so it cannot be retried. External modules reached through an `import` or `dynamic-import` edge are now loaded with `import()` instead, while JSON and native `.node` assets stay on `require()`. `eval.require` policy and its `require-fallback` diagnostic still apply to those loads, CommonJS externals keep exposing exports that are assigned dynamically (which `import()` alone cannot see), and Node builtin imports continue through the existing builtin path.
- 12cbf6d: Handle compact `:global()` values in animation declarations.
- 201aa13: Preserve CSS-producing module imports with execute evaluation.

## 2.4.1

### Patch Changes

- f1a3a2e: Preserve serializable fields of evaluated objects when unrelated nested fields cannot cross the eval IPC boundary, and prioritize processor metadata before treating objects as CSS data. Unsupported nested fields remain strict errors when accessed, while direct unsupported values are still rejected.
- aa5ec73: Fix a broker/runner cache desync error thrown for the first eval-time load of a module that legitimately shakes down to zero runtime bytes (e.g. a types-only module reached through a barrel's `export *`). The broker previously used an empty `code` string to mean both "here is real, empty content" and "nothing to ship, reuse your cache," so genuinely empty modules were misread as the latter and rejected by the runner on first load. `code` is now omitted from the LoadResult when nothing should be shipped, and only that omission is treated as a signal to reuse a cached variant.
- 349e39b: Include named and wildcard re-export edges (`export { x } from './y'`, `export * from './y'`) in the eval import map, and compute that map for ignored (verbatim-shipped) modules too instead of always returning `null`. The compiled code for a re-exporting barrel keeps these statements verbatim — a wildcard target can't be selectively pruned without knowing its exports — but the import map built from it previously only tracked `import` declarations. Downstream `only`-merging could silently reuse a narrower cached variant of the re-exported target than the barrel actually needs, dropping exports a consumer reaches only through the barrel. Eval preparation and the shaker now share the same import-map conversion so those dependency views cannot diverge again.
- 3c260a5: Stop repeatedly invalidating cached transforms after an unchanged dependency entrypoint is evicted. Retain a lightweight dependency graph snapshot so transitive file changes are still detected without keeping the full entrypoint alive.
- e525ac6: Preserve static values when processor expressions are nested inside opaque wrappers. Mutation analysis now projects their eval-time replacements through surrounding containers while retaining hazards from other wrapper inputs and processor interpolations.
- Updated dependencies
  - @wyw-in-js/processor-utils@2.4.1

## 2.4.0

### Minor Changes

- 8eb2759: Resolve statically imported values through complete object and array destructuring patterns.

### Patch Changes

- a41083a: Keep interpolation values evaluator-owned when `eval.strategy` is set to `execute`.
- 30a7b3b: Preserve static values and processor replacements when runtime-only component code is removed during evaluation. Separate evaltime and runtime processor paths so removed code cannot poison static analysis, and reuse their shared analysis across both phases.
- Updated dependencies
  - @wyw-in-js/processor-utils@2.4.0
  - @wyw-in-js/shared@2.4.0

## 2.3.1

### Patch Changes

- b222196: Preserve valid Vite React Fast Refresh modules when processor replacements add build-time imports.

## 2.3.0

### Minor Changes

- 8d69b74: Processor manifests can now declare `preeval-call` semantics: the manifest
  points at the package's own preeval module and export, and when every call
  input is statically known the transform invokes that function with the
  resolved arguments — the processor's static value becomes the exact value
  the eval path would have produced.

      "semantics": {
        "kind": "preeval-call",
        "module": "./preeval-runtime.js",
        "export": "preevalCss"
      }

  This keeps processors with dual-domain values (a runtime class string vs a
  structured eval-time descriptor) on a single source of truth instead of
  re-encoding their value logic in the engine's declarative vocabulary. The
  module resolves relative to the manifest, results must be plain
  serializable data, and any load failure, thrown error, or non-serializable
  result falls back to the eval path with full diagnostics. Older engines
  treat the unknown kind as no semantics and stay on the JS implementation
  path.

### Patch Changes

- Updated dependencies
  - @wyw-in-js/processor-utils@2.3.0
  - @wyw-in-js/shared@2.3.0

## 2.2.0

### Minor Changes

- 7cded5b: Static-first processor pipeline: processor parameters that are statically
  analyzable are now computed by the transform and passed to processors
  directly, without executing modules at build time.

  - The transform builds a per-file static plan before processor scheduling.
    Literals, constant objects, enum-like exports, re-export chains, and
    processor-produced values that can be proven statically are resolved ahead
    of time; everything else falls back to the eval path with unchanged output.
  - Processor packages can point a `wyw-in-js.tags` entry at a JSON manifest
    (`{ "version": 1, "name": "...", "implementation": "./processor.js",
"semantics": { ... } }`). Declarative semantics (`css-template`,
    `styled-target`, `style-object-call`, `css-var-call`,
    `token-contract-call`, `class-name-call`) let the pipeline compute a
    processor's static value — including for imports of that value in other
    files — while the JS processor implementation stays the authoritative
    source of artifacts, diagnostics, and runtime replacement.
  - Modules whose processor inputs are fully static are no longer executed
    during evaluation, so their module-level side effects no longer run at
    build time.
  - Evaluation results now travel as a single structured `PrevalPayload`. If
    you implement custom workflow handlers: the internal `eval` action now
    yields `PrevalPayload | null` (previously `[ValueCache, string[]] | null`)
    and `collect` receives `{ prevalPayload }` (previously `{ valueCache }`).

  Emitted CSS — class-name hashes, selector text, rule content — and
  diagnostics are unchanged. Rule declaration order is not guaranteed and may
  shift in rare cases.

### Patch Changes

- Updated dependencies
  - @wyw-in-js/processor-utils@2.2.0
  - @wyw-in-js/shared@2.2.0

## 2.1.6

### Patch Changes

- 3932f6c: Preserve aliased export bindings during preevaluation when their source depends on browser-only globals.

## 2.1.5

### Patch Changes

- ff60699: Fix memory retention in webpack watch mode by clearing completed transform action graphs and avoiding cached loader context references.

## 2.1.4

### Patch Changes

- 32be9b7: Preserve module-level bindings that are referenced before their declaration when runtime cleanup removes CSS-only dependencies.

## 2.1.3

### Patch Changes

- 4c30180: Fix build-time evaluation for styled runtime wrappers that attach symbol-keyed metadata.

## 2.1.2

### Patch Changes

- 987207c: Fix eval runner crashes when external ESM packages import CSS or other assets from node_modules.

## 2.1.1

### Patch Changes

- d4f6d2b: Improve `eval.strategy: "static"` failure diagnostics. Errors now lead with the source expression the developer wrote (e.g. `themeVars.panelBg`) instead of bare `_exp` codegen placeholders, surface the specific per-value reason the resolver determined (unanalyzable import, non-serializable value, missing/undefined export, or runtime function call), and group values by shared cause with `(×N)` dedupe so a real build no longer prints hundreds of near-identical low-signal lines.

## 2.1.0

### Minor Changes

- cfe67d4: Add a typed `processors` option channel for processor package options.

### Patch Changes

- 644183d: Fix Oxc parsing for `.js` files that contain JSX before downstream JSX transforms run.
- 3f05651: Relax OXC dependency ranges to accept compatible versions newer than the tested minimum.
- ca2d7e6: Allow bundler adapters to provide loaded dependency source during evaluation.

  The Rollup adapter now loads resolved dependencies through Rollup before WyW falls back to reading source from disk. This keeps evaluation aligned with earlier Rollup plugins, including TypeScript transforms, when imported values are needed for CSS extraction.

- Updated dependencies
  - @wyw-in-js/processor-utils@2.1.0
  - @wyw-in-js/shared@2.1.0

## 2.0.2

### Patch Changes

- 246006b: Fix static evaluation of object member interpolations when sibling object properties contain same-file processor templates.

## 2.0.1

### Patch Changes

- f186b4c: Avoid extracting duplicate CSS rules for same-file processor bindings that are referenced from another processor template inside a local scope.

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

- 2524aa4: Add a supported processor diagnostics API that lets library-owned processors emit structured non-fatal warnings through WyW.

  This adds:

  - `BaseProcessor.addDiagnostic()` and typed diagnostics helpers in `@wyw-in-js/processor-utils`
  - normalized `diagnostics` output from `@wyw-in-js/transform`
  - diagnostics reporting in `@wyw-in-js/vite` and `@wyw-in-js/cli`

  Existing hard failures and metadata sidecar behavior stay intact.

- 2524aa4: Enable static-first value resolution by default with `eval.strategy: "hybrid"`.

  WyW can now resolve many imported literals, fixed objects, compiled TypeScript enum objects, zero-argument helper returns, compound component aliases, processor metadata values, and static metadata helper chains without starting the evaluator or loading the full module graph.

  The default `hybrid` mode keeps evaluator fallback for values that are not statically provable. Use `eval.strategy: "execute"` for evaluator-only compatibility and `eval.strategy: "static"` to reject fallback.

  Add `staticBindings` config for declaring additional statically-known imported values and pure helper functions.

- 2524aa4: Add an optional processor static evaluation contract. Processors can now describe statically known values as serializable values, class names, selector chains, runtime callbacks, opaque components, or unresolved values with reasons.

  The transform static evaluator now consumes this contract before falling back to legacy eval-time replacement metadata, so processors can provide their own static semantics without relying on transform-specific metadata shapes.

- 2524aa4: Add opt-in metadata manifest output across `@wyw-in-js/shared`, `@wyw-in-js/transform`, `@wyw-in-js/vite`, and `@wyw-in-js/cli`.

  When `outputMetadata` is enabled:

  - `@wyw-in-js/transform` now returns normalized, public metadata alongside the existing transform result.
  - `@wyw-in-js/vite` emits `.wyw-in-js.json` sidecar assets during build.
  - `@wyw-in-js/cli` writes matching `.wyw-in-js.json` sidecar files and supports an `--output-metadata` flag.

  This keeps default JS/CSS output unchanged while exposing stable metadata artifacts for CLI, Vite, and transform consumers.

### Patch Changes

- 2524aa4: Add optional JSONL debug output for evaluator payloads and transform perf spans.

  `eval-files.jsonl` records shipped evaluator code and serialized or stringified value details. `perf-spans.jsonl` records transform perf spans so evaluator and transform costs can be analyzed alongside action, dependency, and entrypoint logs.

- 2524aa4: Improve evaluator diagnostics and recovery for transient missing imports.

  Missing imports during evaluation now report the importing file, requested specifier, resolved path, and original error cause. The evaluator also evicts modules left in failed VM states and refreshes broker-side load tracking, so a subsequent evaluation can recover after the missing file is created instead of rethrowing stale module status errors.

- 2524aa4: Stabilize the v2 Oxc-backed transform and evaluator path for v1-compatible output.

  This covers import/order preservation, export shaking, CommonJS and live-binding emit, runtime source map composition, processor-added imports, hoisted template dependencies, React wrapper handling, Node 22 parse compatibility, dependency graph cache invalidation, and hot-path parse/cache performance.

- Updated dependencies
  - @wyw-in-js/processor-utils@2.0.0
  - @wyw-in-js/shared@2.0.0

## 2.0.0-alpha.2

### Patch Changes

- ccaf03e: Improve transform performance by caching OXC visitor keys, reusing cleanup parses, bypassing disabled emitter instrumentation, and updating OXC packages.

## 2.0.0-alpha.1

### Minor Changes

- 4fce392: Rename the eval resolver mode from `node` to `native` and resolve native eval imports with `oxc-resolver`. Hybrid eval resolution now tries the custom resolver, then native resolution, then the bundler resolver.

  Native eval resolution now discovers `tsconfig.json` by default. Vite, esbuild, webpack, and Next Turbopack integrations forward static string aliases from their bundler config into native resolver options, while preserving explicitly configured `oxcOptions.resolver.alias` entries.

- 0b44ada: Add an optional processor static evaluation contract. Processors can now describe statically known values as serializable values, class names, selector chains, runtime callbacks, opaque components, or unresolved values with reasons.

  The transform static evaluator now consumes this contract before falling back to legacy eval-time replacement metadata, so processors can provide their own static semantics without relying on transform-specific metadata shapes.

### Patch Changes

- 32cdb0b: Add optional eval payload debug JSONL output, including shipped code and serialized or stringified value details for log analysis.
- dc4e7f0: Improve evaluation diagnostics and recovery for transient missing imports.

  Missing imports during evaluation now report the importing file, requested specifier, resolved path, and original error cause. The evaluator also evicts modules left in failed VM states and refreshes broker-side load tracking, so a subsequent evaluation can recover after the missing file is created instead of rethrowing stale module status errors.

- df797cd: Lower explicit resource management syntax in ESM build output so the v2 package
  can be parsed on Node 22. The previous v2 alpha build left raw
  `using abortSignal` declarations in `@wyw-in-js/transform` ESM artifacts.
- a227252: Add `perf-spans.jsonl` to debug output so transform perf spans can be analyzed alongside action, dependency, and entrypoint logs.
- cb47dc2: Treat React `forwardRef` and `memo` as default code-remover HOCs, and inline same-file null component bases during Oxc static import value resolution.
- Updated dependencies
  - @wyw-in-js/processor-utils@2.0.0-alpha.1
  - @wyw-in-js/shared@2.0.0-alpha.1

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

- 69004e7: Add a supported processor diagnostics seam that lets library-owned processors emit structured non-fatal warnings through WyW.

  This adds:

  - `BaseProcessor.addDiagnostic()` and typed diagnostics helpers in `@wyw-in-js/processor-utils`
  - normalized `diagnostics` output from `@wyw-in-js/transform`
  - diagnostics reporting in `@wyw-in-js/vite` and `@wyw-in-js/cli`

  Existing hard failures and metadata sidecar behavior stay intact.

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
- Updated dependencies
  - @wyw-in-js/processor-utils@2.0.0-alpha.0
  - @wyw-in-js/shared@2.0.0-alpha.0

## 1.0.8

### Patch Changes

- b416a98: Avoid unnecessary reexport expansion for `__wywPreval`-only entrypoints and isolate cached action trees per resolver context to prevent concurrent transform crashes.
- 33e4abf: Revalidate evaluated dependencies against disk during entrypoint freshness checks, and rethrow non-missing filesystem errors instead of treating them as cache invalidations.
- 21ecabf: Handle deleted or renamed dependency files during cache invalidation without swallowing unrelated filesystem errors.
- ba60b51: Add Vite 8 support without dropping Vite 5-7 compatibility, and fix destructured binding evaluation in `@wyw-in-js/transform` on newer Babel versions.

## 1.0.7

### Patch Changes

- 8158b6b: Coalesce `only` updates while a transform is already in flight so expanding export requests does not repeatedly restart the same entrypoint work.
- 6b1a996: Distinguish fully rewritten barrel sources from partial fallbacks during barrel import rewriting and annotate dependency reporting with rewrite phases so post-rewrite graphs are easier to interpret.
- 6a44e71: Extend barrel import rewriting to optimize passthrough exports in mixed modules while preserving fallback imports for local exports that still need the original barrel.
- 2a7b534: Keep invalidation-only dependencies for rewritten barrel imports out of normal dependency merging so optimized imports no longer need `noShake` as much to avoid repeated dependency churn.
- 7a2ec2e: Optimize pure re-export barrel files by caching barrel manifests and rewriting imports to leaf modules before CommonJS emission. This avoids repeated `only` supersede churn on large barrel files while preserving existing runtime behavior for non-optimized paths.
- c0497c3: Fix the transform shaker so exports pruned from output can still remain as local declarations when surviving code depends on them, including chained references, enums, and mixed variable export declarations.
- 26e85ef: Fix transform cache invalidation so entrypoints are evicted when direct or transitive dependencies change, preventing stale eval results from being reused across rebuilds.
- 225d70d: Add support for custom `conditionNames` during eval-time fallback resolution so transform can honor package export conditions in monorepo development setups, while keeping extension retry limited to extensionless subpath requests.
- 6daea8c: Invalidate cached barrel analysis when leaf export sets change, so warm rebuilds do not reuse stale rewritten `export *` output.
- 4fbbd20: Reuse already resolved leaf dependencies after barrel import rewriting so mixed-barrel optimization avoids re-resolving generated direct imports during the rewritten resolve pass.
- e9999e8: Avoid retrying extension guesses for scoped package roots when `conditionNames` is enabled.
- Updated dependencies
  - @wyw-in-js/processor-utils@1.0.5
  - @wyw-in-js/shared@1.0.5

## 1.0.6

### Patch Changes

- 038bf35: Strip Vite React Refresh helpers (`$RefreshReg$`/`$RefreshSig$`) when they are injected as local functions by `@vitejs/plugin-react@5.1.x`, preventing unintended code execution during eval.
- 9142eac: Fix processor skip handling to accept `Symbol('skip')` by description (instead of object identity), and warn once when the symbol identity mismatches `BaseProcessor.SKIP` to help diagnose duplicated dependencies.

## 1.0.5

### Patch Changes

- 3dec017: Fix cache invalidation storms when loader-provided code differs from filesystem code, keep the Vite resolver stable across repeated `configResolved` calls, and avoid eagerly walking dynamic import targets during eval-only runs (prevents `action handler is already set` and improves build performance on large projects).
- a936749: Drop Node.js <20 support (Node 18 is EOL).

  Note: WyW `1.0.0` already effectively required Node 20 in practice; this change makes the support policy explicit and
  aligns docs/CI accordingly.

  If DOM emulation is enabled (`features.happyDOM`), but `happy-dom` cannot be loaded via `require()` (ESM-only), WyW will
  fall back to running without DOM and print a one-time warning with guidance.

- 37d15aa: Fix Babel plugin/preset merging when keys are absolute paths from pnpm store (`node_modules/.pnpm/...`) so different packages don't get treated as duplicates.
- 9e08238: Fix cache invalidation when a file is first read from the filesystem and later provided by a bundler/loader, preventing stale transforms and related Vite build/dev issues.
- 3dec017: Add opt-in warnings to help identify dynamic and slow imports processed during prepare stage, with an `importOverrides.mock` hint for faster evaluation. Also support minimatch patterns in `importOverrides` keys to override groups of imports.
- Updated dependencies
  - @wyw-in-js/processor-utils@1.0.4
  - @wyw-in-js/shared@1.0.4

## 1.0.4

### Patch Changes

- Updated dependencies
  - @wyw-in-js/processor-utils@1.0.3
  - @wyw-in-js/shared@1.0.3

## 1.0.3

### Patch Changes

- a7ece53: Improve eval error diagnostics: when build-time evaluation fails due to browser-only globals (e.g. `window`), include a hint about using `importOverrides` / moving runtime-only code out of evaluated modules.
- d45b9bd: When expanding `export * from` to named re-exports, never include `default` (ESM export-star semantics). This avoids invalid code like duplicate default exports.
- f45e458: Fix shaker crash when removing anonymous default exports like `export default function() {}`.

## 1.0.2

### Patch Changes

- Bump versions
- Updated dependencies
  - @wyw-in-js/processor-utils@1.0.2
  - @wyw-in-js/shared@1.0.2

## 1.0.1

### Patch Changes

- 5882514: Fix publishing so released packages don't contain `workspace:*` dependency ranges (npm install compatibility).
- Updated dependencies
  - @wyw-in-js/processor-utils@1.0.1
  - @wyw-in-js/shared@1.0.1

## 1.0.0

### Major Changes

- 94c5efa: Release **1.0.0** introduces no breaking changes compared to previous releases.

  This release establishes a stable baseline for future development, including upcoming releases focused on performance
  and build-time optimizations.

### Minor Changes

- 62fef83: Fix shaker keeping unused imports in eval bundles (named/namespace/side-effect imports), which could trigger build-time evaluation crashes (e.g. `@radix-ui/react-tooltip`).

  `@wyw-in-js/shared` now passes `importOverrides`/`root` through the evaluator config so the shaker can keep or mock side-effect imports when configured.

  Note: eval bundles for `__wywPreval` now drop `import '...';` side-effect imports by default, to avoid executing unrelated runtime code in Node.js during build. If you rely on a side-effect import at eval time, keep it or stub it via `importOverrides`:

  - `{ noShake: true }` to keep the import (and disable tree-shaking for that dependency).
  - `{ mock: './path/to/mock' }` to redirect the import to a mock module.

### Patch Changes

- 7144b0c: Fix Babel TypeScript transform crashing on `declare` class fields by ensuring `allowDeclareFields` is enabled when using the TypeScript preset/plugin.
- 0477b30: Fix export detection for array destructuring declarations (e.g. `export const [B] = ...`).
- fad6207: Fix config merging with `@babel/core@7.25.7` by avoiding `babel-merge`'s `resolvePreset` regression.
- c26b337: Bump `happy-dom` dependency to `^20.1.0`.
- 485fd7d: Preserve cached exports when evaluating only missing imports to avoid re-running unused code.
- 83d8915: Normalize multi-keyword `display` values (e.g. `flex inline`) before Stylis prefixing to avoid malformed CSS output.
- 265a8d7: Fix `evaluate: true` export caching so additional export requests don’t combine exports from different module executions.
- 9715eee: Fix `export * from` being dropped when the reexport target is ignored (e.g. via `extensions`).
- 45ef60a: Fix missing CSS emission for tags inside named function expressions (e.g. `export const a = function a() { return css\`\`; }`).
- 908968b: Avoid emitting `/*#__PURE__*/` on non-call/new expressions to prevent Rollup warnings during builds.
- d2f5472: Fix shaker removing referenced bindings when dropping unused exports (e.g. object shorthand `{ fallback }`).
- 06e80fb: Fix stale imported object exports during incremental rebuilds when `features.globalCache` is enabled.
- c024a34: Avoid repeated evaluator re-runs for large, statically evaluatable modules by promoting them to wildcard `only` on first entrypoint creation.
- fcb118a: Add a `keepComments` option for the stylis preprocessor to preserve selected CSS comments.
- 64b7698: Prevent concurrent transforms from reusing cached actions with different handler instances by stabilizing resolvers across bundlers.
- d4cefc9: Avoid leaving empty Promise callbacks when dangerous globals are removed.
- 485fd7d: fix: drop unused imports when named and default exports share a binding
- ac44dcc: Avoid retaining unused import specifiers during shaking so eval doesn't load unrelated deps.
- 782e67f: Drop property assignments on shaken exports so eval doesn't touch Storybook globals.
- 870b07b: Handle unknown/dynamic import specifiers without transform-time crashes, add `importOverrides` (mock/noShake/unknown policy), and emit a deduped warning only when eval reaches Node resolver fallback (bundler-native where possible).
- 26ec4a3: Fix handling of import resource queries (e.g. `?raw`, `?url`) to avoid crashes and allow minimal eval-time loaders.
- 2a8ab79: Extend `tagResolver` with a third `meta` argument (`sourceFile`, `resolvedSource`) so custom tag processors can be resolved reliably.
- 4c268ad: Support Vite's `import.meta.env.*` during build-time evaluation.
- Updated dependencies
  - @wyw-in-js/processor-utils@1.0.0
  - @wyw-in-js/shared@1.0.0

## 0.8.1

### Patch Changes

- 691f946: Handle Vite virtual modules like `/@react-refresh` without filesystem lookups to prevent ENOENT in dev.
- b33ed9c: fix(transform): guard cache entries missing initialCode (#144)
- fcfdf52: Avoid infinite recursion when encountering import cycles while invalidating the cache.
- Updated dependencies [7321fd3]
- Updated dependencies [fcfdf52]
  - @wyw-in-js/processor-utils@0.8.1
  - @wyw-in-js/shared@0.8.1

## 0.8.0

### Minor Changes

- 4212218: chore: bump happy-dom to 20.0.10

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@0.8.0
  - @wyw-in-js/processor-utils@0.8.0

## 0.7.0

### Minor Changes

- 168341b: New option `prefixer` that allows disabling the built-in CSS-prefixed.
- 58da575: Ensure cache invalidates correctly when dependency content changes.

### Patch Changes

- Updated dependencies
- Updated dependencies [58da575]
  - @wyw-in-js/processor-utils@0.7.0
  - @wyw-in-js/shared@0.7.0

## 0.6.0

### Minor Changes

- 4c0071d: Configurable code remover can detect and remove from evaluation HOCs and components with specific explicit types.

### Patch Changes

- fc07b6b: The check for unsupported dynamic imports has been moved to the evaluation stage. We don't want to fail if this import is unreachable during evaluation. Fixes #126.
- Updated dependencies [4c0071d]
  - @wyw-in-js/shared@0.6.0
  - @wyw-in-js/processor-utils@0.6.0

## 0.5.5

### Patch Changes

- 830d6df: chore: bump happy-dom to 13.10.1
- fcfc357: chore: bump happy-dom to 14.12.3
- 81bcb65: chore: bump happy-dom to 15.11.0
- Updated dependencies [6bd612a]
  - @wyw-in-js/shared@0.5.5
  - @wyw-in-js/processor-utils@0.5.5

## 0.5.4

### Patch Changes

- 3cadae5: Support for @media selectors inside :global selectors.
- Updated dependencies
  - @wyw-in-js/shared@0.5.4
  - @wyw-in-js/processor-utils@0.5.4

## 0.5.3

### Patch Changes

- 21f175c: Pass `extensions` option to processors
- Updated dependencies [21f175c]
- Updated dependencies
  - @wyw-in-js/processor-utils@0.5.3
  - @wyw-in-js/shared@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies
- Updated dependencies [9096ba1]
  - @wyw-in-js/shared@0.5.2
  - @wyw-in-js/processor-utils@0.5.2

## 0.5.1

### Patch Changes

- cd7b7f0: Allow conditional usage of WeakRef in Module evalutation through a new feature flag `useWeakRefInEval`
- Updated dependencies
  - @wyw-in-js/shared@0.5.1
  - @wyw-in-js/processor-utils@0.5.1

## 0.5.0

### Minor Changes

- Bump versions

### Patch Changes

- 9d7cb05: Fix an issue when some animation names are not suffixed.
- Updated dependencies [aa1ca75]
  - @wyw-in-js/processor-utils@0.5.0
  - @wyw-in-js/shared@0.5.0

## 0.4.1

### Patch Changes

- 399d5b4: Optimised processing. Up to 2 times faster detection of template literals.
- 3a494ef: Found out that an object spread can be extremely slow. getTagProcessor now works 10 times faster.
- Updated dependencies
  - @wyw-in-js/shared@0.4.1
  - @wyw-in-js/processor-utils@0.4.1

## 0.4.0

### Minor Changes

- 8eca477: Keyframes are now scoped by default. This behaviour can be changed by `:global()`: `@keyframes :global(bar) {…}`, `animation-name: :global(bar);`.

### Patch Changes

- edf8c81: Fix support of :global() selector in nested rules (fixes #42)
- Updated dependencies [c1a83e4]
- Updated dependencies
- Updated dependencies [0af626b]
  - @wyw-in-js/shared@0.4.0
  - @wyw-in-js/processor-utils@0.4.0

## 0.3.0

### Minor Changes

- e2c567a: Export findIdentifiers in main index file

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@0.3.0
  - @wyw-in-js/processor-utils@0.3.0

## 0.2.3

### Patch Changes

- ec051b7: feat: add stylis plugin to handle ":global()"
- 769653f: Sometimes, usages of variables survive the shaker even when their bindings are removed. Fixed.
- Updated dependencies
  - @wyw-in-js/shared@0.2.3
  - @wyw-in-js/processor-utils@0.2.3

## 0.2.2

### Patch Changes

- e1701d5: Fix the regression from callstack/linaria#1373 that messed up with namespaces in CSS.
- 740e336: Fix regression from #19 that kills some exports.
- a8e5da0: Improved shaker strategy for exports fixes some of `undefined` errors.
- Updated dependencies
  - @wyw-in-js/shared@0.2.2
  - @wyw-in-js/processor-utils@0.2.2

## 0.2.1

### Patch Changes

- Bump versions
- Updated dependencies
  - @wyw-in-js/shared@0.2.1
  - @wyw-in-js/processor-utils@0.2.1

## 0.2.0

### Minor Changes

- ca5c2e7: All Linaria-related things were renamed.

### Patch Changes

- 4b869aa: Fixtures generator and enhanced support of different transpilers.
- Updated dependencies [ca5c2e7]
  - @wyw-in-js/processor-utils@0.2.0
  - @wyw-in-js/shared@0.2.0

## 0.1.1

### Patch Changes

- 6f8ae08: Plugin for Rollup.
- Updated dependencies
  - @wyw-in-js/shared@0.1.1
  - @wyw-in-js/processor-utils@0.1.1

## 0.1.0

### Minor Changes

- 02973e1: `@linaria/webpack5-loader` has been moved and renamed into `@wyw-in-js/webpack-loader`. Support for Webpack 4 has been dropped.
- e02d5d2: `@linaria/babel-preset` and `@linaria/shaker` have been merged into `@wyw-in-js/transform`.

### Patch Changes

- Updated dependencies [e02d5d2]
  - @wyw-in-js/processor-utils@0.1.0
  - @wyw-in-js/shared@0.1.0
