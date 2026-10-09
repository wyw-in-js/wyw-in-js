# @wyw-in-js/bun

The package contains WyW-in-JS plugin for [Bun](https://bun.sh/) bundler.

## Installation

```shell
# npm
npm i -D @wyw-in-js/bun
# yarn
yarn add --dev @wyw-in-js/bun
# pnpm
pnpm add -D @wyw-in-js/bun
# bun
bun add -d @wyw-in-js/bun
```

## Usage

```js
import wyw from '@wyw-in-js/bun';

await Bun.build({
  entrypoints: ['src/index.ts'],
  outdir: 'dist',
  plugins: [wyw()],
});
```

## Eval resolver modes

`eval.resolver: 'native'` and the native step of `eval.resolver: 'hybrid'` use `oxc-resolver` with automatic
`tsconfig.json` discovery.

The Bun plugin does not receive a static bundler alias map. Use `hybrid` when evaluated imports may rely on Bun-specific
resolution. Use `native` only when `oxc-resolver` can resolve all evaluated imports, or mirror Bun-only aliases in
`oxcOptions.resolver.alias`.

## Transforming libraries in `node_modules`

By default, the Bun plugin skips transforming files from `node_modules` for performance.

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

## Disabling vendor prefixing

Stylis adds vendor-prefixed CSS by default. To disable it (and reduce CSS size), pass `prefixer: false`:

```js
wyw({
  prefixer: false,
});
```

To get details about supported options by the plugin, please check [documentation](https://wyw-in-js.dev/bundlers/bun).
