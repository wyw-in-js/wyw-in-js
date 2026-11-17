import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';

/* eslint-disable import/no-unresolved -- Bun is the package test runtime. */
// @ts-expect-error The package test runtime provides bun:jsc; the legacy spec
// tsconfig intentionally exposes Jest globals instead of Bun's module types.
const { fullGC, heapStats } = (await import('bun:jsc')) as {
  fullGC: () => number;
  heapStats: () => { heapSize: number };
};
/* eslint-enable import/no-unresolved */

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

// A design-token module of about 15 KB, as in a real project.
const tokensSource = [
  `export const color = { bg: '#fff', fg: '#000' };`,
  ...Array.from(
    { length: 300 },
    (_, n) =>
      `export const padding${n} = { value: ${n}, name: 'padding ${n}' };`
  ),
].join('\n');

const entrySource = dedent`
  import { css } from 'test-css-processor';
  import { color } from './tokens';

  export const className = css\`
    color: ${'${color.fg}'};
    background: ${'${color.bg}'};
  \`;
`;

const resolveImport = async (what: string, importer: string) => {
  if (what === 'test-css-processor') {
    return processorFile;
  }

  const candidate = `${resolve(dirname(importer), what)}.ts`;
  return existsSync(candidate) ? candidate : null;
};

// The warm-up edits take the one-time allocations of the first transforms out
// of the measurement.
const WARM_UP_EDITS = 20;
const MEASURED_EDITS = 40;
// A version of the token module that stays reachable holds about 1.3 MB (its
// source and parsed program). When earlier versions are released, an edit
// leaves well under this bound behind; the margin absorbs allocator noise.
const MAX_RETAINED_BYTES_PER_EDIT = 256 * 1024;

const retainedHeapBytes = () => {
  fullGC();
  return heapStats().heapSize;
};

// Edits an imported module the way a dev server sees it during a session, and
// re-transforms the module that imports it after every edit.
const editImportedModuleRepeatedly = async (
  cache: TransformCacheCollection | undefined
) => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-edited-module-retention-'));
  const tokensFile = join(root, 'tokens.ts');
  const entryFile = join(root, 'entry.ts');
  writeFileSync(entryFile, entrySource);

  const editAndTransform = async (edit: number) => {
    // The project directory makes every version unique to this run.
    writeFileSync(tokensFile, `${tokensSource}\n// ${root}: edit ${edit}\n`);
    cache?.invalidateForFile(tokensFile);
    cache?.invalidateForFile(entryFile);

    const result = await transform(
      {
        ...(cache ? { cache } : {}),
        options: {
          filename: entryFile,
          root,
          pluginOptions: {
            configFile: false,
            tagResolver: (source, tag) =>
              source === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
          },
        },
      },
      readFileSync(entryFile, 'utf8'),
      resolveImport
    );

    expect(result.cssText).toContain('color:#000;background:#fff;');
  };

  const editAndTransformInTurn = async (from: number, to: number) => {
    for (let edit = from; edit < to; edit += 1) {
      // Each edit is seen after the transform of the previous one.
      // eslint-disable-next-line no-await-in-loop
      await editAndTransform(edit);
    }
  };

  try {
    await editAndTransformInTurn(0, WARM_UP_EDITS);
    const before = retainedHeapBytes();
    await editAndTransformInTurn(WARM_UP_EDITS, WARM_UP_EDITS + MEASURED_EDITS);

    return Math.round((retainedHeapBytes() - before) / MEASURED_EDITS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('memory retained across edits of an imported module', () => {
  it('does not retain earlier versions of an edited module with a shared cache', async () => {
    const retainedPerEdit = await editImportedModuleRepeatedly(
      new TransformCacheCollection()
    );

    expect(retainedPerEdit).toBeLessThan(MAX_RETAINED_BYTES_PER_EDIT);
  });

  it('does not retain earlier versions of an edited module without a shared cache', async () => {
    const retainedPerEdit = await editImportedModuleRepeatedly(undefined);

    expect(retainedPerEdit).toBeLessThan(MAX_RETAINED_BYTES_PER_EDIT);
  });
});
