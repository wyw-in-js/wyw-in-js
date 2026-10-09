/* eslint-env jest */
import path from 'path';

import type { StrictOptions } from '@wyw-in-js/shared';

import {
  registerPipelineTelemetryReporter,
  runWithPipelineTelemetry,
  type PipelineTelemetrySummary,
} from '../debug/pipelineTelemetry';
import { EventEmitter } from '../utils/EventEmitter';
import { runOxcPreevalStage } from '../utils/oxcPreevalStage';
import { shakeOxcToESM } from '../utils/oxcShaker';

const processorPath = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);
const linariaStyledProcessorPath = path.resolve(
  __dirname,
  '__fixtures__',
  'test-styled-processor.js'
);

const fileContext = {
  filename: path.join(__dirname, 'source.tsx'),
  root: __dirname,
};

const options: Pick<
  StrictOptions,
  | 'classNameSlug'
  | 'codeRemover'
  | 'displayName'
  | 'eval'
  | 'extensions'
  | 'features'
  | 'tagResolver'
> = {
  codeRemover: {},
  displayName: false,
  eval: { strategy: 'hybrid' },
  extensions: ['.tsx'],
  features: {
    dangerousCodeRemover: true,
  },
  tagResolver: (source, imported) => {
    if (source !== 'test-package' || imported !== 'css') {
      return null;
    }

    return processorPath;
  },
};

const linariaOptions: Pick<
  StrictOptions,
  | 'classNameSlug'
  | 'codeRemover'
  | 'displayName'
  | 'extensions'
  | 'features'
  | 'tagResolver'
> = {
  ...options,
  extensions: ['.js', '.ts', '.tsx'],
  tagResolver: (source, imported) => {
    if (source === '@linaria/react' && imported === 'styled') {
      return linariaStyledProcessorPath;
    }

    return null;
  },
};

