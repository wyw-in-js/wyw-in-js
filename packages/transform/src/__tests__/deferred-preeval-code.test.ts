import {
  registerPipelineTelemetryReporter,
  runWithPipelineTelemetry,
  type PipelineTelemetrySummary,
} from '../debug/pipelineTelemetry';
import type { IPreevalResult } from '../transform/Entrypoint.types';
import { deferStaticPreevalCode } from '../transform/generators/resolveStaticOxcValues/deferredCode';
import { resolveStaticOxcPreevalValues } from '../transform/generators/resolveStaticOxcValues/resolveStaticOxcPreevalValues';
import type { ITransformAction } from '../transform/types';
import { oxcShaker } from '../shaker';
import { EventEmitter } from '../utils/EventEmitter';
import { deferOxcPreevalCode } from '../utils/oxcPreevalStage/deferredCode';

const filename = '/project/deferred-preeval-code.ts';

const measureParses = <T>(callback: () => T) => {
  const emitter = new EventEmitter(
    () => {},
    () => 0,
    () => {}
  );
  let summary: PipelineTelemetrySummary | undefined;
  const unregister = registerPipelineTelemetryReporter(emitter, (value) => {
    summary = value;
  });
  try {
    const value = runWithPipelineTelemetry(
      emitter,
      () => ({ filename }),
      callback
    );
    return { parse: summary!.parse, value };
  } finally {
    unregister();
  }
};

const createResult = (baseCode: string): IPreevalResult => ({
  ast: null,
  baseCode,
  code: '',
  dependencyNames: [],
  metadata: null,
});

