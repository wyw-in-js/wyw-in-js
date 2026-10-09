/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { SourceLocation } from '@wyw-in-js/shared';
import type {
  Expression,
  ImportDeclaration,
  ImportSpecifier,
  ModuleExportName,
  Node,
  Program,
  VariableDeclaration,
} from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import { parseOxcProgram } from '../oxc/parse';
import { collectOxcPatternBindingNames } from '../oxc/patterns';
import { createOxcSourceLocation } from '../oxc/sourceLocations';
import { isTypeOnlyImportSpecifier } from '../oxc/typeOnlyImport';
import { createBindingIndex } from './bindingResolution';
import {
  collectProgramMutationAnalysis,
  isEffectiveMutationHazardSeed,
  registerMutationHazardNode,
} from './mutationAnalysis';
import { visitOxcScopes } from './scopeTraversal';
import type {
  Binding,
  ExpressionSpan,
  ExtractionContext,
  ProgramAnalysis,
  Scope,
  ScopedDeclarationKind,
  SpanLookup,
} from './types';

export { resolveBindingAt } from './bindingResolution';
export {
  getRootMutationHazards,
  toMutationBindingKey,
  unknownAliasMutationBinding,
} from './mutationAnalysis';
export {
  forEachMergedTimelineStartBefore,
  forEachTimelineFullyContained,
  forEachTimelineStartBefore,
  getMutationTimeline,
  hasTimelineEndAtOrBefore,
  hasTimelineStartBefore,
  hasTimelineStartInRange,
  someTimelineEndAtOrBefore,
  someTimelineFullyContained,
  someTimelineStartBefore,
} from './mutationTimeline';
export {
  findReferences,
  isBindingDeclaredWithin,
  isBindingPosition,
  isInTypeContext,
  isObjectPropertyKey,
  isPropertyOnlyIdentifier,
} from './scopeTraversal';

export const containsTaggedTemplateExpression = (node: Node): boolean => {
  if (node.type === 'TaggedTemplateExpression') {
    return true;
  }

  return getOxcNodeChildren(node).some(containsTaggedTemplateExpression);
};

export const parseOxc = (code: string, filename: string): Program => {
  return parseOxcProgram(code, filename, 'unambiguous');
};

const toSpanKey = (start: number, end: number): string => `${start}:${end}`;

export const createSpanLookup = (spans?: ExpressionSpan[]): SpanLookup => {
  if (!spans || spans.length === 0) {
    return null;
  }

  return new Set(spans.map((span) => toSpanKey(span.start, span.end)));
};

const matchesSpanLookup = (
  node: Pick<Node, 'start' | 'end'>,
  spanLookup: SpanLookup
): boolean => !spanLookup || spanLookup.has(toSpanKey(node.start, node.end));

export const getSourceLocation = (
  start: number,
  end: number,
  ctx: Pick<ExtractionContext, 'filename' | 'loc'>
): SourceLocation => createOxcSourceLocation(start, end, ctx.loc, ctx.filename);

const normalizeDeclarationKind = (
  declarationKind: VariableDeclaration['kind']
): ScopedDeclarationKind => {
  if (declarationKind === 'var') {
    return 'var';
  }

  if (declarationKind === 'let') {
    return 'let';
  }

  return 'const';
};

const moduleExportName = (node: ModuleExportName): string =>
  node.type === 'Literal' ? String(node.value) : node.name;

const getImportSpecifierInfo = (
  statement: ImportDeclaration,
  specifier: ImportDeclaration['specifiers'][number]
): { imported: 'default' | '*' | string; local: string } | null => {
  const local = specifier.local?.name;
  if (!local) {
    return null;
  }

  if (specifier.type === 'ImportDefaultSpecifier') {
    return {
      imported: 'default',
      local,
    };
  }

  if (specifier.type === 'ImportNamespaceSpecifier') {
    return {
      imported: '*',
      local,
    };
  }

  if (isTypeOnlyImportSpecifier(statement, specifier)) {
    return null;
  }

  return {
    imported: moduleExportName((specifier as ImportSpecifier).imported),
    local,
  };
};

