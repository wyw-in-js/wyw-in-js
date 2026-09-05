import { oxcShaker } from '../../shaker';
import type { WYWTransformMetadata } from '../../utils/TransformMetadata';
import { collectOxcExportsAndImports } from '../../utils/collectOxcExportsAndImports';
import { collectOxcImportMap } from '../../utils/oxcImportMap';
import { emitOxcCommonJS, stripTypesAndJsxWithOxc } from '../../utils/oxcEmit';
import { runOxcPreevalStage } from '../../utils/oxcPreevalStage';
import { shakeOxcToESM } from '../../utils/oxcShaker';
import type { Entrypoint } from '../Entrypoint';
import type {
  IEntrypointDependency,
  IPreevalResult,
} from '../Entrypoint.types';
import type {
  ITransformAction,
  Services,
  SyncScenarioFor,
  SyncScenarioForAction,
} from '../types';

import {
  buildStaticPlanAttribution,
  emitStaticPlanDebug,
} from '../static-plan/buildStaticPlan';
import { rewriteOptimizedOxcBarrelImports } from './rewriteOxcBarrelImports';
import { resolveStaticOxcPreevalValues } from './resolveStaticOxcValues';
import {
  beginPipelineShake,
  finishPipelineShake,
  recordPipelineLateNoMetadata,
} from '../../debug/pipelineTelemetry';
import type { EvalPreparationToken } from '../../debug/evalTelemetry.types';
import { AbortError } from '../actions/AbortError';

const EMPTY_FILE = '=== empty file ===';

type PrepareCodeFn = (
  services: Services,
  item: Entrypoint,
  originalAst: unknown | null
) => [
  code: string,
  imports: Map<string, string[]> | null,
  metadata: WYWTransformMetadata | null,
];

const isPrevalOnly = (only: string[]) =>
  only.length === 1 && only[0] === '__wywPreval';

const hasWywPrevalExport = (code: string, filename: string): boolean =>
  Object.hasOwn(
    collectOxcExportsAndImports(code, filename).exports,
    '__wywPreval'
  );

export const emitCurrentStaticPlanDebug = (
  action: ITransformAction,
  imports: Map<string, string[]> | null
): void => {
  if (!action.services.eventEmitter.hasEventListener('staticPlan')) {
    return;
  }

  const { loadedAndParsed } = action.entrypoint;
  if (loadedAndParsed.evaluator === 'ignored') {
    return;
  }

  const preevalResult = action.entrypoint.getPreevalResult();
  if (!preevalResult?.staticPlanFacts) {
    return;
  }

  const filename =
    loadedAndParsed.evalConfig.filename ?? action.entrypoint.name;
  const attribution = buildStaticPlanAttribution({
    filename,
    preparedImports: imports,
    preevalResult,
    staticPlanFacts: preevalResult.staticPlanFacts,
  });

  emitStaticPlanDebug(action.services.eventEmitter, {
    attribution,
    filename,
  });
};

type PrepareCodeOptions = {
  emitCommonJS?: boolean;
  evalTelemetry?: EvalPreparationToken;
  shortCircuitOnMissingMetadata?: boolean;
  stripForEvalRuntime?: boolean;
};

const normalizeOxcPreparedESM = (code: string): string =>
  code
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/[ \t\n]+$/, '')
    .replace(/\n{2,}/g, '\n')
    .replace(/^const /gm, 'var ');

