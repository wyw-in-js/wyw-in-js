/* eslint-env jest */

import { join } from 'path';

import dedent from 'dedent';
import { SourceMapGenerator } from 'source-map';

import { oxcShaker } from '../shaker';
import { Entrypoint } from '../transform/Entrypoint';
import { syncActionRunner } from '../transform/actions/actionRunner';
import { collect } from '../transform/generators/collect';
import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import { withDefaultServices } from '../transform/helpers/withDefaultServices';
import { createPrevalPayload } from '../transform/prevalPayload';
import type {
  ActionQueueItem,
  Handlers,
  ICollectAction,
  SyncScenarioForAction,
} from '../transform/types';
import { collectOxcRuntime } from '../utils/collectOxcRuntime';
import { EventEmitter } from '../utils/EventEmitter';
import { runOxcPreevalStage } from '../utils/oxcPreevalStage';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');
const filename = join(__dirname, 'source.js');
const originalFilename = join(__dirname, 'source.tsx');

const createOptions = () =>
  loadWywOptions({
    configFile: false,
    rules: [
      {
        action: oxcShaker,
        test: () => true,
      },
    ],
    tagResolver: (source, tag) => {
      if (source === 'test-css-processor' && tag === 'css') {
        return processorFile;
      }

      return null;
    },
  });

const createInputSourceMap = (
  generatedFilename: string,
  sourceFilename: string,
  sourceContent: string
) => {
  const generator = new SourceMapGenerator({
    file: generatedFilename,
  });
  generator.addMapping({
    generated: { column: 0, line: 1 },
    original: { column: 0, line: 1 },
    source: sourceFilename,
  });
  generator.setSourceContent(sourceFilename, sourceContent);
  return generator.toJSON();
};

// eslint-disable-next-line require-yield
function* emptyHandler<
  TAction extends ActionQueueItem,
>(): SyncScenarioForAction<TAction> {
  return undefined as never;
}

const getHandlers = <TMode extends 'async' | 'sync'>(
  partial: Partial<Handlers<TMode>>
) => ({
  collect: jest.fn(emptyHandler<ICollectAction>),
  ...partial,
});