const getDeclarationScope = (
  scope: Scope,
  declarationKind: ScopedDeclarationKind
): Scope => {
  if (declarationKind !== 'var') {
    return scope;
  }

  let current: Scope | null = scope;
  while (current && !current.functionBoundary) {
    current = current.parent;
  }

  return current ?? scope;
};

const hasStraightLineVarInitializer = (ancestors: readonly Node[]): boolean => {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index]!;
    if (
      ancestor.type === 'FunctionDeclaration' ||
      ancestor.type === 'FunctionExpression' ||
      ancestor.type === 'ArrowFunctionExpression' ||
      ancestor.type === 'StaticBlock'
    ) {
      return true;
    }

    if (
      ancestor.type !== 'Program' &&
      ancestor.type !== 'BlockStatement' &&
      ancestor.type !== 'ExportNamedDeclaration'
    ) {
      return false;
    }
  }

  return true;
};

type AnalyzeProgramOptions = {
  collectTargetExpressions?: boolean;
  collectTemplateLiterals?: boolean;
  expressionSpanLookup?: SpanLookup;
  mutationHazardIgnoreLookup?: SpanLookup;
  mutationHazardIgnoreTreeLookup?: SpanLookup;
  templateSpanLookup?: SpanLookup;
};

type NormalizedAnalyzeProgramOptions = {
  collectTargetExpressions: boolean;
  collectTemplateLiterals: boolean;
  expressionSpanLookup: SpanLookup;
  mutationHazardIgnoreLookup: SpanLookup;
  mutationHazardIgnoreTreeLookup: SpanLookup;
  templateSpanLookup: SpanLookup;
};

type ProgramScopeFacts = Readonly<
  Pick<ProgramAnalysis, 'bindingIndex' | 'usedNames'>
>;

type RequestAnalysis = Pick<
  ProgramAnalysis,
  'targetExpressions' | 'templateLiterals'
> & {
  hasEffectiveMutationHazardSeed: boolean;
  ignoredMutationHazardNodes: Set<Node>;
  ignoredMutationHazardTreeNodes: Set<Node>;
  processorManagedExpressionNodes: Set<Node>;
};

const programScopeFacts = new WeakMap<Program, ProgramScopeFacts>();
const programRootMutations = new WeakMap<
  Program,
  ProgramAnalysis['rootMutationsByBinding']
>();
const programDefaultMutationHazards = new WeakMap<
  Program,
  ProgramAnalysis['rootMutationHazardsByBinding']
>();
const programDefaultMutationHazardGuards = new WeakMap<
  Program,
  ProgramAnalysis['rootMutationHazardGuardsByBinding']
>();
const MAX_PROGRAM_ANALYSIS_VARIANTS = 4;
const programAnalysisVariants = new WeakMap<
  Program,
  Map<string, ProgramAnalysis>
>();

const normalizeSpanLookup = (lookup: SpanLookup | undefined): SpanLookup =>
  lookup && lookup.size > 0 ? lookup : null;

const normalizeAnalyzeProgramOptions = ({
  collectTargetExpressions = false,
  collectTemplateLiterals = false,
  expressionSpanLookup,
  mutationHazardIgnoreLookup,
  mutationHazardIgnoreTreeLookup,
  templateSpanLookup,
}: AnalyzeProgramOptions): NormalizedAnalyzeProgramOptions => {
  const normalizedExpressionSpanLookup =
    normalizeSpanLookup(expressionSpanLookup);
  const shouldCollectTargetExpressions =
    collectTargetExpressions && normalizedExpressionSpanLookup !== null;

  return {
    collectTargetExpressions: shouldCollectTargetExpressions,
    collectTemplateLiterals,
    expressionSpanLookup: shouldCollectTargetExpressions
      ? normalizedExpressionSpanLookup
      : null,
    mutationHazardIgnoreLookup: normalizeSpanLookup(mutationHazardIgnoreLookup),
    mutationHazardIgnoreTreeLookup: normalizeSpanLookup(
      mutationHazardIgnoreTreeLookup
    ),
    templateSpanLookup: collectTemplateLiterals
      ? templateSpanLookup ?? null
      : null,
  };
};

const sortedSpanLookup = (lookup: SpanLookup): string[] | null =>
  lookup ? [...lookup].sort() : null;