const ensureOxcPreevalResult = (
  services: Services,
  item: Entrypoint,
  originalAst: unknown | null
): IPreevalResult => {
  const cached = item.getPreevalResult();
  if (cached) {
    return cached;
  }

  const { loadedAndParsed } = item;
  if (loadedAndParsed.evaluator === 'ignored') {
    throw new Error('Cannot run Oxc preeval for an ignored entrypoint.');
  }

  const filename = loadedAndParsed.evalConfig.filename ?? item.name;
  const { eventEmitter } = services;
  const { pluginOptions } = services.options;
  const root = services.options.root ?? process.cwd();
  const servicesEpoch = services.cacheEpoch ?? services.cache.getCurrentEpoch();

  const preevalStageResult = eventEmitter.perf('transform:preeval', () => {
    const result = runOxcPreevalStage(
      loadedAndParsed.code,
      {
        filename,
        root,
      },
      {
        ...pluginOptions,
        eventEmitter,
      }
    );

    const preevalResult: IPreevalResult = {
      ast: originalAst,
      baseCode: result.baseCode,
      code: result.code,
      dependencyNames: result.dependencyNames,
      evalCode: result.code,
      metadata: result.metadata,
      processorClassNames: result.processorClassNames,
      pureCallHints: result.pureCallHints,
      runtimeProcessorPlan: result.runtimeProcessorPlan,
      staticImportLocals: [],
      staticSideEffectImportLocals: [],
      staticDependencies: result.staticDependencies,
      staticPlanFacts: result.staticPlanFacts,
      staticValuesApplied: false,
      staticValueCache: result.staticValueCache,
      staticValueCandidates: result.staticValueCandidates,
    };

    if (result.finalizeEvaltimeReplacements) {
      let evaltimeReplacementsFinalized = false;
      preevalResult.finalizeEvaltimeReplacements = (
        staticValueCache?: Map<string, unknown>
      ) => {
        if (evaltimeReplacementsFinalized) {
          return;
        }

        result.dependencyNames =
          preevalResult.dependencyNames ?? result.dependencyNames;
        result.finalizeEvaltimeReplacements?.(
          staticValueCache ?? preevalResult.staticValueCache
        );
        preevalResult.baseCode = result.baseCode;
        preevalResult.code = result.code;
        preevalResult.evalCode = result.code;
        preevalResult.metadata = result.metadata;
        preevalResult.staticValueCache = result.staticValueCache;
        preevalResult.staticValueCandidates = result.staticValueCandidates;
        evaltimeReplacementsFinalized = true;
      };
    }

    return preevalResult;
  });

  services.cache.assertEpoch(servicesEpoch);
  item.assertCurrentCacheEpoch();
  item.assertNotSuperseded();
  if (item.getPreevalResult() !== cached) {
    throw new AbortError('superseded');
  }
  item.setPreevalResult(preevalStageResult);
  return preevalStageResult;
};

const prepareOxcCodeImpl = (
  services: Services,
  item: Entrypoint,
  originalAst: unknown | null,
  options: PrepareCodeOptions = {}
): ReturnType<PrepareCodeFn> => {
  const { only, loadedAndParsed, log } = item;
  if (loadedAndParsed.evaluator === 'ignored') {
    log('is ignored');
    return [loadedAndParsed.code ?? '', null, null];
  }

  const filename = loadedAndParsed.evalConfig.filename ?? item.name;
  const { eventEmitter } = services;
  const { pluginOptions } = services.options;
  const root = services.options.root ?? process.cwd();

  const preevalStageResult = ensureOxcPreevalResult(
    services,
    item,
    originalAst
  );
  preevalStageResult.finalizeEvaltimeReplacements?.(
    preevalStageResult.staticValueCache
  );

  const transformMetadata = preevalStageResult.metadata;
  const preevalCode =
    options.stripForEvalRuntime && preevalStageResult.evalCode
      ? preevalStageResult.evalCode
      : preevalStageResult.code;
  if (
    isPrevalOnly(only) &&
    !transformMetadata &&
    !hasWywPrevalExport(preevalCode, filename) &&
    options.shortCircuitOnMissingMetadata !== false
  ) {
    log('[evaluator:end] no metadata');
    recordPipelineLateNoMetadata(filename, only, 'preeval');
    const strippedCode = options.evalTelemetry
      ? options.evalTelemetry.measureStage(
          'strip',
          () => stripTypesAndJsxWithOxc(preevalCode, filename).code
        )
      : stripTypesAndJsxWithOxc(preevalCode, filename).code;

    return [
      normalizeOxcPreparedESM(strippedCode),
      collectOxcImportMap(strippedCode, filename),
      null,
    ];
  }

  log('[preeval] metadata %O', transformMetadata);
  log('[evaluator:start] using %s', loadedAndParsed.evaluator.name);
  log.extend('source')('%s', preevalCode);

  const shakeToken = beginPipelineShake(
    preevalCode,
    only,
    options.stripForEvalRuntime ? 'eval-runtime' : 'transform'
  );
  let shaken: ReturnType<typeof shakeOxcToESM>;
  if (!shakeToken) {
    shaken = options.evalTelemetry
      ? options.evalTelemetry.measureStage('shake', () =>
          eventEmitter.perf('transform:evaluator', () =>
            shakeOxcToESM(preevalCode, filename, {
              importOverrides: pluginOptions.importOverrides,
              onlyExports: only,
              root,
            })
          )
        )
      : eventEmitter.perf('transform:evaluator', () =>
          shakeOxcToESM(preevalCode, filename, {
            importOverrides: pluginOptions.importOverrides,
            onlyExports: only,
            root,
          })
        );
  } else {
    try {
      shaken = options.evalTelemetry
        ? options.evalTelemetry.measureStage('shake', () =>
            eventEmitter.perf('transform:evaluator', () =>
              shakeOxcToESM(preevalCode, filename, {
                importOverrides: pluginOptions.importOverrides,
                onlyExports: only,
                root,
              })
            )
          )
        : eventEmitter.perf('transform:evaluator', () =>
            shakeOxcToESM(preevalCode, filename, {
              importOverrides: pluginOptions.importOverrides,
              onlyExports: only,
              root,
            })
          );
      finishPipelineShake(shakeToken, shaken.code, false);
    } catch (error) {
      finishPipelineShake(shakeToken, null, true);
      throw error;
    }
  }

  log('[evaluator:end]');

  if (!options.emitCommonJS) {
    let preparedCode = shaken.code;
    if (options.stripForEvalRuntime) {
      preparedCode = options.evalTelemetry
        ? options.evalTelemetry.measureStage(
            'strip',
            () => stripTypesAndJsxWithOxc(shaken.code, filename).code
          )
        : stripTypesAndJsxWithOxc(shaken.code, filename).code;
    }

    return [
      normalizeOxcPreparedESM(preparedCode),
      options.stripForEvalRuntime
        ? collectOxcImportMap(preparedCode, filename)
        : shaken.imports,
      transformMetadata ?? null,
    ];
  }

  const emitted = eventEmitter.perf('transform:emitCommonJS', () =>
    emitOxcCommonJS(shaken.code, filename)
  );

  return [emitted.code, shaken.imports, transformMetadata ?? null];
};