describe('collectOxcRuntime', () => {
  it('reports the runtime collect phase breakdown', () => {
    const methods: string[] = [];
    const eventEmitter = new EventEmitter(
      (labels, type) => {
        if (type === 'finish' && typeof labels.method === 'string') {
          methods.push(labels.method);
        }
      },
      () => 0,
      () => {}
    );

    collectOxcRuntime(
      dedent`
        import { css } from 'test-css-processor';
        export const className = css\`color: red;\`;
      `,
      filename,
      __dirname,
      { ...createOptions(), eventEmitter },
      new Map()
    );

    expect(methods).toEqual(
      expect.arrayContaining([
        'transform:collect:applyProcessors',
        'transform:collect:normalize',
        'transform:collect:processorRuntime',
        'transform:collect:sourceMap',
      ])
    );
  });

  it('reuses preeval analysis for runtime-only processors', () => {
    const code = dedent`
      import { css } from 'test-css-processor';
      import { jsx as _jsx } from 'react/jsx-runtime';

      const color = 'red';
      export function Component() {
        const className = css\`
          color: ${'${color}'};
        \`;

        return _jsx('div', { className });
      }
    `;
    const options = createOptions();
    const preeval = runOxcPreevalStage(
      code,
      { filename, root: __dirname },
      options
    );
    const direct = collectOxcRuntime(
      code,
      filename,
      __dirname,
      options,
      preeval.staticValueCache
    );
    const methods: string[] = [];
    const eventEmitter = new EventEmitter(
      (labels, type) => {
        if (type === 'finish' && typeof labels.method === 'string') {
          methods.push(labels.method);
        }
      },
      () => 0,
      () => {}
    );
    const reused = collectOxcRuntime(
      code,
      filename,
      __dirname,
      { ...options, eventEmitter },
      preeval.staticValueCache,
      undefined,
      preeval.runtimeProcessorPlan
    );

    expect(preeval.runtimeProcessorPlan).toBeDefined();
    expect(reused.code).toBe(direct.code);
    expect(reused.metadata?.processors).toHaveLength(1);
    expect(methods).not.toEqual(
      expect.arrayContaining([
        'transform:collect:applyProcessors:deps',
        'transform:collect:applyProcessors:imports',
        'transform:collect:applyProcessors:usages',
        'transform:collect:applyProcessors:usedNames',
      ])
    );
  });

  it('builds processors and applies runtime replacement with evaluated values', () => {
    const result = collectOxcRuntime(
      dedent`
        import { css } from 'test-css-processor';
        const color = 'red';
        export const className = css\`
          color: ${'${color}'};
        \`;
      `,
      filename,
      __dirname,
      createOptions(),
      new Map([['_exp', 'red']])
    );
    const processor = result.metadata?.processors[0];
    const cssArtifact = processor?.artifacts.find(
      (artifact) => artifact[0] === 'css'
    );

    expect(processor?.className).toBeTruthy();
    expect(result.code).toContain(
      `export const className = "${processor?.className}"`
    );
    expect(result.code).not.toContain('css`');
    expect(result.map.sources).toContain(filename);
    expect(result.map.sourcesContent?.[0]).toContain('css`');
    expect(cssArtifact?.[1][0]).toMatchObject({
      [`.${processor?.className}`]: expect.objectContaining({
        cssText: expect.stringContaining('color: red'),
      }),
    });
  });

  it('keeps adjacent units and pseudo selectors tight after expression hoisting', () => {
    const result = collectOxcRuntime(
      dedent`
        import { css } from 'test-css-processor';

        const height = 40;
        const padding = 16;
        const hoverable = 'Hoverable';

        export const className = css\`
          height: ${'${height}'}px;
          padding: 0 ${'${padding}'}px;

          .${'${hoverable}'}:hover {
            color: red;
          }
        \`;
      `,
      filename,
      __dirname,
      createOptions(),
      new Map([
        ['_exp', 40],
        ['_exp2', 16],
        ['_exp3', 'Hoverable'],
      ])
    );
    const processor = result.metadata?.processors[0];
    const cssArtifact = processor?.artifacts.find(
      (artifact) => artifact[0] === 'css'
    );
    const cssText =
      cssArtifact?.[1][0][`.${processor?.className}`]?.cssText ?? '';

    expect(cssText).toContain('height: 40px');
    expect(cssText).toContain('padding: 0 16px');
    expect(cssText).toContain('.Hoverable:hover');
    expect(cssText).not.toContain('40 px');
    expect(cssText).not.toContain('16 px');
    expect(cssText).not.toContain('.Hoverable :hover');
  });

  it('removes imports that become unused after processor replacement', () => {
    const result = collectOxcRuntime(
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './theme';
        import { keep } from './runtime';

        export const className = css\`
          color: ${'${color}'};
        \`;

        console.log(keep);
      `,
      filename,
      __dirname,
      createOptions(),
      new Map([['_exp', 'red']])
    );

    expect(result.code).not.toContain(`from 'test-css-processor'`);
    expect(result.code).not.toContain(`from './theme'`);
    expect(result.code).toContain(`from './runtime'`);
  });

  it('formats cleaned runtime object arguments without extra top-level blank lines', () => {
    const result = collectOxcRuntime(
      dedent`
        import React from 'react';
        import { css } from 'test-css-processor';

        const color = 'red';

        export default function Component() {
          const shadow = 'blue';
          const val = { shadow };
          return React.createElement('div', {className: css\`color:${'${val.shadow}'};\`});
        }
      `,
      join(__dirname, 'shadowed-runtime.js'),
      __dirname,
      createOptions(),
      new Map([['_exp', 'blue']])
    );

    expect(result.code).toContain(`return React.createElement('div', {
    className: "`);
    expect(result.code).not.toContain(`import React from 'react';

const color = 'red';`);
  });

  it('preserves object methods when normalizing call-argument objects', () => {
    const result = collectOxcRuntime(
      dedent`
        const customNodes = factory({
          ...baseNodes.get('heading'),
          toDOM(node: Node) {
            return ['blockquote', { class: Blockquote }, 0];
          },
        });
      `,
      join(__dirname, 'method-runtime.ts'),
      __dirname,
      createOptions(),
      new Map()
    );

    expect(result.code).toContain(`toDOM(node: Node) {`);
    expect(result.code).not.toContain(`toDOM: (node: Node) {`);
  });

  it('keeps exported interpolation values after processor replacement', () => {
    const result = collectOxcRuntime(
      dedent`
        import { css } from 'test-css-processor';

        export const tone = 'red';
        export const className = css\`
          color: ${'${tone}'};
        \`;
      `,
      join(__dirname, 'exported-runtime-value.js'),
      __dirname,
      createOptions(),
      new Map([['_exp', 'red']])
    );

    expect(result.code).toContain(`export const tone = 'red';`);
    expect(result.code).toContain(`export const className = "`);
  });

  it('preserves surviving import specifiers when adjacent removable ones are pruned', () => {
    const result = collectOxcRuntime(
      dedent`
        import { css } from 'test-css-processor';
        import { ellipsis, mobileBreakpoint, Rotate90 } from './mixins';

        export const className = css\`
          ${'${ellipsis}'};
          @media ${'${mobileBreakpoint}'} {
            color: red;
          }
        \`;

        console.log(Rotate90);
      `,
      join(__dirname, 'import-prune-runtime.js'),
      __dirname,
      createOptions(),
      new Map([
        ['_exp', { overflow: 'hidden' }],
        ['_exp2', 'screen and (min-width: 1px)'],
      ])
    );

    expect(result.code).toContain(`import { Rotate90 } from './mixins';`);
    expect(result.code).toContain(`console.log(Rotate90);`);
    expect(result.code).not.toContain(`import { otate90 }`);
  });

  it('terminates exported variable declarations during runtime normalization', () => {
    const result = collectOxcRuntime(
      dedent`
        export const value = 1
      `,
      join(__dirname, 'styled-runtime.js'),
      __dirname,
      createOptions(),
      new Map()
    );

    expect(result.code).toContain('export const value = 1;');
  });

  it('formats preserved nested object declarations tightly between statements', () => {
    const result = collectOxcRuntime(
      dedent`
        import { css } from 'test-css-processor';

        const objects = { font: { fontSize: 12 }, box: { border: '1px solid red' } };

        objects.font.fontWeight = 'bold';

        export const whiteColor = '#fff';
        export const className = css\`
          color: ${'${whiteColor}'};
        \`;
      `,
      join(__dirname, 'nested-objects-runtime.js'),
      __dirname,
      createOptions(),
      new Map([['_exp', '#fff']])
    );

    expect(result.code).toContain(`const objects = {
  font: {
    fontSize: 12
  },
  box: {
    border: '1px solid red'
  }
};
objects.font.fontWeight = 'bold';
export const whiteColor = '#fff';`);
  });

  it('does not recreate processors from exported class maps used in selector helpers', () => {
    const result = collectOxcRuntime(
      dedent`
        import { css } from 'test-css-processor';

        const sizes = {
          title: { fontSize: '24px' },
          small: { fontSize: '15px' },
        };

        export const classes = {
          small: css\`\`,
          contrast: css\`\`,
        };

        export const title = css\`
          font-size: ${'${sizes.title.fontSize}'};

          &.${'${classes.small}'} {
            font-size: ${'${sizes.small.fontSize}'};
          }

          &.${'${classes.contrast}'} {
            color: red;
          }
        \`;
      `,
      join(__dirname, 'selector-helper-runtime.tsx'),
      __dirname,
      createOptions(),
      new Map([
        ['_exp', '24px'],
        ['_exp2', 'CLASS_SMALL'],
        ['_exp3', '15px'],
        ['_exp4', 'CLASS_CONTRAST'],
      ])
    );

    const processors = result.metadata?.processors ?? [];
    const titleProcessor = processors.find(
      (processor) => processor.displayName === 'title'
    );
    const titleCssText =
      titleProcessor?.artifacts[0]?.[1]?.[0]?.[`.${titleProcessor.className}`]
        ?.cssText ?? '';

    expect(processors).toHaveLength(3);
    expect(processors.map((processor) => processor.displayName)).toStrictEqual([
      'small',
      'contrast',
      'title',
    ]);
    expect(titleCssText).toContain('font-size: 24px;');
    expect(titleCssText).toContain('&.CLASS_SMALL');
    expect(titleCssText).toContain('font-size: 15px;');
    expect(titleCssText).toContain('&.CLASS_CONTRAST');
  });

  it('is used by collect action for explicit oxcShaker entrypoints', () => {
    const options = createOptions();
    const services = withDefaultServices({
      options: {
        filename,
        root: __dirname,
        pluginOptions: options,
      },
    });
    const source = dedent`
      import { css } from 'test-css-processor';
      const color = 'red';
      export const className = css\`
        color: ${'${color}'};
      \`;
    `;
    const entrypoint = Entrypoint.createRoot(
      services,
      filename,
      ['className'],
      source
    );

    if (entrypoint.ignored) {
      throw new Error('Ignored');
    }

    const result = syncActionRunner(
      entrypoint.createAction(
        'collect',
        {
          prevalPayload: createPrevalPayload({
            evalValues: new Map([['_exp', 'red']]),
            filename,
            strategy: 'hybrid',
          }),
        },
        null
      ),
      getHandlers<'sync'>({
        collect,
      })
    );

    expect(result.metadata?.processors).toHaveLength(1);
    expect(result.code).not.toContain('css`');
    expect(result.map?.sources).toContain(filename);
  });

  it('composes runtime source maps with the incoming source map', () => {
    const originalSource = dedent`
      import { css } from 'test-css-processor';
      export const className = css\`
        color: ${'${"red"}'};
      \`;
    `;
    const result = collectOxcRuntime(
      dedent`
        import { css } from 'test-css-processor';
        export const className = css\`
          color: ${'${"red"}'};
        \`;
      `,
      filename,
      __dirname,
      createOptions(),
      new Map([['_exp', 'red']]),
      createInputSourceMap(filename, originalFilename, originalSource)
    );

    expect(result.map.sources).toContain(originalFilename);
    expect(result.map.sources).not.toContain(filename);
    expect(result.map.sourcesContent).toContain(originalSource);
  });

  it('forwards input source maps through collect action', () => {
    const options = createOptions();
    const originalSource = dedent`
      import { css } from 'test-css-processor';
      export const className = css\`
        color: ${'${"red"}'};
      \`;
    `;
    const services = withDefaultServices({
      options: {
        filename,
        inputSourceMap: createInputSourceMap(
          filename,
          originalFilename,
          originalSource
        ),
        root: __dirname,
        pluginOptions: options,
      },
    });
    const source = dedent`
      import { css } from 'test-css-processor';
      export const className = css\`
        color: ${'${"red"}'};
      \`;
    `;
    const entrypoint = Entrypoint.createRoot(
      services,
      filename,
      ['className'],
      source
    );

    if (entrypoint.ignored) {
      throw new Error('Ignored');
    }

    const result = syncActionRunner(
      entrypoint.createAction(
        'collect',
        {
          prevalPayload: createPrevalPayload({
            evalValues: new Map([['_exp', 'red']]),
            filename,
            strategy: 'hybrid',
          }),
        },
        null
      ),
      getHandlers<'sync'>({
        collect,
      })
    );

    expect(result.map?.sources).toContain(originalFilename);
    expect(result.map?.sources).not.toContain(filename);
    expect(result.map?.sourcesContent).toContain(originalSource);
  });

  it('returns null metadata when no processors are present', () => {
    const result = collectOxcRuntime(
      `export const value = 1;`,
      filename,
      __dirname,
      createOptions(),
      new Map()
    );

    expect(result).toEqual({
      code: `export const value = 1;`,
      map: expect.objectContaining({
        sources: [filename],
        sourcesContent: [`export const value = 1;`],
      }),
      metadata: null,
    });
  });

  it('normalizes a blank line after leading flow block comments', () => {
    const result = collectOxcRuntime(
      dedent`
        /* @flow */
        export const value = 1;
      `,
      filename,
      __dirname,
      createOptions(),
      new Map()
    );

    expect(result.code).toBe(`/* @flow */\n\nexport const value = 1;`);
  });

  it('preserves blank lines after comments while collapsing other blank runs', () => {
    const result = collectOxcRuntime(
      [
        '',
        'export const first = 1;',
        '',
        '  ',
        '// Keep this comment separated from the following declaration.',
        '',
        '',
        'export const second = 2;',
        '',
        '/* Keep this block comment separated too. */',
        '',
        '\t',
        'export const third = 3;',
        '',
        '',
      ].join('\n'),
      filename,
      __dirname,
      createOptions(),
      new Map()
    );

    expect(result.code).toBe(
      [
        'export const first = 1;',
        '// Keep this comment separated from the following declaration.',
        '',
        'export const second = 2;',
        '/* Keep this block comment separated too. */',
        '',
        'export const third = 3;',
      ].join('\n')
    );
  });

  it('does not append a semicolon after exported function declarations', () => {
    const result = collectOxcRuntime(
      dedent`
        export function Something() {
          return 1;
        }
      `,
      filename,
      __dirname,
      createOptions(),
      new Map()
    );

    expect(result.code).toBe(`export function Something() {\n  return 1;\n}`);
  });
});