const programAnalysisCacheKey = ({
  collectTargetExpressions,
  collectTemplateLiterals,
  expressionSpanLookup,
  mutationHazardIgnoreLookup,
  mutationHazardIgnoreTreeLookup,
  templateSpanLookup,
}: NormalizedAnalyzeProgramOptions): string =>
  JSON.stringify([
    collectTargetExpressions ? '1' : '0',
    collectTemplateLiterals ? '1' : '0',
    sortedSpanLookup(expressionSpanLookup),
    sortedSpanLookup(mutationHazardIgnoreLookup),
    sortedSpanLookup(mutationHazardIgnoreTreeLookup),
    sortedSpanLookup(templateSpanLookup),
  ]);

const getCachedProgramAnalysis = (
  program: Program,
  key: string
): ProgramAnalysis | undefined => {
  const variants = programAnalysisVariants.get(program);
  const cached = variants?.get(key);
  if (cached && variants) {
    variants.delete(key);
    variants.set(key, cached);
  }

  return cached;
};

const cacheProgramAnalysis = (
  program: Program,
  key: string,
  analysis: ProgramAnalysis
): ProgramAnalysis => {
  const variants = programAnalysisVariants.get(program) ?? new Map();
  variants.set(key, analysis);
  if (variants.size > MAX_PROGRAM_ANALYSIS_VARIANTS) {
    variants.delete(variants.keys().next().value!);
  }
  programAnalysisVariants.set(program, variants);
  return analysis;
};

const createImmutableUsedNames = (source: ReadonlySet<string>): Set<string> => {
  const result = new Set(source);
  const rejectMutation = (): never => {
    throw new TypeError('Cached program analysis is immutable');
  };
  Object.defineProperties(result, {
    add: { value: rejectMutation },
    clear: { value: rejectMutation },
    delete: { value: rejectMutation },
  });

  return Object.freeze(result);
};

const createRequestAnalysis = ({
  collectTargetExpressions,
  collectTemplateLiterals,
  expressionSpanLookup,
  mutationHazardIgnoreLookup,
  mutationHazardIgnoreTreeLookup,
  templateSpanLookup,
}: NormalizedAnalyzeProgramOptions): {
  collect: (node: Node, ancestors: Node[]) => void;
  result: RequestAnalysis;
} => {
  const result: RequestAnalysis = {
    hasEffectiveMutationHazardSeed: false,
    ignoredMutationHazardNodes: new Set(),
    ignoredMutationHazardTreeNodes: new Set(),
    processorManagedExpressionNodes: new Set(),
    targetExpressions: [],
    templateLiterals: [],
  };

  const collect = (node: Node, ancestors: Node[]): void => {
    if (mutationHazardIgnoreLookup) {
      registerMutationHazardNode(
        node,
        mutationHazardIgnoreLookup,
        mutationHazardIgnoreTreeLookup,
        result.processorManagedExpressionNodes,
        result.ignoredMutationHazardNodes,
        result.ignoredMutationHazardTreeNodes
      );
    } else if (mutationHazardIgnoreTreeLookup) {
      registerMutationHazardNode(
        node,
        null,
        mutationHazardIgnoreTreeLookup,
        result.processorManagedExpressionNodes,
        result.ignoredMutationHazardNodes,
        result.ignoredMutationHazardTreeNodes
      );
    }
    result.hasEffectiveMutationHazardSeed ||= isEffectiveMutationHazardSeed(
      node,
      result.ignoredMutationHazardNodes
    );

    if (
      collectTemplateLiterals &&
      node.type === 'TemplateLiteral' &&
      node.expressions.length > 0 &&
      !ancestors.some((ancestor) => ancestor.type === 'TemplateLiteral') &&
      matchesSpanLookup(node, templateSpanLookup)
    ) {
      result.templateLiterals.push(node);
    }

    if (
      collectTargetExpressions &&
      expressionSpanLookup &&
      matchesSpanLookup(node, expressionSpanLookup)
    ) {
      result.targetExpressions.push(node as Expression);
    }
  };

  return { collect, result };
};

const collectRequestAnalysis = (
  program: Program,
  collect: (node: Node, ancestors: Node[]) => void
): void => {
  const ancestors: Node[] = [];
  const visit = (node: Node): void => {
    collect(node, ancestors);
    ancestors.push(node);
    getOxcNodeChildren(node).forEach(visit);
    ancestors.pop();
  };

  visit(program);
};

