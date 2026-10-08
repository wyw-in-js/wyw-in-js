import dedent from 'dedent';
import { compile, middleware, serialize, stringify } from 'stylis';

import {
  createStylisPreprocessor,
  createStylisUrlReplacePlugin,
  stylisGlobalPlugin,
} from '../createStylisPreprocessor';

describe('createStylisPreprocessor', () => {
  const baseOptions = {
    filename: '/path/to/src/file.js',
    outputFilename: '/path/to/assets/file.css',
  };
  const preprocessor = createStylisPreprocessor(baseOptions);

  const compileRule = (rule: string) => preprocessor('.foo', rule);

  describe('comments', () => {
    it('drops comments by default', () => {
      expect(compileRule('/*rtl:ignore*/ left: 0;')).toMatchInlineSnapshot(
        `".foo{left:0;}"`
      );
    });

    it('keeps comments when enabled', () => {
      const preprocessorWithComments = createStylisPreprocessor({
        ...baseOptions,
        keepComments: true,
      });

      expect(
        preprocessorWithComments('.foo', '/*rtl:ignore*/ left: 0;')
      ).toMatchInlineSnapshot(`".foo{/*rtl:ignore*/left:0;}"`);
    });

    it('filters comments by pattern', () => {
      const preprocessorWithComments = createStylisPreprocessor({
        ...baseOptions,
        keepComments: /rtl:/,
      });

      const result = preprocessorWithComments(
        '.foo',
        '/*rtl:ignore*/ left: 0; /*keep*/ right: 0;'
      );

      expect(result).toContain('/*rtl:ignore*/');
      expect(result).not.toContain('/*keep*/');
    });
  });

  describe('display', () => {
    it('normalizes multi-keyword flex display values before prefixing', () => {
      const preprocessorWithPrefixer = createStylisPreprocessor({
        filename: baseOptions.filename,
      });
      const compileRuleWithPrefixer = (rule: string) =>
        preprocessorWithPrefixer('.foo', rule);

      const a = compileRuleWithPrefixer(
        'display: flex inline; align-items: center;'
      );
      const b = compileRuleWithPrefixer(
        'display: inline flex; align-items: center;'
      );

      expect(a).toEqual(b);
      expect(a).not.toContain('display:-webkit-boxdisplay');
      expect(a).toMatchInlineSnapshot(
        `".foo{display:-webkit-inline-box;display:-webkit-inline-flex;display:-ms-inline-flexbox;display:inline-flex;-webkit-align-items:center;-webkit-box-align:center;-ms-flex-align:center;align-items:center;}"`
      );
    });

    it('normalizes multi-keyword grid display values before prefixing', () => {
      const preprocessorWithPrefixer = createStylisPreprocessor({
        filename: baseOptions.filename,
      });
      const compileRuleWithPrefixer = (rule: string) =>
        preprocessorWithPrefixer('.foo', rule);

      const a = compileRuleWithPrefixer(
        'display: grid inline; align-items: center;'
      );
      const b = compileRuleWithPrefixer(
        'display: inline grid; align-items: center;'
      );

      expect(a).toEqual(b);
      expect(a).toMatchInlineSnapshot(
        `".foo{display:-ms-inline-grid;display:inline-grid;-webkit-align-items:center;-webkit-box-align:center;-ms-flex-align:center;align-items:center;}"`
      );
    });

    it('canonicalizes multi-keyword display values to legacy single keywords when equivalent', () => {
      const preprocessorWithPrefixer = createStylisPreprocessor({
        filename: baseOptions.filename,
      });
      const compileRuleWithPrefixer = (rule: string) =>
        preprocessorWithPrefixer('.foo', rule);

      expect(
        compileRuleWithPrefixer('display: block flex; align-items: center;')
      ).toMatchInlineSnapshot(
        `".foo{display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;-webkit-align-items:center;-webkit-box-align:center;-ms-flex-align:center;align-items:center;}"`
      );

      expect(
        compileRuleWithPrefixer('display: block grid; align-items: center;')
      ).toMatchInlineSnapshot(
        `".foo{display:-ms-grid;display:grid;-webkit-align-items:center;-webkit-box-align:center;-ms-flex-align:center;align-items:center;}"`
      );

      expect(
        compileRuleWithPrefixer('display: inline flow; left: 0;')
      ).toMatchInlineSnapshot(`".foo{display:inline;left:0;}"`);

      expect(
        compileRuleWithPrefixer('display: block flow; left: 0;')
      ).toMatchInlineSnapshot(`".foo{display:block;left:0;}"`);

      expect(
        compileRuleWithPrefixer('display: inline table; left: 0;')
      ).toMatchInlineSnapshot(`".foo{display:inline-table;left:0;}"`);

      expect(
        compileRuleWithPrefixer('display: block table; left: 0;')
      ).toMatchInlineSnapshot(`".foo{display:table;left:0;}"`);

      expect(
        compileRuleWithPrefixer('display: block flow-root; left: 0;')
      ).toMatchInlineSnapshot(`".foo{display:flow-root;left:0;}"`);

      expect(
        compileRuleWithPrefixer('display: block flow list-item; left: 0;')
      ).toMatchInlineSnapshot(`".foo{display:list-item;left:0;}"`);
    });

    it('keeps non-collapsible multi-keyword display values intact', () => {
      const preprocessorWithPrefixer = createStylisPreprocessor({
        filename: baseOptions.filename,
      });
      const compileRuleWithPrefixer = (rule: string) =>
        preprocessorWithPrefixer('.foo', rule);

      expect(
        compileRuleWithPrefixer('display: inline flow-root; left: 0;')
      ).toMatchInlineSnapshot(`".foo{display:inline flow-root;left:0;}"`);
    });

    it('avoids broken prefixer output for non-collapsible flex/grid multi-keyword forms', () => {
      const preprocessorWithPrefixer = createStylisPreprocessor({
        filename: baseOptions.filename,
      });
      const compileRuleWithPrefixer = (rule: string) =>
        preprocessorWithPrefixer('.foo', rule);

      const flexListItem = compileRuleWithPrefixer(
        'display: flex list-item; left: 0;'
      );
      expect(flexListItem).not.toContain('display:-webkit-boxdisplay');
      expect(flexListItem).toMatchInlineSnapshot(
        `".foo{display:list-item flex;left:0;}"`
      );

      const gridListItem = compileRuleWithPrefixer(
        'display: grid list-item; left: 0;'
      );
      expect(gridListItem).toMatchInlineSnapshot(
        `".foo{display:list-item grid;left:0;}"`
      );
    });

    it('preserves "!important" for canonicalized values', () => {
      const preprocessorWithPrefixer = createStylisPreprocessor({
        filename: baseOptions.filename,
      });
      const compileRuleWithPrefixer = (rule: string) =>
        preprocessorWithPrefixer('.foo', rule);

      expect(
        compileRuleWithPrefixer(
          'display: flex inline !important; align-items: center;'
        )
      ).toMatchInlineSnapshot(
        `".foo{display:-webkit-inline-box!important;display:-webkit-inline-flex!important;display:-ms-inline-flexbox!important;display:inline-flex!important;-webkit-align-items:center;-webkit-box-align:center;-ms-flex-align:center;align-items:center;}"`
      );
    });

    it('does not normalize display when prefixer is disabled', () => {
      const preprocessorWithPrefixerDisabled = createStylisPreprocessor({
        filename: baseOptions.filename,
        prefixer: false,
      });
      const compileRuleWithPrefixerDisabled = (rule: string) =>
        preprocessorWithPrefixerDisabled('.foo', rule);

      expect(
        compileRuleWithPrefixerDisabled(
          'display: flex inline; align-items: center;'
        )
      ).toMatchInlineSnapshot(
        `".foo{display:flex inline;align-items:center;}"`
      );

      expect(
        compileRuleWithPrefixerDisabled(
          'display: block flex; align-items: center;'
        )
      ).toMatchInlineSnapshot(`".foo{display:block flex;align-items:center;}"`);
    });
  });

  describe('outputFilename', () => {
    const withoutOutputFilename = createStylisPreprocessor({
      filename: baseOptions.filename,
    });

    it.each([
      'display: flex inline; align-items: center;',
      'user-select: none; transform: translateX(1px);',
      '& { animation: bar 0s forwards; } @keyframes bar { from { color: red } }',
    ])('prefixes and normalizes declarations as without it: %s', (rule) => {
      expect(compileRule(rule)).toBe(withoutOutputFilename('.foo', rule));
    });

    it('prefixes declarations with rewritten url() paths', () => {
      expect(
        compileRule('mask: url(./mask.svg); background: url("./bg.png");')
      ).toBe(
        '.foo{-webkit-mask:url(../src/mask.svg);mask:url(../src/mask.svg);background:url("../src/bg.png");}'
      );
    });
  });

  it('should understand namespace ref', () => {
    expect(compileRule('&:not(.bar) { color: red }')).toMatchInlineSnapshot(
      `".foo:not(.bar){color:red;}"`
    );

    expect(compileRule(':not(.bar)>& { color: red }')).toMatchInlineSnapshot(
      `":not(.bar)>.foo{color:red;}"`
    );
  });

  describe('keyframes', () => {
    it('should add suffix to @keyframes', () => {
      expect(
        compileRule('@keyframes bar { from { color: red } }')
      ).toMatchInlineSnapshot(
        `"@-webkit-keyframes bar-foo{from{color:red;}}@keyframes bar-foo{from{color:red;}}"`
      );
    });

    it('should add suffix to animation', () => {
      expect(
        compileRule(
          '& { animation: bar 0s forwards; } @keyframes bar { from { color: red } }'
        )
      ).toMatchInlineSnapshot(
        `".foo{-webkit-animation:bar-foo 0s forwards;animation:bar-foo 0s forwards;}@-webkit-keyframes bar-foo{from{color:red;}}@keyframes bar-foo{from{color:red;}}"`
      );
    });

    it('should add suffix to animation-name', () => {
      // Usage before definition
      expect(
        compileRule(
          '& { animation-name: bar; } @keyframes bar { from { color: red } }'
        )
      ).toMatchInlineSnapshot(
        `".foo{-webkit-animation-name:bar-foo;animation-name:bar-foo;}@-webkit-keyframes bar-foo{from{color:red;}}@keyframes bar-foo{from{color:red;}}"`
      );

      // Usage after definition
      expect(
        compileRule(
          '@keyframes bar { from { color: red } } & { animation-name: bar; }'
        )
      ).toMatchInlineSnapshot(
        `"@-webkit-keyframes bar-foo{from{color:red;}}@keyframes bar-foo{from{color:red;}}.foo{-webkit-animation-name:bar-foo;animation-name:bar-foo;}"`
      );
    });

    it('should ignore unknown keyframes', () => {
      expect(compileRule('& { animation-name: bar; }')).toMatchInlineSnapshot(
        `".foo{-webkit-animation-name:bar;animation-name:bar;}"`
      );
    });

    describe('should unwrap global', () => {
      it('in @keyframes', () => {
        expect(
          compileRule('@keyframes :global(bar) { from { color: red } }')
        ).toMatchInlineSnapshot(
          `"@-webkit-keyframes bar{from{color:red;}}@keyframes bar{from{color:red;}}"`
        );
      });

      it('in animation', () => {
        expect(
          compileRule('& { animation: :global(bar) 0s forwards; }')
        ).toMatchInlineSnapshot(
          `".foo{-webkit-animation:bar 0s forwards;animation:bar 0s forwards;}"`
        );
      });

      it('in animation-name', () => {
        expect(
          compileRule('& { animation-name: :global(bar); }')
        ).toMatchInlineSnapshot(
          `".foo{-webkit-animation-name:bar;animation-name:bar;}"`
        );
      });

      it('with no whitespace after an animation property colon', () => {
        expect(
          compileRule('& { animation::global(bar) 0s forwards; }')
        ).toEqual(compileRule('& { animation: :global(bar) 0s forwards; }'));
        expect(compileRule('& { animation-name::global(bar); }')).toEqual(
          compileRule('& { animation-name: :global(bar); }')
        );
      });

      it('with no whitespace and prefixing disabled', () => {
        const preprocessorWithoutPrefixer = createStylisPreprocessor({
          ...baseOptions,
          prefixer: false,
        });

        expect(
          preprocessorWithoutPrefixer(
            '.foo',
            '& { animation::global(bar) 0s forwards; }'
          )
        ).toBe('.foo{animation:bar 0s forwards;}');
      });

      it('in @keyframes and animation-name simultaneously', () => {
        expect(
          compileRule(
            '@keyframes :global(bar) { from { color: red } } & { animation-name: :global(bar); }'
          )
        ).toMatchInlineSnapshot(
          `"@-webkit-keyframes bar{from{color:red;}}@keyframes bar{from{color:red;}}.foo{-webkit-animation-name:bar;animation-name:bar;}"`
        );

        expect(
          compileRule(
            '& { animation-name: :global(bar); } @keyframes :global(bar) { from { color: red } }'
          )
        ).toMatchInlineSnapshot(
          `".foo{-webkit-animation-name:bar;animation-name:bar;}@-webkit-keyframes bar{from{color:red;}}@keyframes bar{from{color:red;}}"`
        );
      });
    });
  });
});