describe('deferred preeval code', () => {
  it('memoizes demand and supports replacement and refreshed suppliers', () => {
    const result = createResult('');
    const serialize = jest.fn(() => 'first');
    deferOxcPreevalCode(result, 'code', serialize);

    expect(serialize).not.toHaveBeenCalled();
    expect(Object.keys(result)).toContain('code');
    expect(result.code).toBe('first');
    expect(result.code).toBe('first');
    expect(serialize).toHaveBeenCalledTimes(1);

    result.code = 'override';
    expect(result.code).toBe('override');
    deferOxcPreevalCode(result, 'code', () => 'refreshed');
    expect(result.code).toBe('refreshed');
  });

  it('does not cache a failed serialization', () => {
    const result = createResult('');
    let attempts = 0;
    deferOxcPreevalCode(result, 'code', () => {
      attempts += 1;
      if (attempts === 1) throw new Error('retry');
      return 'valid';
    });

    expect(() => result.code).toThrow('retry');
    expect(result.code).toBe('valid');
    expect(result.code).toBe('valid');
    expect(attempts).toBe(2);
  });

  it.each(['code', 'evalCode'] as const)(
    'defers pruning and shares identical executable projections when %s is read first',
    (first) => {
      const baseCode =
        "import { color } from './colors';\nconst _exp = () => color;\nexport const item = 'class';";
      const result = createResult(baseCode);
      const values = new Set(['_exp']);
      const imports = new Set(['color']);
      const install = measureParses(() =>
        deferStaticPreevalCode(
          result,
          filename,
          values,
          imports,
          new Map(),
          new Set()
        )
      );

      expect(install.parse.allRequests).toBe(0);
      expect(result.baseCode).toBe(baseCode);
      values.clear();
      imports.clear();
      result.dependencyNames!.push('later');

      // Pruning and the preval export parse on the first read, all through
      // the shared parse cache.
      const demand = measureParses(() => result[first]);
      expect(demand.parse.allRequests).toBe(3);
      expect(demand.parse.uncachedRequests).toBe(0);
      expect(demand.value).toBe(
        "\n\nexport const item = 'class';\nexport const __wywPreval = {};"
      );
      const repeated = measureParses(() => [result.code, result.evalCode]);
      expect(repeated.parse.allRequests).toBe(0);
      expect(repeated.value).toEqual([demand.value, demand.value]);
      expect(result.baseCode).toBe(baseCode);
    }
  );

  it.each(['code', 'evalCode'] as const)(
    'keeps distinct side-effect projections when %s is read first',
    (first) => {
      const baseCode =
        "import { first } from './first';\nimport { second } from './second';\nconst _exp = () => [first, second];\nexport const item = 'class';";
      const result = createResult(baseCode);
      const sideEffects = new Set(['second', 'first']);
      const install = measureParses(() =>
        deferStaticPreevalCode(
          result,
          filename,
          new Set(['_exp']),
          new Set(['first', 'second']),
          new Map(),
          sideEffects
        )
      );

      expect(install.parse.allRequests).toBe(0);
      sideEffects.clear();
      // Pruning and the preval export parse on the first read, all through
      // the shared parse cache.
      const demand = measureParses(() => result[first]);
      expect(demand.parse.allRequests).toBe(3);
      expect(demand.parse.uncachedRequests).toBe(0);
      expect(result.code).toBe(
        "import './first';\nimport './second';\n\n\nexport const item = 'class';\nexport const __wywPreval = {};"
      );
      expect(result.evalCode).toBe(
        "\n\n\nexport const item = 'class';\nexport const __wywPreval = {};"
      );
      expect(result.baseCode).toBe(baseCode);
      const repeated = measureParses(() => [result.code, result.evalCode]);
      expect(repeated.parse.allRequests).toBe(0);
    }
  );

  it('retains earlier CSS side-effect provenance across partial and full static resolution', () => {
    const baseCode =
      "import { className } from './artifact';\nimport { width } from './width';\nconst _exp = () => className;\nconst _exp2 = () => width;\nexport const item = 'class';";
    const result = createResult(baseCode);
    result.dependencyNames = ['_exp', '_exp2'];
    result.staticValueCache = new Map([['_exp', 'shared-class']]);
    result.staticSideEffectImportLocals = ['className'];
    result.staticValueCandidates = [
      {
        imports: [
          { imported: 'className', local: 'className', source: './artifact' },
        ],
        name: '_exp',
        source: 'className',
      },
      {
        imports: [{ imported: 'width', local: 'width', source: './width' }],
        name: '_exp2',
        source: 'width',
      },
    ];
    const staticBindings: Record<string, Record<string, unknown>> = {};
    const action = {
      entrypoint: {
        getPreevalResult: () => result,
        loadedAndParsed: {
          evalConfig: { filename },
          evaluator: oxcShaker,
        },
        name: filename,
      },
      // eslint-disable-next-line require-yield
      getNext: function* resolveMissingImport() {
        return [];
      },
      services: {
        eventEmitter: EventEmitter.dummy,
        options: {
          filename,
          pluginOptions: { eval: { strategy: 'hybrid' }, staticBindings },
        },
      },
    } as unknown as ITransformAction;

    expect(resolveStaticOxcPreevalValues.call(action).next()).toEqual({
      done: true,
      value: true,
    });
    expect(result.dependencyNames).toEqual(['_exp2']);
    expect(result.code).toContain("import './artifact';");
    expect(result.code).toContain('__wywPreval = { _exp2: _exp2 }');
    expect(result.baseCode).toBe(baseCode);

    staticBindings['./width'] = { width: 42 };
    expect(resolveStaticOxcPreevalValues.call(action).next()).toEqual({
      done: true,
      value: true,
    });
    expect(result.dependencyNames).toEqual([]);
    expect(result.staticSideEffectImportLocals).toEqual(['className']);
    expect(result.code).toContain("import './artifact';");
    expect(result.code).not.toContain("from './width'");
    expect(result.code).toContain('__wywPreval = {};');
    expect(result.baseCode).toBe(baseCode);
  });

  it('captures metadata values before later processor mutations', () => {
    const baseCode =
      "const _exp = () => Base;\nexport const item = { __wyw_meta: { className: 'item', extends: _exp() } };";
    const result = createResult(baseCode);
    const extended = { __wyw_meta: { className: 'base', extends: null } };
    const metadata = { __wyw_meta: { className: 'middle', extends: extended } };
    const values = new Map<string, unknown>([['_exp', metadata]]);
    deferStaticPreevalCode(
      result,
      filename,
      new Set(['_exp']),
      new Set(),
      values,
      new Set()
    );

    metadata.__wyw_meta.className = 'changed-middle';
    extended.__wyw_meta.className = 'changed-base';
    values.clear();
    expect(result.code).toContain('"className":"middle"');
    expect(result.code).toContain('"className":"base"');
    expect(result.code).not.toContain('changed-');
    expect(result.code).not.toContain('_exp');
  });
});