const buildProgramScopeFacts = (
  program: Program,
  collectRequestNode?: (node: Node, ancestors: Node[]) => void
): ProgramScopeFacts => {
  const bindings = new Map<string, Binding[]>();
  const usedNames = new Set<string>();
  const referenceScopesByStart = new Map<number, Scope>();

  const addBinding = (scope: Scope, binding: Binding): void => {
    scope.bindings.set(binding.name, binding);
    const existing = bindings.get(binding.name) ?? [];
    existing.push(binding);
    bindings.set(binding.name, existing);
  };

  const collectScopeNode = (
    node: Node,
    scope: Scope,
    parent: Node | null,
    ancestors: Node[],
    runtime: boolean,
    reference: boolean
  ): void => {
    collectRequestNode?.(node, ancestors);

    if (node.type === 'Identifier') {
      usedNames.add(node.name);
    }

    if (reference) {
      referenceScopesByStart.set(node.start, scope);
    }

    if (!runtime) {
      return;
    }

    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      if (node.type === 'FunctionExpression' && node.id) {
        const binding = scope.bindings.get(node.id.name);
        if (binding) {
          addBinding(scope, binding);
        }
      }

      node.params.forEach((param) => {
        collectOxcPatternBindingNames(param).forEach((name) => {
          const binding = scope.bindings.get(name);
          if (binding) {
            addBinding(scope, binding);
          }
        });
      });

      if (node.type !== 'FunctionDeclaration') {
        return;
      }
    }

    if (node.type === 'ClassExpression' && node.id) {
      const binding = scope.bindings.get(node.id.name);
      if (binding) {
        addBinding(scope, binding);
      }
      return;
    }

    if (node.type === 'ImportDeclaration') {
      const source = node.source.value;
      node.specifiers.forEach((specifier) => {
        const importInfo = getImportSpecifierInfo(node, specifier);
        if (!importInfo) {
          return;
        }

        addBinding(scope, {
          declaredAt: specifier.start,
          declaration: null,
          declarator: null,
          functionNode: null,
          imported: importInfo.imported,
          importedFrom: source,
          isRoot: scope.root,
          kind: 'import',
          name: importInfo.local,
          scope,
        });
      });
      return;
    }

    if (node.type === 'CatchClause' && node.param) {
      collectOxcPatternBindingNames(node.param).forEach((name) => {
        const binding = scope.bindings.get(name);
        if (binding) {
          addBinding(scope, binding);
        }
      });
      return;
    }

    if (node.type !== 'VariableDeclaration') {
      if (node.type === 'FunctionDeclaration' && node.id) {
        const declarationScope = scope.parent ?? scope;
        const binding: Binding = {
          declaredAt: node.start,
          declaration: null,
          declarator: null,
          functionNode: node,
          isRoot: declarationScope.root,
          kind: 'function',
          name: node.id.name,
          scope: declarationScope,
        };
        addBinding(declarationScope, binding);
      }

      if (node.type === 'ClassDeclaration' && node.id) {
        addBinding(scope, {
          declarationKind: 'let',
          declaredAt: node.start,
          declaration: null,
          declarator: null,
          functionNode: null,
          isRoot: scope.root,
          kind: 'variable',
          name: node.id.name,
          scope,
        });
      }

      return;
    }

    node.declarations.forEach((declarator) => {
      collectOxcPatternBindingNames(declarator.id).forEach((name) => {
        const declarationKind = normalizeDeclarationKind(node.kind);
        const declarationScope = getDeclarationScope(scope, declarationKind);
        const preservesInitializer =
          declarationKind !== 'var' || hasStraightLineVarInitializer(ancestors);
        const binding: Binding = {
          declarationKind,
          declaredAt: declarator.start,
          declaration: node,
          declarator: preservesInitializer ? declarator : null,
          functionNode: null,
          isIteration:
            (parent?.type === 'ForInStatement' ||
              parent?.type === 'ForOfStatement') &&
            parent.left === node,
          isRoot: declarationScope.root,
          kind: 'variable',
          name,
          scope: declarationScope,
        };
        addBinding(declarationScope, binding);
      });
    });
  };
  visitOxcScopes(program, null, collectScopeNode);

  // The contained maps/scopes are completed before publication and exposed
  // through readonly types. Freeze the shared top-level identity only; deep
  // snapshots would duplicate the program-sized graph this cache reuses.
  const bindingIndex = Object.freeze(
    createBindingIndex(bindings, referenceScopesByStart)
  );
  return Object.freeze({
    bindingIndex,
    usedNames: createImmutableUsedNames(usedNames),
  });
};

