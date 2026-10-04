# @wyw-in-js/esbuild

The package contains WyW-in-JS plugin for [esbuild](https://esbuild.github.io/).

## Installation

```shell
# npm
npm i -D @wyw-in-js/esbuild
# yarn
yarn add --dev @wyw-in-js/esbuild
# pnpm
pnpm add -D @wyw-in-js/esbuild
# bun
bun add -d @wyw-in-js/esbuild
```

## Usage

```js
import wyw from '@wyw-in-js/esbuild';
import esbuild from 'esbuild';

const isProduction = process.env.NODE_ENV === 'production';

esbuild
  .build({
    entryPoints: ['src/index.ts'],
    outdir: 'dist',
    bundle: true,
    minify: isProduction,
    plugins: [wyw({ sourceMap: isProduction })],
  })
  .catch(() => process.exit(1));
```

## Eval resolver modes

`eval.resolver: 'native'` and the native step of `eval.resolver: 'hybrid'` use `oxc-resolver` with automatic
`tsconfig.json` discovery. The plugin also forwards esbuild's top-level `alias` option.

Use `hybrid` when evaluated imports may rely on esbuild `onResolve` plugins. Use `native` only when `oxc-resolver` can
resolve all evaluated imports, or mirror plugin-only aliases in `oxcOptions.resolver.alias`.

## Additional Oxc transformations

`@wyw-in-js/esbuild` runs WyW evaluation after an `esbuild.transform()` step, so transform options that must run on the
original TS/JSX source should be configured explicitly.

Enable `oxcTransform` to apply `oxcOptions.transform` to the original source code before the esbuild/WyW pipeline:

```js
wyw({
  oxcTransform: true,
  oxcOptions: {
    transform: {
      define: {
        __DEV__: 'false',
      },
    },
  },
});
```

Order: `Oxc(source) → esbuild.transform() → WyW transform`.

This is an opt-in feature and may increase build times, so it's recommended to keep `filter` narrow.

## Running transforms in worker threads

Set `parallel: true` to run transforms in up to four worker threads, or pass a number to choose the count:

```js
wyw({
  parallel: true,
});
```

Options are sent to the workers as data, so function options (for example `tagResolver`) must be defined in a wyw-in-js
config file. Otherwise, or when `debug` is set, the plugin warns and runs transforms on the main thread.

## Disabling vendor prefixing

Stylis adds vendor-prefixed CSS by default. To disable it (and reduce CSS size), pass `prefixer: false`:

```js
wyw({
  prefixer: false,
});
```

## Transforming libraries in `node_modules`

By default, the esbuild plugin skips transforming files from `node_modules` for performance.

To transform a specific library, enable `transformLibraries` and narrow `filter`:

```js
wyw({
  transformLibraries: true,
  filter: /node_modules\\/(?:@fluentui)\\//,
});
```

To get details about supported options by the plugin, please check [documentation](https://wyw-in-js.dev/bundlers/esbuild).