const prepareCodeImpl = (
  services: Services,
  item: Entrypoint,
  originalAst: unknown | null,
  options: PrepareCodeOptions = {}
): ReturnType<PrepareCodeFn> => {
  const { log, loadedAndParsed } = item;
  if (loadedAndParsed.evaluator === 'ignored') {
    log('is ignored');
    return [loadedAndParsed.code ?? '', null, null];
  }

  const { evaluator } = loadedAndParsed;
  if (evaluator !== oxcShaker) {
    throw new Error(
      `[wyw-in-js] ${item.name} matched a legacy evaluator. The Oxc runtime path supports only the default Oxc evaluator.`
    );
  }

  return prepareOxcCodeImpl(services, item, originalAst, options);
};

export const prepareCode = (
  services: Services,
  item: Entrypoint,
  originalAst: unknown | null
): ReturnType<PrepareCodeFn> => prepareCodeImpl(services, item, originalAst);

export const prepareCodeForEvalRuntime = (
  services: Services,
  item: Entrypoint,
  originalAst: unknown | null,
  evalTelemetry?: EvalPreparationToken
): ReturnType<PrepareCodeFn> =>
  prepareCodeImpl(services, item, originalAst, {
    evalTelemetry,
    shortCircuitOnMissingMetadata: true,
    stripForEvalRuntime: true,
  });

function* resolveAndProcessOxcPreparedImports(
  action: ITransformAction,
  preparedCode: string,
  imports: Map<string, string[]> | null
): SyncScenarioFor<string> {
  const { loadedAndParsed } = action.entrypoint;
  if (imports === null || imports.size === 0) {
    return preparedCode;
  }

  const resolvedImports = yield* action.getNext(
    'resolveImports',
    action.entrypoint,
    {
      imports,
      phase: 'initial',
    }
  );

  let nextCode = preparedCode;
  let nextResolvedImports: IEntrypointDependency[] = [];
  let skippedParentDependencyTracking: string[] = [];

  if (resolvedImports.length > 0) {
    const rewritten = yield* rewriteOptimizedOxcBarrelImports.call(
      action,
      preparedCode,
      loadedAndParsed.evaluator === 'ignored'
        ? action.entrypoint.name
        : loadedAndParsed.evalConfig.filename ?? action.entrypoint.name,
      resolvedImports
    );

    nextCode = rewritten.code;

    if (rewritten.optimizedCount > 0) {
      skippedParentDependencyTracking = rewritten.generatedSources;
      const fullyRewrittenSources = new Set(rewritten.fullyRewrittenSources);
      const partialFallbackSources = new Set(rewritten.partialFallbackSources);

      for (const dependency of resolvedImports) {
        if (
          dependency.resolved &&
          (fullyRewrittenSources.has(dependency.source) ||
            partialFallbackSources.has(dependency.source))
        ) {
          if (partialFallbackSources.has(dependency.source)) {
            action.entrypoint.addDependency(dependency);
          } else {
            action.entrypoint.addInvalidationDependency(dependency);
          }

          action.entrypoint.markInvalidateOnDependencyChange(
            dependency.resolved
          );
        }
      }

      nextResolvedImports = yield* action.getNext(
        'resolveImports',
        action.entrypoint,
        {
          imports: rewritten.imports,
          phase: 'rewritten',
          preResolved: rewritten.preResolvedImports,
        }
      );
    } else {
      nextResolvedImports = resolvedImports;
    }
  }

  if (nextResolvedImports.length !== 0) {
    yield [
      'processImports',
      action.entrypoint,
      {
        resolved: nextResolvedImports,
        skipParentDependencyTracking: skippedParentDependencyTracking,
      },
    ];
  }

  return nextCode;
}