export const analyzeProgram = (
  program: Program,
  options: AnalyzeProgramOptions = {}
): ProgramAnalysis => {
  const normalizedOptions = normalizeAnalyzeProgramOptions(options);
  const cacheKey = programAnalysisCacheKey(normalizedOptions);
  const cached = getCachedProgramAnalysis(program, cacheKey);
  if (cached) {
    return cached;
  }

  const {
    collectTargetExpressions = false,
    collectTemplateLiterals = false,
    expressionSpanLookup = null,
    mutationHazardIgnoreLookup = null,
    mutationHazardIgnoreTreeLookup = null,
  } = normalizedOptions;
  const request = createRequestAnalysis(normalizedOptions);
  let scopeFacts = programScopeFacts.get(program);
  const cachedDefaultMutationHazards =
    mutationHazardIgnoreLookup || mutationHazardIgnoreTreeLookup
      ? undefined
      : programDefaultMutationHazards.get(program);
  const cachedDefaultMutationHazardGuards =
    mutationHazardIgnoreLookup || mutationHazardIgnoreTreeLookup
      ? undefined
      : programDefaultMutationHazardGuards.get(program);
  const needsRequestTraversal =
    mutationHazardIgnoreLookup !== null ||
    mutationHazardIgnoreTreeLookup !== null ||
    cachedDefaultMutationHazards === undefined ||
    collectTemplateLiterals ||
    (collectTargetExpressions && expressionSpanLookup !== null);

  if (!scopeFacts) {
    scopeFacts = buildProgramScopeFacts(program, request.collect);
    programScopeFacts.set(program, scopeFacts);
  } else if (needsRequestTraversal) {
    collectRequestAnalysis(program, request.collect);
  }

  let rootMutationHazardsByBinding = cachedDefaultMutationHazards;
  let rootMutationHazardGuardsByBinding = cachedDefaultMutationHazardGuards;
  let rootMutationsByBinding = programRootMutations.get(program);
  if (!rootMutationHazardsByBinding) {
    const mutationAnalysis = collectProgramMutationAnalysis(
      program,
      scopeFacts.bindingIndex,
      request.result.processorManagedExpressionNodes,
      request.result.ignoredMutationHazardNodes,
      request.result.ignoredMutationHazardTreeNodes,
      request.result.hasEffectiveMutationHazardSeed
    );
    rootMutationHazardsByBinding =
      mutationAnalysis.rootMutationHazardsByBinding;
    rootMutationHazardGuardsByBinding =
      mutationAnalysis.rootMutationHazardGuardsByBinding;
    rootMutationsByBinding ??= mutationAnalysis.rootMutationsByBinding;
    if (!programRootMutations.has(program)) {
      programRootMutations.set(program, rootMutationsByBinding);
    }
    if (!mutationHazardIgnoreLookup && !mutationHazardIgnoreTreeLookup) {
      programDefaultMutationHazards.set(program, rootMutationHazardsByBinding);
      programDefaultMutationHazardGuards.set(
        program,
        rootMutationHazardGuardsByBinding
      );
    }
  }

  const targetExpressions = request.result.targetExpressions.sort(
    (a, b) => a.start - b.start
  );
  Object.freeze(targetExpressions);
  Object.freeze(request.result.templateLiterals);
  const analysis: ProgramAnalysis = {
    bindingIndex: scopeFacts.bindingIndex,
    rootMutationHazardGuardsByBinding: rootMutationHazardGuardsByBinding!,
    rootMutationHazardsByBinding,
    rootMutationsByBinding: rootMutationsByBinding!,
    targetExpressions,
    templateLiterals: request.result.templateLiterals,
    usedNames: scopeFacts.usedNames,
  };

  return cacheProgramAnalysis(program, cacheKey, Object.freeze(analysis));
};
