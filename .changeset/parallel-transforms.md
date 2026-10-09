---
'@wyw-in-js/transform': minor
'@wyw-in-js/vite': minor
'@wyw-in-js/esbuild': minor
'@wyw-in-js/webpack-loader': minor
'@wyw-in-js/bun': minor
'@wyw-in-js/cli': minor
---

Add opt-in worker threads for transforms. The Vite, esbuild and Bun plugins and the webpack loader accept `parallel: true` (up to four workers) or a worker count, and the CLI accepts `--workers <count>`. Each worker keeps its own cache, a file always returns to the worker that transformed it first, and module resolution still goes through the bundler on the main thread. Options are sent to the workers as data, so function options must be defined in a wyw-in-js config file; with function options or debug reporting, transforms stay on the main thread and a warning explains why. Workers split the parsed-AST cache budget of one process between them and start with a 1.5 GB heap limit, which is raised when a worker runs out of memory. `@wyw-in-js/transform` exports the underlying `TransformWorkerPool` and the `createParallelTransforms` helper for other integrations.
