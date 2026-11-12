---
'@wyw-in-js/bun': patch
'@wyw-in-js/esbuild': patch
'@wyw-in-js/parcel-transformer': patch
'@wyw-in-js/rollup': patch
'@wyw-in-js/turbopack-loader': patch
---

Report processor diagnostics in the Rollup, esbuild, Bun, Parcel and Turbopack integrations. They were dropped before; now each one is printed as a warning through the bundler's warning channel (`this.warn` in Rollup, the Parcel logger, the loader's `emitWarning` in Turbopack, the console in esbuild and Bun), in the same format as the CLI, with the file, line and column. A diagnostic of any severity is a warning and does not fail the build.
