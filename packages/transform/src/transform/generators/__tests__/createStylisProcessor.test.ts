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
        `".foo{animation:bar-foo 0s forwards;}@-webkit-keyframes bar-foo{from{color:red;}}@keyframes bar-foo{from{color:red;}}"`
      );
    });

    it('should add suffix to animation-name', () => {
      // Usage before definition
      expect(
        compileRule(
          '& { animation-name: bar; } @keyframes bar { from { color: red } }'
        )
      ).toMatchInlineSnapshot(
        `".foo{animation-name:bar-foo;}@-webkit-keyframes bar-foo{from{color:red;}}@keyframes bar-foo{from{color:red;}}"`
      );

      // Usage after definition
      expect(
        compileRule(
          '@keyframes bar { from { color: red } } & { animation-name: bar; }'
        )
      ).toMatchInlineSnapshot(
        `"@-webkit-keyframes bar-foo{from{color:red;}}@keyframes bar-foo{from{color:red;}}.foo{animation-name:bar-foo;}"`
      );
    });

    it('should ignore unknown keyframes', () => {
      expect(compileRule('& { animation-name: bar; }')).toMatchInlineSnapshot(
        `".foo{animation-name:bar;}"`
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
        ).toMatchInlineSnapshot(`".foo{animation:bar 0s forwards;}"`);
      });

      it('in animation-name', () => {
        expect(
          compileRule('& { animation-name: :global(bar); }')
        ).toMatchInlineSnapshot(`".foo{animation-name:bar;}"`);
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
          `"@-webkit-keyframes bar{from{color:red;}}@keyframes bar{from{color:red;}}.foo{animation-name:bar;}"`
        );

        expect(
          compileRule(
            '& { animation-name: :global(bar); } @keyframes :global(bar) { from { color: red } }'
          )
        ).toMatchInlineSnapshot(
          `".foo{animation-name:bar;}@-webkit-keyframes bar{from{color:red;}}@keyframes bar{from{color:red;}}"`
        );
      });
    });
  });
});

