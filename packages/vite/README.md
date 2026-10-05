# @wyw-in-js/vite

The package contains WyW-in-JS plugin for [Vite](https://vitejs.dev/).

## Installation

```shell
# npm
npm i -D @wyw-in-js/vite
# yarn
yarn add --dev @wyw-in-js/vite
# pnpm
pnpm add -D @wyw-in-js/vite
# bun
bun add -d @wyw-in-js/vite
```

## Usage

After installation, add the plugin to your `vite.config.js`:

```js
import { defineConfig } from 'vite';
import wyw from '@wyw-in-js/vite';

export default defineConfig({
  // ...
  plugins: [wyw()],
});
```

## Eval resolver modes

`eval.resolver: 'native'` and the native step of `eval.resolver: 'hybrid'` use `oxc-resolver` with automatic
`tsconfig.json` discovery. The Vite plugin also forwards simple string aliases from `resolve.alias`.

Use `hybrid` when evaluated imports may rely on Vite virtual modules, resolver plugins, or non-string aliases. Use `native`
only when `oxc-resolver` can resolve all evaluated imports, or mirror Vite-only aliases in `oxcOptions.resolver.alias`.

## Transforming libraries in `node_modules`

By default, the Vite plugin skips transforming files from `node_modules` for performance.

To transform a specific library, enable `transformLibraries` and narrow `include`/`exclude`:

```js
wyw({
  transformLibraries: true,
  include: [/node_modules\\/(?:@fluentui)\\//],
});
```

## Running transforms in worker threads

Set `parallel: true` to run transforms in up to four worker threads, or pass a number to choose the count:

```js
wyw({
  parallel: true,
});
```

Options are sent to the workers as data, so function options (for example `tagResolver`) must be defined in a wyw-in-js
config file. Otherwise, or when `debug` is set, the plugin warns and runs transforms on the main thread.

Each worker starts with a 1.5 GB heap limit and is restarted with a larger one if it runs out of memory; an explicit
`--max-old-space-size` applies to every worker instead.

## Disabling vendor prefixing

Stylis adds vendor-prefixed CSS by default. To disable it (and reduce CSS size), pass `prefixer: false`:

```js
wyw({
  prefixer: false,
});
```

## Preserving generated CSS paths

When `build.rollupOptions.output.preserveModules` is enabled, older Rollup versions (used by Vite 3/4) flatten asset names
and drop directories for WyW-generated `*.wyw-in-js.css` files.

To preserve the original directory layout for WyW CSS assets, enable `preserveCssPaths`:

```js
import { defineConfig } from 'vite';
import wyw from '@wyw-in-js/vite';

export default defineConfig({
  plugins: [wyw({ preserveCssPaths: true })],
  build: {
    rollupOptions: {
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
    },
  },
});
```

## `import.meta.env` during evaluation

WyW-in-JS evaluates part of your code at build time to extract styles. The Vite plugin injects Vite's `import.meta.env` values
into the evaluation context so `import.meta.env.*` works as expected.

To get details about supported options by the plugin, please check [documentation](https://wyw-in-js.dev/bundlers/vite).