describe('stylisUrlReplacePlugin', () => {
  const filename = '/path/to/src/file.js';
  const outputFilename = '/path/to/assets/file.css';

  const stylisUrlReplacePlugin = createStylisUrlReplacePlugin(
    filename,
    outputFilename
  );

  function compileRule(rule: string): string {
    return serialize(
      compile(rule),
      middleware([stylisUrlReplacePlugin, stringify])
    );
  }

  it('should replace relative paths in url() expressions', () => {
    expect(
      compileRule('.component { background-image: url(./image.png) }')
    ).toMatchInlineSnapshot(
      `".component{background-image:url(../src/image.png);}"`
    );
  });
});

describe('stylisGlobalPlugin', () => {
  function compileRule(rule: string): string {
    return serialize(
      compile(rule),
      middleware([stylisGlobalPlugin, stringify])
    );
  }

  describe('inner part of :global()', () => {
    it('single selector', () => {
      expect(
        compileRule('.component :global(.global) { color: red }')
      ).toMatchInlineSnapshot(`".global {color:red;}"`);

      expect(
        compileRule('.component &:global(.global) { color: red }')
      ).toMatchInlineSnapshot(`".global.component {color:red;}"`);

      expect(
        compileRule('.component & :global(.global) { color: red }')
      ).toMatchInlineSnapshot(`".global .component {color:red;}"`);
    });

    it('multiple selectors', () => {
      expect(
        compileRule('.component :global(.globalA.globalB) { color: red }')
      ).toMatchInlineSnapshot(`".globalA.globalB {color:red;}"`);

      expect(
        compileRule('.component &:global(.globalA.globalB) { color: red }')
      ).toMatchInlineSnapshot(`".globalA.globalB.component {color:red;}"`);

      expect(
        compileRule('.component & :global(.globalA.globalB) { color: red }')
      ).toMatchInlineSnapshot(`".globalA.globalB .component {color:red;}"`);
    });

    it('data selector', () => {
      expect(
        compileRule('.component :global([data-global-style]) { color: red }')
      ).toMatchInlineSnapshot(`"[data-global-style] {color:red;}"`);

      expect(
        compileRule('.component &:global([data-global-style]) { color: red }')
      ).toMatchInlineSnapshot(`"[data-global-style].component {color:red;}"`);

      expect(
        compileRule('.component & :global([data-global-style]) { color: red }')
      ).toMatchInlineSnapshot(`"[data-global-style] .component {color:red;}"`);
    });
  });

  describe('nested part of :global()', () => {
    it('single selector', () => {
      expect(
        compileRule('.component :global() { .global { color: red } }')
      ).toMatchInlineSnapshot(`".global {color:red;}"`);

      expect(
        compileRule('.component &:global() { .global { color: red } }')
      ).toMatchInlineSnapshot(`".global.component {color:red;}"`);

      expect(
        compileRule('.component & :global() { .global { color: red } }')
      ).toMatchInlineSnapshot(`".global .component {color:red;}"`);
    });

    it('multi-level nested selector', () => {
      expect(
        compileRule(
          '.component :global() { .global { .nested { color: red } } }'
        )
      ).toMatchInlineSnapshot(`".global .nested {color:red;}"`);

      expect(
        compileRule(':global() { body { .someClassName { color: red; } } }')
      ).toMatchInlineSnapshot(`"body .someClassName {color:red;}"`);
    });

    it('multiple selectors', () => {
      const cssRuleA = dedent(`
        .component :global() {
          .globalA { color: red }
          .globalB { color: blue }
        }
      `);
      const cssRuleB = dedent(`
        .component &:global() {
          .globalA { color: red }
          .globalB { color: blue }
        }
      `);
      const cssRuleC = dedent(`
        .component & :global() {
          .globalA { color: red }
          .globalB { color: blue }
        }
      `);

      expect(compileRule(cssRuleA)).toMatchInlineSnapshot(
        `".globalA {color:red;}.globalB {color:blue;}"`
      );
      expect(compileRule(cssRuleB)).toMatchInlineSnapshot(
        `".globalA.component {color:red;}.globalB.component {color:blue;}"`
      );
      expect(compileRule(cssRuleC)).toMatchInlineSnapshot(
        `".globalA .component {color:red;}.globalB .component {color:blue;}"`
      );
    });

    it('@media', () => {
      const cssRule = dedent(`
        .component :global() {
          @media (prefers-color-scheme: dark) {
            html {
              color-scheme: dark;
            }
          }
        }
      `);

      expect(compileRule(cssRule)).toMatchInlineSnapshot(
        `"@media (prefers-color-scheme: dark){html {color-scheme:dark;}}"`
      );
    });
  });
});