export function* internalTransform(
  this: ITransformAction,
  prepareFn: PrepareCodeFn
): SyncScenarioForAction<ITransformAction> {
  const { only, loadedAndParsed, log } = this.entrypoint;
  if (loadedAndParsed.evaluator === 'ignored') {
    log('is ignored');
    return {
      code: loadedAndParsed.code ?? '',
      metadata: null,
    };
  }

  if (loadedAndParsed.evaluator !== oxcShaker) {
    throw new Error(
      `[wyw-in-js] ${this.entrypoint.name} matched a legacy evaluator. The Oxc runtime path supports only the default Oxc evaluator.`
    );
  }

  log('>> (%o)', only);

  if (loadedAndParsed.evaluator === oxcShaker) {
    ensureOxcPreevalResult(this.services, this.entrypoint, null);
    yield* resolveStaticOxcPreevalValues.call(this);
  }

  let [preparedCode, imports, metadata] = prepareFn(
    this.services,
    this.entrypoint,
    null
  );
  let finalPreparedCode = preparedCode;

  if (loadedAndParsed.evaluator === oxcShaker) {
    if (metadata === null && isPrevalOnly(only)) {
      log(
        'skip resolving imports for __wywPreval-only entrypoint without metadata'
      );
      return {
        code: finalPreparedCode,
        metadata: null,
      };
    }

    let nextCode = yield* resolveAndProcessOxcPreparedImports(
      this,
      preparedCode,
      imports
    );

    if (yield* resolveStaticOxcPreevalValues.call(this)) {
      [preparedCode, imports, metadata] = prepareFn(
        this.services,
        this.entrypoint,
        null
      );
      nextCode = yield* resolveAndProcessOxcPreparedImports(
        this,
        preparedCode,
        imports
      );
    }

    emitCurrentStaticPlanDebug(this, imports);

    finalPreparedCode = this.services.eventEmitter.perf(
      'transform:emitCommonJS',
      () =>
        emitOxcCommonJS(
          nextCode,
          loadedAndParsed.evalConfig.filename ?? this.entrypoint.name
        ).code
    );
  }

  if (loadedAndParsed.code === finalPreparedCode) {
    log('<< (%o)\n === no changes ===', only);
  } else {
    log('<< (%o)', only);
    log.extend('source')('%s', finalPreparedCode || EMPTY_FILE);
  }

  if (finalPreparedCode === '') {
    log('is skipped');
    return {
      code: loadedAndParsed.code ?? '',
      metadata,
    };
  }

  if (metadata === null && isPrevalOnly(only)) {
    log(
      'skip resolving imports for __wywPreval-only entrypoint without metadata'
    );
    return {
      code: finalPreparedCode,
      metadata: null,
    };
  }

  if (
    loadedAndParsed.evaluator !== oxcShaker &&
    imports !== null &&
    imports.size > 0
  ) {
    const resolvedImports = yield* this.getNext(
      'resolveImports',
      this.entrypoint,
      {
        imports,
      }
    );

    if (resolvedImports.length !== 0) {
      yield [
        'processImports',
        this.entrypoint,
        {
          resolved: resolvedImports,
        },
      ];
    }
  }

  return {
    code: finalPreparedCode,
    metadata,
  };
}

export function* transform(
  this: ITransformAction
): SyncScenarioForAction<ITransformAction> {
  return yield* internalTransform.call(this, prepareCode);
}
