import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import prettier from 'prettier';
import { build } from 'vite';

import wyw from '@wyw-in-js/vite';

import { parseOxcSync } from '../../../packages/transform/src/utils/parseOxc.ts';

const pkgDir = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(
  path.resolve(pkgDir, '../../packages/transform/package.json')
);
const { rawTransferSupported } = await import(
  pathToFileURL(require.resolve('oxc-parser')).href
);

// Run in a fresh Node process: Oxc caches its buffers and WyW caches the
// allocation failure. Reject the actual large allocation before native parsing.
assert(rawTransferSupported(), 'This Node smoke test requires raw transfer');
const OriginalArrayBuffer = globalThis.ArrayBuffer;
let rejectedAllocations = 0;
globalThis.ArrayBuffer = class extends OriginalArrayBuffer {
  constructor(byteLength, ...args) {
    if (byteLength > 1024 ** 3) {
      rejectedAllocations += 1;
      throw new RangeError('Array buffer allocation failed');
    }
    super(byteLength, ...args);
  }
};

try {
  const code = 'export const View = () => <div title="Привет 👋" />;';
  const options = { astType: 'ts', range: true, sourceType: 'module' };
  assert.equal(
    parseOxcSync('opt-out.tsx', code, {
      ...options,
      experimentalRawTransfer: false,
    }).errors.length,
    0
  );
  assert.equal(rejectedAllocations, 0);

  const fixture = path.join(pkgDir, 'fixtures/raw-transfer-allocation');
  const result = await build({
    root: fixture,
    configFile: false,
    logLevel: 'silent',
    plugins: [wyw({ classNameSlug: 'raw-transfer' })],
    build: {
      write: false,
      cssMinify: false,
      lib: {
        entry: path.join(fixture, 'index.tsx'),
        formats: ['es'],
        fileName: 'index',
      },
    },
  });
  const output = Array.isArray(result)
    ? result.flatMap((bundle) => bundle.output)
    : result.output;
  const cssAssets = output.filter(
    (item) => item.type === 'asset' && item.fileName.endsWith('.css')
  );
  assert.equal(cssAssets.length, 1);
  const css = await prettier.format(
    Buffer.from(cssAssets[0].source).toString(),
    { parser: 'css' }
  );
  const expected = await prettier.format(
    await fs.readFile(path.join(fixture, 'expected.css'), 'utf8'),
    { parser: 'css' }
  );
  assert.equal(css, expected);
  assert(
    output.some((item) => item.type === 'chunk' && item.code.includes('View'))
  );
  assert.equal(parseOxcSync('subsequent.tsx', code, options).errors.length, 0);
  assert.equal(
    rejectedAllocations,
    1,
    'Subsequent parses must keep using JSON'
  );
  console.log('Raw-transfer allocation fallback: PASS');
} finally {
  globalThis.ArrayBuffer = OriginalArrayBuffer;
}
