/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import { isAbsolute } from 'path';

import { getEvalStrategy } from '../../../utils/evalStrategy';
import { stripQueryAndHash } from '../../../utils/parseRequest';
import { remapPureCallHints } from '../../../utils/pureCallHintSourceMap';
import type { ITransformAction, SyncScenarioFor } from '../../types';
import {
  resolveCandidateValue,
  resolveOpaqueRuntimeCandidateValue,
} from './candidateResolver';
import { deferStaticPreevalCode } from './deferredCode';
import {
  debugStaticResolve,
  getStaticStrategyFailure,
  parseProgram,
} from './environment';
import type {
  StaticRejectionDetail,
  UnresolvedValueDetail,
} from './environment';
import {
  collectWYWMetaExtendsHelperNames,
  createSameFileStaticWYWMetaHelperResolver,
} from './processorStaticModel';
import { resolveExecuteOxcSideEffectProvenance } from './resolveExecuteOxcSideEffectProvenance';
import { runtimeCallbackPlaceholder } from './staticExpression';
import type { StaticExportResult } from './types';

export function* resolveStaticOxcPreevalValues(
  this: ITransformAction
): SyncScenarioFor<boolean> {
  const preevalResult = this.entrypoint.getPreevalResult();
  if (!preevalResult) {
    return false;
  }

  let candidates = preevalResult.staticValueCandidates ?? [];
  const staticValueCache =
    preevalResult.staticValueCache ?? new Map<string, unknown>();
  const finalizeEvaltimeReplacements = (): void => {
    preevalResult.finalizeEvaltimeReplacements?.(staticValueCache);
  };

  if (
    candidates.length === 0 &&
    (preevalResult.dependencyNames?.length ?? 0) === 0
  ) {
    finalizeEvaltimeReplacements();
    return false;
  }

  const filename =
    this.entrypoint.loadedAndParsed.evaluator === 'ignored'
      ? this.entrypoint.name
      : this.entrypoint.loadedAndParsed.evalConfig.filename ??
        this.entrypoint.name;
  const evalStrategy = getEvalStrategy(this.services.options.pluginOptions);
  if (evalStrategy === 'execute') {
    finalizeEvaltimeReplacements();
    candidates = preevalResult.staticValueCandidates ?? candidates;
    yield* resolveExecuteOxcSideEffectProvenance(this, candidates, filename);

    return false;
  }
  const evalDependencyNames = new Set(preevalResult.dependencyNames ?? []);
  const staticOnly = evalStrategy === 'static';

  // candidate name -> why it was rejected and the precise guard responsible.
  const rejections = new Map<string, StaticRejectionDetail>();
  const inputSourceMap =
    stripQueryAndHash(filename) ===
    stripQueryAndHash(this.services.options.filename)
      ? this.services.options.inputSourceMap
      : undefined;

  const buildUnresolvedDetails = (
    names: Iterable<string>
  ): Map<string, UnresolvedValueDetail> => {
    const wanted = new Set(names);
    const details = new Map<string, UnresolvedValueDetail>();
    for (const candidate of candidates) {
      if (!wanted.has(candidate.name) || details.has(candidate.name)) {
        continue;
      }

      const rejection = rejections.get(candidate.name);
      details.set(candidate.name, {
        source: candidate.source,
        importedFrom: candidate.imports[0]?.source,
        reason: rejection?.reason,
      });
    }

    for (const rawHint of preevalResult.pureCallHints ?? []) {
      if (!wanted.has(rawHint.expressionName)) {
        continue;
      }
      const detail = details.get(rawHint.expressionName) ?? {
        source: rawHint.expressionSource,
        reason: 'candidate-mutation-guard-unresolved' as const,
      };
      const rejection = rejections.get(rawHint.expressionName);
      const rejectedSpan = rejection?.pureCallHintSpan;
      if (
        rejection &&
        rejection.reason !== 'candidate-mutation-guard-unresolved'
      ) {
        continue;
      }
      if (rejection) {
        if (
          !rejectedSpan ||
          rejectedSpan.start !== rawHint.callStart ||
          rejectedSpan.end !== rawHint.callEnd
        ) {
          continue;
        }
      } else if (!rawHint.actionableWithoutRejection) {
        continue;
      }
      const [displayHint] = remapPureCallHints([rawHint], inputSourceMap);
      if (!displayHint) {
        continue;
      }
      detail.pureCallHints = [...(detail.pureCallHints ?? []), displayHint];
      details.set(rawHint.expressionName, detail);
    }

    return details;
  };

  const staticDependencies = new Set(preevalResult.staticDependencies ?? []);
  const staticImportLocals = new Set<string>(
    preevalResult.staticImportLocals ?? []
  );
  const sideEffectImportLocals = new Set<string>(
    preevalResult.staticSideEffectImportLocals ?? []
  );
  const staticNullWYWMetaExtendsHelpers = new Set(
    preevalResult.staticNullWYWMetaExtendsHelpers ?? []
  );
  const memo = new Map<string, StaticExportResult | null>();
  let opaqueRuntimeBaseHelpers = new Set<string>();
  let resolveSameFileStaticWYWMetaHelpers: ReturnType<
    typeof createSameFileStaticWYWMetaHelperResolver
  >;
  const refreshStaticMetadataHelpers = (): void => {
    const currentBaseCode = preevalResult.baseCode ?? preevalResult.code;
    opaqueRuntimeBaseHelpers = collectWYWMetaExtendsHelperNames(
      parseProgram(currentBaseCode, filename)
    );
    resolveSameFileStaticWYWMetaHelpers =
      createSameFileStaticWYWMetaHelperResolver(currentBaseCode, filename);
  };

  refreshStaticMetadataHelpers();
  // Names of candidates resolved to runtime callbacks (function values).
  // They keep the file out of evalFile but their helper declarations must
  // not be pruned — the runtime call site relies on them.
  const runtimeOnlyCandidateNames = new Set<string>(
    preevalResult.runtimeOnlyStaticValueNames ?? []
  );
  let changed = false;
  let hasKnownStaticCandidate = false;
  const applySameFileStaticWYWMetaHelpers = (): boolean => {
    let appliedAny = false;

    for (;;) {
      let applied = false;
      const values = resolveSameFileStaticWYWMetaHelpers(staticValueCache);
      for (const [name, value] of values) {
        if (
          staticValueCache.has(name) ||
          (!evalDependencyNames.has(name) &&
            !opaqueRuntimeBaseHelpers.has(name))
        ) {
          continue;
        }

        staticValueCache.set(name, value);
        debugStaticResolve(this, {
          candidate: name,
          filename,
          phase: 'candidate',
          reason: 'same-file-static-metadata',
          status: 'resolved',
        });
        applied = true;
      }

      if (!applied) {
        break;
      }

      appliedAny = true;
    }

    if (appliedAny) {
      changed = true;
      hasKnownStaticCandidate = true;
    }

    return appliedAny;
  };

  function* resolveCandidatePass(
    action: ITransformAction
  ): SyncScenarioFor<void> {
    applySameFileStaticWYWMetaHelpers();

    for (const candidate of candidates) {
      applySameFileStaticWYWMetaHelpers();

      const isOpaqueRuntimeBaseHelper = opaqueRuntimeBaseHelpers.has(
        candidate.name
      );
      if (
        !evalDependencyNames.has(candidate.name) &&
        !isOpaqueRuntimeBaseHelper &&
        !staticValueCache.has(candidate.name)
      ) {
        rejections.set(candidate.name, { reason: 'not-eval-dependency' });
        debugStaticResolve(action, {
          candidate: candidate.name,
          filename,
          phase: 'candidate',
          reason: 'not-eval-dependency',
          status: 'skipped',
        });
        continue;
      }

      if (staticValueCache.has(candidate.name)) {
        hasKnownStaticCandidate = true;
        candidate.imports.forEach((item) =>
          staticImportLocals.add(item.importLocal ?? item.local)
        );
        if (
          isOpaqueRuntimeBaseHelper &&
          staticValueCache.get(candidate.name) === null
        ) {
          staticNullWYWMetaExtendsHelpers.add(candidate.name);
        }
        debugStaticResolve(action, {
          candidate: candidate.name,
          filename,
          phase: 'candidate',
          reason: 'already-static',
          status: 'skipped',
        });
        continue;
      }

      let resolved: StaticExportResult | null;
      let resolvedOpaqueRuntimeBase = false;
      if (isOpaqueRuntimeBaseHelper) {
        resolved = yield* resolveOpaqueRuntimeCandidateValue(
          action,
          candidate,
          filename
        );
        resolvedOpaqueRuntimeBase = !!resolved;
        if (!resolved) {
          resolved = yield* resolveCandidateValue(
            action,
            candidate,
            filename,
            memo,
            rejections
          );
        }
      } else {
        resolved = yield* resolveCandidateValue(
          action,
          candidate,
          filename,
          memo,
          rejections
        );
      }
      if (!resolved) {
        continue;
      }

      if (resolvedOpaqueRuntimeBase) {
        debugStaticResolve(action, {
          candidate: candidate.name,
          filename,
          phase: 'candidate',
          reason: 'opaque-runtime-component',
          status: 'resolved',
        });
        staticNullWYWMetaExtendsHelpers.add(candidate.name);
      }

      if (resolved.runtimeOnly) {
        // Runtime callback — seed a callable placeholder for collect() but
        // track it separately so the `_exp = () => target` helper survives
        // pruning. The runtime call site relies on that helper declaration.
        runtimeOnlyCandidateNames.add(candidate.name);
        staticValueCache.set(candidate.name, runtimeCallbackPlaceholder);
      } else {
        staticValueCache.set(candidate.name, resolved.value);
      }
      hasKnownStaticCandidate = true;
      candidate.imports.forEach((item) =>
        staticImportLocals.add(item.importLocal ?? item.local)
      );
      resolved.dependencies.forEach((dependency) =>
        staticDependencies.add(dependency)
      );
      resolved.sideEffectImportLocals?.forEach((local) =>
        sideEffectImportLocals.add(local)
      );
      changed = true;
      applySameFileStaticWYWMetaHelpers();
    }
  }

  const resolvedDependencyNames = (): string[] =>
    (preevalResult.dependencyNames ?? []).filter(
      (name) =>
        !staticValueCache.has(name) && !runtimeOnlyCandidateNames.has(name)
    );
  const syncStaticState = (): void => {
    preevalResult.dependencyNames = resolvedDependencyNames();
    preevalResult.staticValueCache = staticValueCache;
    preevalResult.staticDependencies = [...staticDependencies];
    preevalResult.staticNullWYWMetaExtendsHelpers = [
      ...staticNullWYWMetaExtendsHelpers,
    ];
    preevalResult.runtimeOnlyStaticValueNames = [...runtimeOnlyCandidateNames];
  };

  yield* resolveCandidatePass(this);
  syncStaticState();
  finalizeEvaltimeReplacements();
  candidates = preevalResult.staticValueCandidates ?? candidates;
  refreshStaticMetadataHelpers();
  yield* resolveCandidatePass(this);

  const dependencyNames = resolvedDependencyNames();
  if (
    !changed &&
    (!hasKnownStaticCandidate || preevalResult.staticValuesApplied)
  ) {
    if (staticOnly && dependencyNames.length > 0) {
      throw getStaticStrategyFailure(
        filename,
        dependencyNames,
        buildUnresolvedDetails(dependencyNames)
      );
    }
    return false;
  }

  if (staticOnly && dependencyNames.length > 0) {
    throw getStaticStrategyFailure(
      filename,
      dependencyNames,
      buildUnresolvedDetails(dependencyNames)
    );
  }
  preevalResult.dependencyNames = dependencyNames;
  preevalResult.staticValueCache = staticValueCache;
  preevalResult.staticDependencies = [...staticDependencies];
  preevalResult.staticNullWYWMetaExtendsHelpers = [
    ...staticNullWYWMetaExtendsHelpers,
  ];
  preevalResult.runtimeOnlyStaticValueNames = [...runtimeOnlyCandidateNames];
  preevalResult.staticValuesApplied = true;

  const prunableStaticValueNames = new Set(
    [...staticValueCache.keys()].filter(
      (name) => !runtimeOnlyCandidateNames.has(name)
    )
  );
  const staticExtendsHelperValues = new Map(
    [...staticValueCache].filter(
      ([name]) => !runtimeOnlyCandidateNames.has(name)
    )
  );
  staticNullWYWMetaExtendsHelpers.forEach((name) => {
    if (!staticExtendsHelperValues.has(name)) {
      staticExtendsHelperValues.set(name, null);
    }
  });
  deferStaticPreevalCode(
    preevalResult,
    filename,
    prunableStaticValueNames,
    staticImportLocals,
    staticExtendsHelperValues,
    sideEffectImportLocals
  );
  preevalResult.staticImportLocals = [...staticImportLocals];
  preevalResult.staticSideEffectImportLocals = [...sideEffectImportLocals];

  for (const dependency of staticDependencies) {
    const strippedDependency = stripQueryAndHash(dependency);
    if (isAbsolute(strippedDependency)) {
      this.services.cache.checkFreshness(dependency, strippedDependency);
    }

    this.entrypoint.addInvalidationDependency({
      only: ['*'],
      resolved: dependency,
      source: dependency,
    });
    this.entrypoint.markInvalidateOnDependencyChange(dependency);
  }

  return true;
}
