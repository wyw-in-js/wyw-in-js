import type { BaseProcessor, IFileContext } from '@wyw-in-js/processor-utils';
import type { ExpressionValue, StrictOptions } from '@wyw-in-js/shared';

import { collectOxcProcessorImportsFromProgram } from '../collectOxcExportsAndImports';
import { collectOxcExpressionDependencies } from '../collectOxcTemplateDependencies';
import type {
  OxcStaticValue,
  OxcStaticValueCandidate,
} from '../collectOxcTemplateDependencies';
import type { DangerousCodePlan } from '../dangerousCodeRemoval';
import {
  collectOxcExpressionDependenciesForEvalFallback,
  OxcSnapshotWriteUnsupportedError,
} from '../collectOxcTemplateDependencies/expressionExtraction';
import { EventEmitter } from '../EventEmitter';
import type { AddedImport } from '../oxcAstService';
import { isOxcNode } from '../oxc/ast';
import {
  applyOxcEdits,
  createOxcFileEdits,
  type OxcEdit,
} from '../oxc/fileEdits';
import {
  buildOxcCodeFrameError,
  createOxcLocationLookup,
} from '../oxc/sourceLocations';
import { getProcessorForImport } from '../../processors/processorLookup';
import { normalizeDeclarativeProcessorSemantics } from '../../processors/declarativeSemantics';
import { resolveProcessorStaticClassName } from '../processorStaticSemantics';
import { collectUsedNames } from './cleanupBindings';
import {
  addCandidateInlineConstants,
  collectSameFileProcessorObjectStaticValuesByLocal,
  collectSameFileProcessorStaticValuesByLocal,
  collectWYWMetaExtendsHelperNames,
  getSameFileProcessorObjectProperty,
} from './sameFileStaticValues';
import {
  collectSameFileProcessorStaticValues,
  getTagOwner,
  isTagReferenced,
} from './displayName';
import { buildParams } from './expressionValues';
import {
  createProcessor,
  shouldCollectStaticExpressionValues,
} from './processorFactory';
import {
  collectProcessorUsages,
  collectUsageExpressionSpans,
} from './processorUsages';
import { removeUnusedAfterReplacement } from './cleanup-after-replacement';
import { insertAddedImports, parseOxc } from './shared';
import type {
  ApplyOxcProcessorsResult,
  CreatedProcessor,
  DefinedProcessor,
  OxcProcessorAnalysisPlan,
  ProcessorUsage,
  SameFileProcessorObject,
  StaticPlanFacts,
} from './types';
import {
  isPipelineTelemetryActive,
  recordPipelineProcessors,
} from '../../debug/pipelineTelemetry';

const EMPTY_STATIC_PLAN_FACTS: StaticPlanFacts = {
  importedNeeds: [],
  staticValueCount: 0,
  unresolvedCount: 0,
  usageCount: 0,
};

const collectStaticPlanFacts = (
  usages: ProcessorUsage[],
  staticValueCandidates: OxcStaticValueCandidate[],
  staticValues: OxcStaticValue[]
): StaticPlanFacts => {
  const staticValueNames = new Set(staticValues.map(({ name }) => name));
  const unresolvedNames = new Set<string>();
  const importedNeeds: StaticPlanFacts['importedNeeds'] = [];

  staticValueCandidates.forEach((candidate) => {
    if (candidate.imports.length === 0) {
      return;
    }

    if (!staticValueNames.has(candidate.name)) {
      unresolvedNames.add(candidate.name);
    }

    candidate.imports.forEach(({ imported: name, source }) => {
      importedNeeds.push({ name, source });
    });
    candidate.mutationGuards?.forEach((guard) => {
      guard.imports.forEach(({ imported: name, source }) => {
        importedNeeds.push({ name, source });
      });
    });
  });

  return {
    importedNeeds,
    staticValueCount: staticValueNames.size,
    unresolvedCount: unresolvedNames.size,
    usageCount: usages.length,
  };
};

