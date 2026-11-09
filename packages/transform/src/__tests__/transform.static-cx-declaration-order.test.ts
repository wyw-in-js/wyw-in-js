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
import type { PluginOptions } from '../types';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

const createResolver = () => async (what: string, importer: string) => {
  if (what === 'test-css-processor') {
    return processorFile;
  }
  if (what.startsWith('.')) {
    const base = resolve(dirname(importer), what);
    for (const ext of ['', '.ts', '.tsx', '.js']) {
      if (existsSync(base + ext)) {
        return base + ext;
      }
    }
    return base;
  }
  return null;
};

const TOKENS = dedent`
  export const themeVars = {
    borderSeparator: 'var(--borderSeparator)',
    borderSeparatorDimmed: 'var(--borderSeparatorDimmed)',
  };
  export const textClasses = { regular: 'regular', small: 'small' };
`;

const runStatic = async (source: string, tokens = TOKENS) => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-cx-order-'));
  const entryFile = join(root, 'entry.tsx');
  writeFileSync(join(root, 'tokens.ts'), tokens);
  writeFileSync(entryFile, source);

  try {
    return await transform(
      {
        cache: new TransformCacheCollection(),
        options: {
          filename: entryFile,
          root,
          pluginOptions: {
            configFile: false,
            eval: { require: 'off', strategy: 'static' },
            tagResolver: (tagSource: string, tag: string) =>
              tagSource === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
          } as Partial<PluginOptions> as PluginOptions,
        },
      },
      readFileSync(entryFile, 'utf8'),
      createResolver()
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const HEADER = dedent`
  import { css, cx } from 'test-css-processor';
  import { textClasses, themeVars } from './tokens';
`;

const FIRST = 'const a = css`border-top: ${themeVars.borderSeparator};`;';
const SECOND =
  'const b = css`border-top: ${themeVars.borderSeparatorDimmed};`;';
const CX_WITH_CSS = 'const g = cx(textClasses.regular, css`min-height: 0;`);';
const CX_WITHOUT_CSS = 'const g = cx(textClasses.regular, textClasses.small);';
const PLAIN_CSS = 'const p = css`display: none;`;';
const CX_LITERALS_ONLY = "const g = cx('one', 'two');";
const CX_CSS_ONLY = 'const g = cx(css`min-height: 0;`);';
const LOCAL_CALL_WITH_IMPORT = [
  'const identity = (value) => value;',
  'const g = identity(textClasses.regular);',
].join('\n');

const source = (...parts: string[]) =>
  [HEADER, '', ...parts, '', 'export const all = [a, b];'].join('\n');

describe('static eval of css tags declared after a module-level cx()', () => {
  const expectResolved = (cssText: string) => {
    expect(cssText).toContain('border-top:var(--borderSeparator)');
    expect(cssText).toContain('border-top:var(--borderSeparatorDimmed)');
  };

  it('resolves both tags when no cx() is present', async () => {
    const result = await runStatic(source(FIRST, SECOND));
    expectResolved(result.cssText);
  });

  it('resolves both tags when cx() comes last', async () => {
    const result = await runStatic(source(FIRST, SECOND, CX_WITH_CSS));
    expectResolved(result.cssText);
  });

  it('resolves both tags when cx() comes first', async () => {
    const result = await runStatic(source(CX_WITH_CSS, FIRST, SECOND));
    expectResolved(result.cssText);
  });

  it('resolves the tag that follows a cx() in the middle', async () => {
    const result = await runStatic(source(FIRST, CX_WITH_CSS, SECOND));
    expectResolved(result.cssText);
  });

  it('resolves tags after a cx() that takes no css argument', async () => {
    const result = await runStatic(source(CX_WITHOUT_CSS, FIRST, SECOND));
    expectResolved(result.cssText);
  });

  it('resolves a tag declared after both a plain css tag and a cx()', async () => {
    const result = await runStatic(
      source(PLAIN_CSS, CX_WITH_CSS, FIRST, SECOND)
    );
    expectResolved(result.cssText);
  });

  it('resolves when nothing interpolated follows the cx()', async () => {
    const result = await runStatic(
      source(FIRST, SECOND, CX_WITH_CSS, PLAIN_CSS)
    );
    expectResolved(result.cssText);
  });

  it('resolves after a cx() called with only literals', async () => {
    const result = await runStatic(source(CX_LITERALS_ONLY, FIRST, SECOND));
    expectResolved(result.cssText);
  });

  it('resolves after a cx() called with only a css tag', async () => {
    const result = await runStatic(source(CX_CSS_ONLY, FIRST, SECOND));
    expectResolved(result.cssText);
  });

  it('resolves after a local function called with an imported binding', async () => {
    const result = await runStatic(
      source(LOCAL_CALL_WITH_IMPORT, FIRST, SECOND)
    );
    expectResolved(result.cssText);
  });

  it('keeps an object-valued member argument hazardous', async () => {
    const tokens = dedent`
      export const themeVars = {
        borderSeparator: 'var(--borderSeparator)',
        borderSeparatorDimmed: 'var(--borderSeparatorDimmed)',
      };
      export const textClasses = {
        regular: { value: 'regular' },
        small: 'small',
      };
    `;

    await expect(
      runStatic(source(CX_WITHOUT_CSS, FIRST, SECOND), tokens)
    ).rejects.toThrow(
      'an earlier call may mutate a value used by this interpolation'
    );
  });

  it('keeps an accessor member argument hazardous', async () => {
    const tokens = dedent`
      export const themeVars = {
        borderSeparator: 'var(--borderSeparator)',
        borderSeparatorDimmed: 'var(--borderSeparatorDimmed)',
      };
      export const textClasses = {
        get regular() {
          themeVars.borderSeparator = 'changed';
          return 'regular';
        },
        small: 'small',
      };
    `;

    // The getter writes `themeVars`, so the tokens module itself no longer
    // treats `themeVars` as a constant.
    const result = runStatic(source(CX_WITHOUT_CSS, FIRST, SECOND), tokens);
    await expect(result).rejects.toThrow('could not be resolved at build time');
    await expect(result).rejects.toThrow('themeVars.borderSeparator');
  });
});