describe('createStylisPreprocessor across rules', () => {
  const filename = '/path/to/src/file.js';
  const outputFilename = '/path/to/assets/file.css';

  // Every rule exercises a different plugin of the chain. The same rule set is
  // compiled through one preprocessor, so plugin state must not leak between
  // rules: `.i` uses `spin` without defining it and must stay unsuffixed.
  const corpus: [selector: string, text: string][] = [
    ['.a', 'color: red; &:hover { color: blue; }'],
    [
      '.b',
      'background: url(./image.png); mask: url("../mask.svg"); cursor: url(/abs.cur);',
    ],
    [
      '.c',
      ':global() { body { margin: 0; } } & :global(.dark) { color: white; }',
    ],
    ['.d', 'display: flex inline; align-items: center;'],
    [
      '.e',
      '@keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } } & { animation: spin 1s linear infinite; }',
    ],
    [
      '.f',
      '& { animation::global(fade) 0s forwards; } @keyframes :global(fade) { from { opacity: 0 } }',
    ],
    [
      '.g',
      '@media (min-width: 100px) { @keyframes pulse { from { opacity: 0 } } animation-name: pulse; }',
    ],
    [
      '.h',
      '/* keep:me */ left: 0; /* drop */ &::placeholder { color: gray; } &:read-only { color: gray; }',
    ],
    [
      '.e',
      '@keyframes spin { from { opacity: 0 } } & { animation-name: spin; }',
    ],
    ['.i', '& { animation-name: spin; }'],
  ];

  const configs = {
    default: { filename, outputFilename },
    noPrefixer: { filename, outputFilename, prefixer: false },
    noOutputFilename: { filename, keepComments: /keep:/ },
  };

  const compileCorpus = (options: (typeof configs)[keyof typeof configs]) => {
    const preprocessor = createStylisPreprocessor(options);
    return corpus.map(([selector, text]) => preprocessor(selector, text));
  };

  it('compiles every rule of the corpus', () => {
    expect(compileCorpus(configs.default)).toMatchInlineSnapshot(`
      [
        ".a{color:red;}.a:hover{color:blue;}",
        ".b{background:url(../src/image.png);mask:url("../mask.svg");cursor:url(/abs.cur);}",
        "body {margin:0;}.dark .c{color:white;}",
        ".d{display:flex inline;align-items:center;}",
        "@-webkit-keyframes spin-e{from{transform:rotate(0);}to{transform:rotate(360deg);}}@keyframes spin-e{from{transform:rotate(0);}to{transform:rotate(360deg);}}.e{animation:spin-e 1s linear infinite;}",
        ".f{animation:fade 0s forwards;}@-webkit-keyframes fade{from{opacity:0;}}@keyframes fade{from{opacity:0;}}",
        "@media (min-width: 100px){.g{animation-name:pulse;}@-webkit-keyframes pulse-g{from{opacity:0;}}@keyframes pulse-g{from{opacity:0;}}}",
        ".h{left:0;}.h::-webkit-input-placeholder{color:gray;}.h::-moz-placeholder{color:gray;}.h:-ms-input-placeholder{color:gray;}.h::placeholder{color:gray;}.h:-moz-read-only{color:gray;}.h:read-only{color:gray;}",
        "@-webkit-keyframes spin-e{from{opacity:0;}}@keyframes spin-e{from{opacity:0;}}.e{animation-name:spin-e;}",
        ".i{animation-name:spin;}",
      ]
    `);
    expect(compileCorpus(configs.noPrefixer)).toMatchInlineSnapshot(`
      [
        ".a{color:red;}.a:hover{color:blue;}",
        ".b{background:url(../src/image.png);mask:url("../mask.svg");cursor:url(/abs.cur);}",
        "body {margin:0;}.dark .c{color:white;}",
        ".d{display:flex inline;align-items:center;}",
        "@keyframes spin-e{from{transform:rotate(0);}to{transform:rotate(360deg);}}.e{animation:spin-e 1s linear infinite;}",
        ".f{animation:fade 0s forwards;}@keyframes fade{from{opacity:0;}}",
        "@media (min-width: 100px){.g{animation-name:pulse;}@keyframes pulse-g{from{opacity:0;}}}",
        ".h{left:0;}.h::placeholder{color:gray;}.h:read-only{color:gray;}",
        "@keyframes spin-e{from{opacity:0;}}.e{animation-name:spin-e;}",
        ".i{animation-name:spin;}",
      ]
    `);
    expect(compileCorpus(configs.noOutputFilename)).toMatchInlineSnapshot(`
      [
        ".a{color:red;}.a:hover{color:blue;}",
        ".b{background:url(./image.png);-webkit-mask:url("../mask.svg");mask:url("../mask.svg");cursor:url(/abs.cur);}",
        "body {margin:0;}.dark .c{color:white;}",
        ".d{display:-webkit-inline-box;display:-webkit-inline-flex;display:-ms-inline-flexbox;display:inline-flex;-webkit-align-items:center;-webkit-box-align:center;-ms-flex-align:center;align-items:center;}",
        "@-webkit-keyframes spin-e{from{-webkit-transform:rotate(0);-moz-transform:rotate(0);-ms-transform:rotate(0);transform:rotate(0);}to{-webkit-transform:rotate(360deg);-moz-transform:rotate(360deg);-ms-transform:rotate(360deg);transform:rotate(360deg);}}@keyframes spin-e{from{-webkit-transform:rotate(0);-moz-transform:rotate(0);-ms-transform:rotate(0);transform:rotate(0);}to{-webkit-transform:rotate(360deg);-moz-transform:rotate(360deg);-ms-transform:rotate(360deg);transform:rotate(360deg);}}.e{-webkit-animation:spin-e 1s linear infinite;animation:spin-e 1s linear infinite;}",
        ".f{-webkit-animation:fade 0s forwards;animation:fade 0s forwards;}@-webkit-keyframes fade{from{opacity:0;}}@keyframes fade{from{opacity:0;}}",
        "@media (min-width: 100px){.g{-webkit-animation-name:pulse;animation-name:pulse;}@-webkit-keyframes pulse-g{from{opacity:0;}}@keyframes pulse-g{from{opacity:0;}}}",
        ".h{/* keep:me */left:0;}.h::-webkit-input-placeholder{color:gray;}.h::-moz-placeholder{color:gray;}.h:-ms-input-placeholder{color:gray;}.h::placeholder{color:gray;}.h:-moz-read-only{color:gray;}.h:read-only{color:gray;}",
        "@-webkit-keyframes spin-e{from{opacity:0;}}@keyframes spin-e{from{opacity:0;}}.e{-webkit-animation-name:spin-e;animation-name:spin-e;}",
        ".i{-webkit-animation-name:spin;animation-name:spin;}",
      ]
    `);
  });

  it('does not depend on rules compiled earlier by the same preprocessor', () => {
    Object.values(configs).forEach((options) => {
      const isolated = corpus.map(([selector, text]) =>
        createStylisPreprocessor(options)(selector, text)
      );

      const shared = createStylisPreprocessor(options);
      const reversed = [...corpus]
        .reverse()
        .map(([selector, text]) => shared(selector, text))
        .reverse();

      expect(compileCorpus(options)).toEqual(isolated);
      expect(reversed).toEqual(isolated);
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