describe('runOxcPreevalStage', () => {
  it.each(['static', 'hybrid', 'execute'] as const)(
    'serializes %s executable exports only on demand and refreshes after callbacks',
    (strategy) => {
      const emitter = new EventEmitter(
        () => {},
        () => 0,
        () => {}
      );
      const summaries: PipelineTelemetrySummary[] = [];
      const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
        summaries.push(summary)
      );
      const measure = <T>(callback: () => T) =>
        runWithPipelineTelemetry(
          emitter,
          () => ({ filename: fileContext.filename }),
          callback
        );

      try {
        const result = measure(() =>
          runOxcPreevalStage(
            "import { css } from 'test-package'; const color = 'red'; export const deferred = css`color: ${color};`;",
            fileContext,
            { ...options, eval: { strategy } }
          )
        );
        expect(summaries.at(-1)!.parse.uncachedRequests).toBe(0);
        expect(result.metadata?.processors).toHaveLength(1);
        expect(result.dependencyNames).toEqual(
          strategy === 'execute' ? ['_exp'] : []
        );

        // Serializing parses the code once, through the shared parse cache.
        const originalCode = measure(() => result.code);
        expect(summaries.at(-1)!.parse.allRequests).toBe(1);
        expect(summaries.at(-1)!.parse.uncachedRequests).toBe(0);
        expect(measure(() => result.code)).toBe(originalCode);
        expect(summaries.at(-1)!.parse.allRequests).toBe(0);

        const processor = result.metadata!.processors[0];
        const replace = processor.doEvaltimeReplacement.bind(processor);
        processor.doEvaltimeReplacement = jest.fn(replace);
        result.dependencyNames = [];
        measure(
          () => result.finalizeEvaltimeReplacements?.(result.staticValueCache)
        );
        expect(summaries.at(-1)!.parse.uncachedRequests).toBe(0);
        expect(processor.doEvaltimeReplacement).toHaveBeenCalledTimes(1);
        const finalizedCode = measure(() => result.code);
        expect(summaries.at(-1)!.parse.allRequests).toBe(1);
        expect(finalizedCode).not.toContain('css`');
        expect(finalizedCode).toContain('export const __wywPreval = {};');
        expect(finalizedCode).not.toBe(originalCode);

        measure(() => result.finalizeEvaltimeReplacements?.());
        expect(processor.doEvaltimeReplacement).toHaveBeenCalledTimes(1);
        expect(measure(() => result.code)).toBe(finalizedCode);
        expect(summaries.at(-1)!.parse.allRequests).toBe(0);
      } finally {
        unregister();
      }
    }
  );

  it('uses eval.strategy to keep static values out of __wywPreval', () => {
    const result = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        const color = 'red';
        export const a = css\`
          color: ${'${color}'};
        \`;
      `,
      fileContext,
      {
        ...options,
        eval: { strategy: 'hybrid' },
        features: {
          dangerousCodeRemover: true,
        },
      } as typeof options
    );

    expect(result.staticValueCache.get('_exp')).toBe('red');
    expect(result.staticPlanFacts).toEqual({
      importedNeeds: [],
      staticValueCount: 1,
      unresolvedCount: 0,
      usageCount: 1,
    });
    expect(result.code).toContain('export const __wywPreval = {};');
    expect(result.code).not.toContain('__wywPreval = { _exp: _exp }');
  });

  it('keeps execute dependencies evaluator-owned after finalization', () => {
    const result = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        const color = 'red';
        export const a = css\`
          color: ${'${color}'};
        \`;
      `,
      fileContext,
      {
        ...options,
        eval: { strategy: 'execute' },
        features: {
          dangerousCodeRemover: true,
        },
      } as typeof options
    );

    expect(result.staticValueCache.has('_exp')).toBe(false);
    expect(result.dependencyNames).toEqual(['_exp']);
    expect(result.code).toContain('__wywPreval = { _exp: _exp }');

    result.finalizeEvaltimeReplacements?.(result.staticValueCache);

    expect(result.staticValueCache).toEqual(new Map());
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['_exp']);
    expect(result.code).toContain('__wywPreval = { _exp: _exp }');
  });

  it('keeps only unresolved dependencies in __wywPreval for hybrid strategy', () => {
    const result = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        const color = 'red';
        const spacing = getSpacing();
        export const a = css\`
          color: ${'${color}'};
          margin: ${'${spacing}'};
        \`;
      `,
      fileContext,
      {
        ...options,
        eval: { strategy: 'hybrid' },
        features: {
          dangerousCodeRemover: true,
        },
      } as typeof options
    );

    expect(result.staticValueCache.get('_exp')).toBe('red');
    expect(result.dependencyNames).toEqual(['_exp2']);
    expect(result.code).toContain('__wywPreval = { _exp2: _exp2 }');
    expect(result.code).not.toContain('_exp: _exp');
  });

  it('keeps unresolved static-strategy dependencies for final validation', () => {
    const result = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        const color = getColor();
        export const a = css\`
          color: ${'${color}'};
        \`;
      `,
      fileContext,
      {
        ...options,
        eval: { strategy: 'static' },
        features: {
          dangerousCodeRemover: true,
        },
      } as typeof options
    );

    expect(result.dependencyNames).toEqual(['_exp']);
    expect(result.code).toContain('__wywPreval = { _exp: _exp }');
  });

  it('applies eval-time replacement and synthesizes __wywPreval dependencies', () => {
    const result = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        const color = import.meta.env.DEV ? 'red' : 'blue';
        export const a = css\`
          color: ${'${color}'};
        \`;
      `,
      fileContext,
      options
    );
    result.finalizeEvaltimeReplacements?.(result.staticValueCache);

    expect(result.metadata?.processors).toHaveLength(1);
    expect(result.code).toContain('__wyw_import_meta_env.DEV');
    expect(result.code).toContain('export const __wywPreval = { _exp: _exp };');
    expect(result.code).not.toContain('css`');
  });

  it('adds empty __wywPreval for processor files without dependencies', () => {
    const result = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        export const a = css\`
          color: red;
        \`;
      `,
      fileContext,
      options
    );

    expect(result.metadata?.processors).toHaveLength(1);
    expect(result.code).toContain('export const __wywPreval = {};');
  });

  it('keeps statically evaluated local constants out of __wywPreval', () => {
    const result = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        const color = 'red';
        export const a = css\`
          color: ${'${color}'};
        \`;
      `,
      fileContext,
      options
    );

    expect(result.staticValueCache.get('_exp')).toBe('red');
    expect(result.code).toContain('export const __wywPreval = {};');
    expect(result.code).not.toContain('__wywPreval = { _exp: _exp }');
  });

  it('ignores deferred component hazards before dangerous code removal', () => {
    const source = `
      import { css } from 'test-package';
      import { observer } from 'mobx-react-lite';
      import * as tokens from './tokens';
      import { jsx as _jsx } from 'react/jsx-runtime';

      const Component = observer(() =>
        _jsx('div', { children: tokens.runtime })
      );

      export const a = css\`
        color: ${'${tokens.color}'};
      \`;
    `;
    const enabled = runOxcPreevalStage(source, fileContext, options);
    const disabled = runOxcPreevalStage(source, fileContext, {
      ...options,
      features: {
        dangerousCodeRemover: false,
      },
    });

    [enabled, disabled].forEach((result) => {
      expect(result.staticValueCandidates).toEqual([
        expect.objectContaining({
          imports: [
            expect.objectContaining({
              imported: 'color',
              source: './tokens',
            }),
          ],
          source: expect.stringContaining('_wyw_static_tokens_color'),
        }),
      ]);
    });
  });

  it('keeps processors in removed components runtime-only', () => {
    const result = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        import { jsx as _jsx } from 'react/jsx-runtime';

        const color = 'red';
        export function Component() {
          const className = css\`
            color: ${'${color}'};
          \`;

          return _jsx('div', { className });
        }
      `,
      fileContext,
      options
    );
    const [processor] = result.metadata?.processors ?? [];
    let evaltimeReplacementCalled = false;

    expect(processor).toBeDefined();
    processor!.doEvaltimeReplacement = () => {
      evaltimeReplacementCalled = true;
    };

    result.finalizeEvaltimeReplacements?.(result.staticValueCache);

    expect(evaltimeReplacementCalled).toBe(false);
    expect(result.staticValueCache.get('_exp')).toBe('red');
    expect(result.code).toContain('function Component() { return null; }');
  });

  it('still applies preeval syntax rewrites when no processors are present', () => {
    const result = runOxcPreevalStage(
      `
        const href = window.location.href;
        const mode = import.meta.env.MODE;
        import(dep);
        require(dep);
      `,
      fileContext,
      options
    );

    expect(result.metadata).toBeNull();
    expect(result.code).not.toContain('window.location');
    expect(result.code).toContain('__wyw_import_meta_env.MODE');
    expect(result.code).toContain('__wyw_dynamic_import(dep)');
    expect(result.code).toContain('require(dep, true)');
  });

  it('emits perf sublabels for the Oxc preeval substeps', () => {
    const methods: string[] = [];
    const eventEmitter = new EventEmitter(
      (labels, type) => {
        if (type === 'start' && typeof labels.method === 'string') {
          methods.push(labels.method);
        }
      },
      () => 0,
      () => {}
    );

    const result = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        const href = window.location.href;
        const mode = import.meta.env.MODE;
        const dep = './dep';
        export const a = css\`
          color: ${'${mode}'};
        \`;
        import(dep);
        require(dep);
      `,
      fileContext,
      {
        ...options,
        eventEmitter,
      }
    );
    result.finalizeEvaltimeReplacements?.(result.staticValueCache);

    expect(methods).toEqual(
      expect.arrayContaining([
        'transform:preeval:processTemplate',
        'transform:preeval:processTemplate:imports',
        'transform:preeval:processTemplate:imports:analysis',
        'transform:preeval:processTemplate:imports:lookup',
        'transform:preeval:processTemplate:usages',
        'transform:preeval:processTemplate:deps',
        'transform:preeval:processTemplate:usedNames',
        'transform:preeval:processTemplate:processors',
        'transform:preeval:importMetaEnv',
        'transform:preeval:removeDangerousCode',
        'transform:preeval:dynamicImport',
        'transform:preeval:requireFallback',
      ])
    );
    expect(
      methods.filter(
        (method) => method === 'transform:preeval:removeDangerousCode'
      )
    ).toHaveLength(1);
  });

  it('feeds Oxc shaker with __wywPreval-only prepared code', () => {
    const preeval = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        import runtimeOnly from 'runtime-only';

        const color = 'red';
        export const className = css\`
          color: ${'${color}'};
        \`;
        export const runtime = runtimeOnly;
      `,
      fileContext,
      options
    );
    const shaken = shakeOxcToESM(preeval.code, fileContext.filename, {
      onlyExports: ['__wywPreval'],
    });

    expect(shaken.code).toContain('export const __wywPreval');
    expect(shaken.code).not.toContain('const _exp =');
    expect(shaken.code).not.toContain('test-package');
    expect(shaken.code).not.toContain('runtime-only');
    expect(shaken.code).not.toContain('export const className');
    expect(shaken.imports.size).toBe(0);
  });

  it('keeps wrapped styled-component metadata dependencies through preeval and shaking', () => {
    const preeval = runOxcPreevalStage(
      `
        import { styled } from '@linaria/react';
        import Base from './base';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `,
      {
        ...fileContext,
        filename: path.join(__dirname, 'styled-wrap.tsx'),
      },
      linariaOptions
    );
    const shaken = shakeOxcToESM(
      preeval.code,
      path.join(__dirname, 'styled-wrap.tsx'),
      {
        onlyExports: ['__wywPreval'],
      }
    );

    expect(preeval.code).toContain(
      'export const __wywPreval = { _exp: _exp };'
    );
    expect(shaken.code).toContain('export const __wywPreval = { _exp: _exp };');
    expect(shaken.code).toContain('const _exp =');
  });

  it('expands shorthand properties when constant-substituting mixed object literals in css expressions', () => {
    // Reproduces: `{ width, ...textStyles.regular }` → `{ 500, ...textStyles.regular }`
    // when `width` is a constant and `textStyles` is an import.
    // The shorthand `width` must expand to `width: 500` to keep the object valid.
    const source = [
      "import { css } from 'test-package';",
      "import { textStyles } from './design-system';",
      'const width = 500;',
      'export const a = css`',
      '  ${{ width, ...textStyles.regular }}',
      '`;',
    ].join('\n');

    const result = runOxcPreevalStage(source, fileContext, options);

    expect(result.code).toContain('width: 500');
    expect(result.code).not.toMatch(/\{\s*500\s*,/);
  });

  it('expands shorthand string constants in mixed object literals in css expressions', () => {
    const source = [
      "import { css } from 'test-package';",
      "import { space } from './design-system';",
      'const display = "flex";',
      'export const a = css`',
      '  ${{ display, gap: space.s8 }}',
      '`;',
    ].join('\n');

    const result = runOxcPreevalStage(source, fileContext, options);

    expect(result.code).toContain('display: "flex"');
    expect(result.code).toContain('gap: space.s8');
  });
});
