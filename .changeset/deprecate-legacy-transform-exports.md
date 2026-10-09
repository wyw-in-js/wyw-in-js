---
'@wyw-in-js/transform': minor
---

Deprecate public exports of `@wyw-in-js/transform` that the transform pipeline no longer needs. They keep working in 2.x and will be removed in 3.0.

- `Module` and `DefaultModuleImplementation`: the legacy in-process evaluator. `transform()` evaluates modules in a separate runner process and never constructs `Module`. Constructing `Module` now emits a one-time `DeprecationWarning` with the code `WYW_MODULE_DEPRECATED`. `UnprocessedEntrypointError` and `isUnprocessedEntrypointError` are thrown only by this evaluator and are deprecated with it.
- The `customHandlers` argument of `transform()`, together with `baseHandlers`, `asyncResolveImports` and `syncResolveImports`. They replace internal stages of the action runner, which is not a stable API. To observe stages, pass an `eventEmitter`.
- Internal helpers and types: `Entrypoint`, `EvaluatedEntrypoint`, `IEvaluatedEntrypoint`, `ParentEntrypoint`, `ITransformFileResult`, `parseFile`, `LoadAndParseFn`, `prepareCode`, `withDefaultServices`, `Services`, `isNode`, `getVisitorKeys`, `VisitorKeys` and `peek`. To type the first argument of `transform()`, use `Parameters<typeof transform>[0]` instead of `Services`.

Nothing is removed, and runtime behavior is unchanged apart from the new warning.
