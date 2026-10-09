# @wyw-in-js/webpack

The package contains WyW-in-JS loader for [Webpack](https://webpack.js.org/).

## Installation

```shell
# npm
npm i -D @wyw-in-js/webpack-loader
# yarn
yarn add --dev @wyw-in-js/webpack-loader
# pnpm
pnpm add -D @wyw-in-js/webpack-loader
# bun
bun add -d @wyw-in-js/webpack-loader
```

## Usage

To use the loader with Webpack, please add `@wyw-in-js/webpack-loader` under `module.rules`:

```js
module.exports = {
  test: /\.js$/,
  use: [
    {
      loader: '@wyw-in-js/webpack-loader',
      options: {
        sourceMap: process.env.NODE_ENV !== 'production',
      },
    },
  ],
};
```

## Extracted CSS source maps

The loader's `sourceMap: true` option generates mappings from CSS back to the original JavaScript or TypeScript. The CSS pipeline must also compose and emit those maps. With webpack, a standard extraction setup is:

```js
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.js$/,
        use: [
          { loader: '@wyw-in-js/webpack-loader', options: { sourceMap: true } },
        ],
      },
      {
        test: /\.wyw-in-js\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
    ],
  },
  plugins: [new MiniCssExtractPlugin()],
};
```

Install `css-loader` and `mini-css-extract-plugin` alongside this loader. If you use `postcss-loader`, place it after `css-loader` in `use` and set css-loader's `importLoaders: 1`. Webpack's source-map tooling enables mapping in both loaders by default; an explicit `sourceMap: false` overrides that default.

`eval` and `eval-source-map` devtools do not emit maps for extracted CSS. To retain an eval-based JavaScript devtool, add this plugin instead of switching to `devtool: 'source-map'`:

```js
new webpack.SourceMapDevToolPlugin({ test: /\.css$/, filename: '[file].map' });
```

Here `webpack` is `require('webpack')`; keep `MiniCssExtractPlugin` in the plugins list. This emits CSS maps while retaining the existing JavaScript devtool. Do not add this plugin when `devtool: 'source-map'` already supplies it.

For Rspack, use its `CssExtractRspackPlugin` and `SourceMapDevToolPlugin`. When combining a CSS-only map plugin with an eval-based devtool, explicitly set `sourceMap: true` on `css-loader` and, if present, `postcss-loader`: Rspack does not infer those loader settings from the CSS-only plugin.

The output loader passes the map through the loader callback, separately from CSS. The final `.css.map` includes original source text; CSS does not need per-file inline map comments. Raw asset modules, such as `asset/resource`, retain an inline CSS map when `sourceMap: true`, so source navigation also works without a CSS extraction pipeline.

## Eval resolver modes

`eval.resolver: 'native'` and the native step of `eval.resolver: 'hybrid'` use `oxc-resolver` with automatic
`tsconfig.json` discovery. The loader also forwards static string entries from webpack `resolve.alias`.

Use `hybrid` when evaluated imports may rely on webpack resolver plugins, query handling, or non-string aliases. Use
`native` only when `oxc-resolver` can resolve all evaluated imports, or mirror webpack-only aliases in
`oxcOptions.resolver.alias`.

## Running transforms in worker threads

Set `parallel: true` to run transforms in up to four worker threads, or pass a number to choose the count:

```js
use: [{ loader: '@wyw-in-js/webpack-loader', options: { parallel: true } }],
```

Options are sent to the workers as data, so function options (for example `tagResolver`) must be defined in a wyw-in-js
config file. Otherwise, or when `WYWinJSDebugPlugin` is used, the loader warns and runs transforms on the main thread.

Each worker starts with a 1.5 GB heap limit and is restarted with a larger one if it runs out of memory; an explicit
`--max-old-space-size` applies to every worker instead.

## Disabling vendor prefixing

Stylis adds vendor-prefixed CSS by default. To disable it (and reduce CSS size), pass `prefixer: false`:

```js
module.exports = {
  test: /\.js$/,
  use: [
    {
      loader: '@wyw-in-js/webpack-loader',
      options: {
        prefixer: false,
      },
    },
  ],
};
```

To get details about supported options by the plugin, please check [documentation](https://wyw-in-js.dev/bundlers/webpack).