export const applyOxcProcessors = (
  code: string,
  fileContext: IFileContext,
  options: Pick<
    StrictOptions,
    | 'classNameSlug'
    | 'displayName'
    | 'eval'
    | 'extensions'
    | 'processors'
    | 'staticBindings'
    | 'tagResolver'
  > & {
    createEvaltimeCodePlan?: (
      processorSpans: Array<{ end: number; start: number }>
    ) => DangerousCodePlan;
    eventEmitter?: EventEmitter;
    perfPrefix?: string;
    preserveSideEffectImportOrderLocals?: Set<string>;
    preserveSideEffectImportLocals?: Set<string>;
  },
  callback: (processor: BaseProcessor) => void,
  cleanupUnused = false,
  deferProcessorCallbacks = false,
  runtimeProcessorPlan?: OxcProcessorAnalysisPlan
): ApplyOxcProcessorsResult => {
  const filename = fileContext.filename ?? 'unknown.js';
  const eventEmitter = options.eventEmitter ?? EventEmitter.dummy;
  const perfPrefix = options.perfPrefix ?? 'transform:preeval:processTemplate';
  const perfLabel = (suffix: string): string => `${perfPrefix}:${suffix}`;
  const pipelineTelemetryEnabled = isPipelineTelemetryActive();
  const pipelineTelemetryPhase =
    pipelineTelemetryEnabled && perfPrefix.includes(':collect')
      ? 'collect'
      : 'preeval';
  let pipelineImportCandidates = 0;
  let pipelineLookupAttempts = 0;
  let pipelineLookupHits = 0;
  const collectStaticExpressionValues =
    shouldCollectStaticExpressionValues(options);
  const workingCode = code;
  const reusablePlan =
    runtimeProcessorPlan?.code === workingCode &&
    runtimeProcessorPlan.filename === filename
      ? runtimeProcessorPlan
      : undefined;
  const program = reusablePlan?.program ?? parseOxc(workingCode, filename);
  let evaltimeCodePlan: DangerousCodePlan | null = null;
  const getEvaltimeCodePlan = (
    processorSpans: Array<{ end: number; start: number }> = []
  ): DangerousCodePlan => {
    evaltimeCodePlan ??= options.createEvaltimeCodePlan?.(processorSpans) ?? {
      removedSpans: [],
      replacements: [],
      runtimeOnlyProcessorSpans: [],
    };

    return evaltimeCodePlan;
  };
  const buildUnprocessedCode = () =>
    applyOxcEdits(workingCode, getEvaltimeCodePlan().replacements);
  const definedProcessors = new Map<string, DefinedProcessor>();
  const removableImportLocals = new Set(
    reusablePlan?.removableImportLocals ?? []
  );
  const removableExpressionRefs = new Set<string>();

  if (!reusablePlan) {
    eventEmitter.perf(perfLabel('imports'), () => {
      const imports = eventEmitter.perf(perfLabel('imports:analysis'), () =>
        collectOxcProcessorImportsFromProgram(program, workingCode)
      );
      if (pipelineTelemetryEnabled) {
        pipelineImportCandidates = imports.length;
      }

      eventEmitter.perf(perfLabel('imports:lookup'), () => {
        imports.forEach((item) => {
          const localName = item.local.name ?? item.local.code;
          if (item.imported === 'side-effect' || !localName) {
            return;
          }
          if (pipelineTelemetryEnabled) {
            pipelineLookupAttempts += 1;
          }

          const [processor, tagSource, manifest] = getProcessorForImport(
            {
              imported: item.imported,
              source: item.source,
            },
            filename,
            options
          );

          if (processor) {
            if (pipelineTelemetryEnabled) {
              pipelineLookupHits += 1;
            }
            definedProcessors.set(localName, [
              processor,
              tagSource,
              {
                declarativeSemantics: normalizeDeclarativeProcessorSemantics(
                  manifest?.semantics,
                  manifest?.dir
                ),
              },
            ]);
            removableImportLocals.add(localName);
            const rootLocalName = localName.split('.')[0];
            if (rootLocalName) {
              removableImportLocals.add(rootLocalName);
            }
          }
        });
      });
    });
  }

  if (!reusablePlan && definedProcessors.size === 0) {
    if (pipelineTelemetryEnabled) {
      recordPipelineProcessors(
        pipelineTelemetryPhase,
        false,
        pipelineImportCandidates,
        pipelineLookupAttempts,
        pipelineLookupHits,
        0,
        0
      );
    }
    return {
      code: buildUnprocessedCode(),
      processorManagedExpressionSpans: [],
      processorClassNamesByLocal: new Map(),
      processors: [],
      pureCallHints: [],
      staticPlanFacts: EMPTY_STATIC_PLAN_FACTS,
      staticValueCandidates: [],
      staticValues: [],
    };
  }

  const processorUsages =
    reusablePlan?.processorUsages ??
    eventEmitter.perf(perfLabel('usages'), () =>
      collectProcessorUsages(program, definedProcessors)
    );
  if (pipelineTelemetryEnabled) {
    recordPipelineProcessors(
      pipelineTelemetryPhase,
      Boolean(reusablePlan),
      pipelineImportCandidates,
      pipelineLookupAttempts,
      pipelineLookupHits,
      definedProcessors.size,
      processorUsages.length
    );
  }
  if (processorUsages.length === 0) {
    return {
      code: buildUnprocessedCode(),
      processorManagedExpressionSpans: [],
      processorClassNamesByLocal: new Map(),
      processors: [],
      pureCallHints: [],
      staticPlanFacts: EMPTY_STATIC_PLAN_FACTS,
      staticValueCandidates: [],
      staticValues: [],
    };
  }

  const targetExpressionSpans = processorUsages.flatMap(
    collectUsageExpressionSpans
  );
  const processorManagedExpressionSpans = processorUsages.map((usage) => ({
    end: usage.target.end,
    start: usage.target.start,
  }));
  const {
    removedSpans: evaltimeRemovedSpans,
    replacements: evaltimeCodeReplacements,
    runtimeOnlyProcessorSpans,
  } = getEvaltimeCodePlan(processorManagedExpressionSpans);
  const extractDependencies = () => {
    try {
      return collectOxcExpressionDependencies(
        workingCode,
        filename,
        collectStaticExpressionValues,
        targetExpressionSpans,
        options.staticBindings,
        processorManagedExpressionSpans,
        evaltimeRemovedSpans
      );
    } catch (error) {
      if (!(error instanceof OxcSnapshotWriteUnsupportedError)) {
        throw error;
      }

      return collectOxcExpressionDependenciesForEvalFallback(
        workingCode,
        filename,
        targetExpressionSpans,
        processorManagedExpressionSpans,
        evaltimeRemovedSpans
      );
    }
  };

  const extracted =
    reusablePlan?.extracted ??
    (targetExpressionSpans.length > 0
      ? eventEmitter.perf(perfLabel('deps'), () => extractDependencies())
      : {
          code: workingCode,
          dependencyNames: [],
          expressionValues: [],
          pureCallHints: [],
          replacements: [],
          staticValueCandidates: [],
          staticValues: [],
        });

  const templateExpressionValues = extracted.expressionValues.map(
    (value) =>
      ({
        ...value,
        buildCodeFrameError: (message: string) =>
          buildOxcCodeFrameError(code, value.ex.loc!, message),
      }) as ExpressionValue
  );
  const loc = createOxcLocationLookup(workingCode);
  const usedNames =
    reusablePlan?.usedNames ??
    eventEmitter.perf(perfLabel('usedNames'), () => collectUsedNames(program));
  const addedImports: AddedImport[] = [];
  const replacements: OxcEdit[] = [];
  const createdProcessors: CreatedProcessor[] = [];
  const processors: BaseProcessor[] = [];
  const processorClassNamesByLocal = new Map<string, string>();
  const sameFileProcessorsByLocal = new Map<string, BaseProcessor>();
  const sameFileProcessorObjectsByLocal = new Map<
    string,
    SameFileProcessorObject
  >();
  extracted.dependencyNames.forEach((name: string) =>
    removableImportLocals.add(name)
  );
  const capturedRuntimeProcessorPlan = deferProcessorCallbacks
    ? {
        code: workingCode,
        extracted,
        filename,
        processorUsages,
        program,
        removableImportLocals: new Set(removableImportLocals),
        usedNames,
      }
    : undefined;

  eventEmitter.perf(perfLabel('processors'), () => {
    processorUsages.forEach((usage, idx) => {
      const params = buildParams(
        usage,
        workingCode,
        loc,
        filename,
        templateExpressionValues,
        usage.collapseQualifiedCallee
      );
      if (!params) {
        return;
      }

      const created = createProcessor(
        usage.definedProcessor,
        params,
        usage.target,
        usage.replacementTarget,
        usage.ancestors,
        fileContext,
        options,
        workingCode,
        loc,
        idx,
        !runtimeOnlyProcessorSpans.some(
          (span) =>
            span.start <= usage.replacementTarget.start &&
            span.end >= usage.replacementTarget.end
        ),
        isTagReferenced(program, usage.ancestors),
        usedNames,
        replacements
      );

      if (!created) {
        return;
      }

      const { astService, processor } = created;

      const owner = getTagOwner(usage.ancestors);
      if (owner?.type === 'VariableDeclarator') {
        const { id } = owner;
        if (isOxcNode(id) && id.type === 'Identifier') {
          removableExpressionRefs.add(id.name);
          sameFileProcessorsByLocal.set(id.name, processor);
          // Cross-file map (used as a className-only fallback in
          // resolveStaticExport) is restricted to processors whose
          // runtime value IS the className string. Styled-component
          // bindings emit a richer value and must reach consumers via
          // resolveProcessorStaticExport so composition still works.
          const staticClassName = resolveProcessorStaticClassName(processor);
          if (staticClassName) {
            processorClassNamesByLocal.set(id.name, staticClassName);
          } else {
            const replacement = processor.value as {
              type?: string;
              value?: unknown;
            };
            if (
              (replacement?.type === 'StringLiteral' ||
                replacement?.type === 'Literal') &&
              typeof replacement.value === 'string'
            ) {
              processorClassNamesByLocal.set(id.name, processor.className);
            }
          }
        }
      }

      const objectProperty = getSameFileProcessorObjectProperty(
        usage.ancestors
      );
      if (objectProperty) {
        const existing = sameFileProcessorObjectsByLocal.get(
          objectProperty.localName
        );
        const object = existing ?? {
          properties: new Map<string, BaseProcessor>(),
          propertyNames: objectProperty.propertyNames,
        };

        object.properties.set(objectProperty.propertyName, processor);
        sameFileProcessorObjectsByLocal.set(objectProperty.localName, object);
      }

      processors.push(processor);
      createdProcessors.push(created);
      if (!deferProcessorCallbacks && created.evaltimeLive) {
        callback(processor);
        addedImports.push(...astService.getAddedImports());
      }
    });
  });
  const collectAvailableStaticValues = (
    staticValueCache?: Map<string, unknown>
  ): OxcStaticValue[] => {
    const values = [...extracted.staticValues];
    staticValueCache?.forEach((value, name) => {
      values.push({ name, value });
    });

    return values;
  };
  const collectCurrentSameFileProcessorStaticValues = (
    staticValueCache?: Map<string, unknown>
  ): {
    byLocal: Map<string, unknown>;
    values: OxcStaticValue[];
  } => {
    if (!collectStaticExpressionValues) {
      return {
        byLocal: new Map(),
        values: [],
      };
    }

    const availableStaticValues =
      collectAvailableStaticValues(staticValueCache);
    const byLocal = collectSameFileProcessorStaticValuesByLocal(
      sameFileProcessorsByLocal,
      extracted.expressionValues,
      availableStaticValues
    );
    const objectStaticValuesByLocal =
      collectSameFileProcessorObjectStaticValuesByLocal(
        sameFileProcessorObjectsByLocal,
        sameFileProcessorsByLocal,
        extracted.expressionValues,
        availableStaticValues
      );
    objectStaticValuesByLocal.forEach((value, local) => {
      byLocal.set(local, value);
    });

    return {
      byLocal,
      values: collectSameFileProcessorStaticValues(
        extracted.expressionValues,
        byLocal
      ),
    };
  };
  const currentSameFileProcessorStaticValues =
    collectCurrentSameFileProcessorStaticValues();

  // Processor edits win over evaltime removals, which win over extracted
  // expression edits, when two of them cover the same range.
  const applyFileEdits = (): string =>
    createOxcFileEdits(workingCode)
      .add(replacements)
      .add(evaltimeCodeReplacements)
      .add(extracted.replacements)
      .apply();
  const replacedCode = applyFileEdits();
  const metadataExtendsHelperNames =
    collectWYWMetaExtendsHelperNames(replacedCode);
  const staticValueCandidates = extracted.staticValueCandidates.filter(
    (candidate) =>
      candidate.imports.length > 0 ||
      !metadataExtendsHelperNames.has(candidate.name)
  );
  let callbacksApplied = !deferProcessorCallbacks;

  const buildCode = (): string => {
    const codeWithAddedImports = insertAddedImports(
      applyFileEdits(),
      filename,
      addedImports
    );

    return cleanupUnused
      ? eventEmitter.perf(perfLabel('cleanup'), () =>
          removeUnusedAfterReplacement(
            codeWithAddedImports,
            filename,
            removableImportLocals,
            new Set([...removableExpressionRefs, ...extracted.dependencyNames]),
            options.preserveSideEffectImportLocals ?? new Set(),
            options.preserveSideEffectImportOrderLocals ??
              options.preserveSideEffectImportLocals ??
              new Set()
          )
        )
      : codeWithAddedImports;
  };

  const result: ApplyOxcProcessorsResult = {
    code: buildCode(),
    processorManagedExpressionSpans,
    processorClassNamesByLocal,
    processors,
    pureCallHints: extracted.pureCallHints,
    runtimeProcessorPlan: capturedRuntimeProcessorPlan,
    staticPlanFacts: collectStaticPlanFacts(
      processorUsages,
      extracted.staticValueCandidates,
      extracted.staticValues
    ),
    staticValueCandidates: addCandidateInlineConstants(
      staticValueCandidates,
      currentSameFileProcessorStaticValues.byLocal
    ),
    staticValues: [
      ...extracted.staticValues,
      ...currentSameFileProcessorStaticValues.values,
    ],
  };
  const applyProcessorCallbacks = (
    staticValueCache?: Map<string, unknown>
  ): void => {
    if (callbacksApplied) {
      return;
    }

    const staticValues =
      collectCurrentSameFileProcessorStaticValues(staticValueCache);
    staticValues.byLocal.forEach((value, name) => {
      staticValueCache?.set(name, value);
    });
    staticValues.values.forEach(({ name, value }) => {
      staticValueCache?.set(name, value);
    });
    result.staticValueCandidates = addCandidateInlineConstants(
      staticValueCandidates,
      staticValues.byLocal
    );
    result.staticValues = [...extracted.staticValues, ...staticValues.values];
    createdProcessors.forEach(({ astService, evaltimeLive, processor }) => {
      if (!evaltimeLive) {
        return;
      }

      callback(processor);
      addedImports.push(...astService.getAddedImports());
    });
    callbacksApplied = true;
  };

  if (deferProcessorCallbacks) {
    result.finalizeProcessorCallbacks = (
      staticValueCache?: Map<string, unknown>
    ) => {
      applyProcessorCallbacks(staticValueCache);
      result.code = buildCode();

      return result;
    };
  }

  return result;
};
