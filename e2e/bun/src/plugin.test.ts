import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'bun:test';
import prettier from 'prettier';

import wyw from '@wyw-in-js/bun';

const PKG_DIR = path.resolve(__dirname, '..');

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stripBunCssSourceComment(cssText: string): string {
  const match = cssText.match(/^\/\*\s*([^*]+?)\s*\*\/\s*/);
  if (!match) {
    return cssText;
  }

  const commentBody = match[1].trim();
  const looksLikeSource =
    commentBody.startsWith('wyw-in-js:') || /[\\/]/.test(commentBody);
  const isCssPath = /\.css$/i.test(commentBody);

  if (!looksLikeSource || !isCssPath) {
    return cssText;
  }

  return cssText.slice(match[0].length);
}

async function buildArtefact(
  outDir: string,
  pluginOptions?: object,
  entrypoint = 'index.ts'
) {
  const result = await Bun.build({
    entrypoints: [path.resolve(PKG_DIR, 'src', entrypoint)],
    outdir: outDir,
    minify: false,
    plugins: [pluginOptions ? wyw(pluginOptions) : wyw()],
  });

  if (!result.success) {
    const errors = result.logs
      .filter((l) => l.level === 'error')
      .map((l) => l.message)
      .join('\n');
    throw new Error(errors || 'Bun.build failed');
  }

  const cssOutputs = result.outputs.filter((o) => o.path.endsWith('.css'));
  if (cssOutputs.length !== 1) {
    throw new Error(`Expected exactly 1 css output, got ${cssOutputs.length}`);
  }

  const cssOutput = await readFile(cssOutputs[0].path, 'utf8');
  const stripped = stripBunCssSourceComment(cssOutput);
  return prettier.format(stripped, { parser: 'css' });
}

describe('Bun bundler', () => {
  const outDir = path.resolve(PKG_DIR, 'dist');

  it('extracts CSS (default)', async () => {
    await rm(outDir, { recursive: true, force: true });
    const cssOutput = normalizeLineEndings(await buildArtefact(outDir));
    const cssFixture = normalizeLineEndings(
      await readFile(path.resolve(PKG_DIR, 'fixture.css'), 'utf8')
    );
    expect(cssOutput).toBe(cssFixture);
  });

  it('extracts CSS (keepComments)', async () => {
    await rm(outDir, { recursive: true, force: true });
    const cssOutput = normalizeLineEndings(
      await buildArtefact(outDir, { keepComments: true })
    );
    const cssFixture = normalizeLineEndings(
      await readFile(path.resolve(PKG_DIR, 'fixture.keep-comments.css'), 'utf8')
    );
    expect(cssOutput).toBe(cssFixture);
  });

  it('extracts CSS in worker threads', async () => {
    await rm(outDir, { recursive: true, force: true });
    const cssOutput = normalizeLineEndings(
      await buildArtefact(outDir, { parallel: 2 })
    );
    const cssFixture = normalizeLineEndings(
      await readFile(path.resolve(PKG_DIR, 'fixture.css'), 'utf8')
    );
    expect(cssOutput).toBe(cssFixture);
  });

  it('supports resource query loaders (?raw/?url)', async () => {
    await rm(outDir, { recursive: true, force: true });

    const cssOutput = normalizeLineEndings(
      await buildArtefact(outDir, undefined, 'resource-query.ts')
    );

    expect(cssOutput).toContain('Hello from asset');
    expect(cssOutput).toContain('./sample-asset.txt');
  });

  it('extracts CSS from TSX entrypoints', async () => {
    await rm(outDir, { recursive: true, force: true });

    const cssOutput = normalizeLineEndings(
      await buildArtefact(outDir, undefined, 'tsx-entry.tsx')
    );

    expect(cssOutput).toMatch(/color:\s*(rebeccapurple|#639)/i);
  });

  it('statically resolves interpolations declared after cx()', async () => {
    await rm(outDir, { recursive: true, force: true });

    const cssOutput = normalizeLineEndings(
      await buildArtefact(
        outDir,
        { eval: { strategy: 'static' } },
        'static-cx-order.ts'
      )
    );

    expect(cssOutput).toContain('border-top: var(--borderSeparator)');
    expect(cssOutput).toContain('border-top: var(--borderSeparatorDimmed)');
  });

  it('statically resolves interpolations after calls with fresh primitive-only values', async () => {
    await rm(outDir, { recursive: true, force: true });

    const cssOutput = normalizeLineEndings(
      await buildArtefact(
        outDir,
        { eval: { strategy: 'static' } },
        'static-call-order.ts'
      )
    );

    expect(cssOutput).toContain('padding: 12px');
  });
});
