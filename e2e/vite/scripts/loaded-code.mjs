import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { build } from 'vite';

import wyw from '@wyw-in-js/vite';

export async function assertLoadedCode(pkgDir) {
  const fixture = await fs.mkdtemp(path.join(pkgDir, 'loaded-code-'));
  const fixturePrefix = `${fixture.replace(/\\/g, '/')}/`;
  const names = ['page', 'header', 'footer', 'button', 'icon', 'spacing'];
  try {
    await fs.cp(path.join(pkgDir, 'fixtures', 'loaded-code'), fixture, {
      recursive: true,
    });
    const entry = path.join(fixture, 'index.ts');
    await fs.writeFile(
      entry,
      names.map((name) => `export { ${name} } from './${name}';`).join('\n')
    );
    const plugin = wyw();
    const seen = new Set();
    const assertJavaScript = {
      name: 'assert-loaded-javascript',
      enforce: 'post',
      transform(code, id) {
        const normalizedId = id.replace(/\\/g, '/');
        if (
          normalizedId.startsWith(fixturePrefix) &&
          /\.ts$/.test(normalizedId)
        ) {
          seen.add(path.posix.basename(normalizedId));
          assert(
            !/:\s*number/.test(code),
            `WyW returned disk TypeScript for ${id}`
          );
          assert(!code.includes('css`'), `Unprocessed CSS tag in ${id}`);
        }
      },
    };

    for (let round = 0; round < 2; round += 1) {
      seen.clear();
      const result = await build({
        root: fixture,
        configFile: false,
        logLevel: 'silent',
        plugins: [plugin, assertJavaScript],
        build: {
          write: false,
          cssMinify: false,
          lib: { entry, formats: ['es'], fileName: 'index' },
        },
      });
      assert.deepEqual(
        seen,
        new Set(['index.ts', ...names.map((name) => `${name}.ts`)])
      );
      const output = Array.isArray(result)
        ? result.flatMap((bundle) => bundle.output)
        : result.output;
      const cssAssets = output.filter(
        (output) => output.type === 'asset' && output.fileName.endsWith('.css')
      );
      assert.equal(cssAssets.length, 1);
      const css = Buffer.from(cssAssets[0].source).toString();
      assert.equal((css.match(/margin:/g) ?? []).length, names.length);
      for (const size of [8, 16, 24, 32]) {
        assert(new RegExp(`margin:\\s*${size}px`).test(css));
      }
    }
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
}
