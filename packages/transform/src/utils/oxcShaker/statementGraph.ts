/* eslint-disable no-continue, no-restricted-syntax */

import type { Node, Program } from 'oxc-parser';

import type { ImportOverrides } from '@wyw-in-js/shared';

import { collectOxcExportsAndImportsFromProgram } from '../collectOxcExportsAndImports';
import type {
  collectOxcExportsAndImports,
  OxcCollectedImport,
} from '../collectOxcExportsAndImports';
import type { OxcEdit } from '../oxc/fileEdits';
import { collectOxcPatternIdentifierNames as collectPatternNames } from '../oxc/patterns';
import { createCallableProvenanceIndex } from './callableProvenanceIndex';
import {
  collectMutations,
  collectNestedMutations,
  collectModuleReferences,
  forEachModuleExecutedNode,
} from './executableIndex';
import { createStableInitializerResolver } from './initializerStability';
import {
  finalizeShakenModule,
  hasImportOverride,
  parseShakerModule,
  removeExportKeyword,
  splitExportedVariableDeclaration,
} from './moduleRewrites';
import {
  collectModuleInvocationEffects,
  createModuleInvocationAnalysisState,
} from './moduleInvocationEffects';
import {
  isPattern,
  isProvenNonAbruptPatternEvaluation,
  isReceiverOperationProvenInert as proveReceiverOperationInert,
  type PatternInitializerResolver,
} from './patternEffects';
import { createShakerProgramFactsCache } from './programFactsCache';

type AnyNode = Node & Record<string, unknown>;

type OxcShakerOptions = {
  importOverrides?: ImportOverrides;
  keepSideEffects?: boolean;
  onlyExports: string[];
  root?: string;
};

type StatementInfo = {
  bindings: Set<string>;
  exportNames: Set<string>;
  imports: OxcCollectedImport[];
  mutations: Set<string>;
  node: Node;
  references: Set<string>;
  sideEffectImport: boolean;
};

export type OxcShakerResult = {
  code: string;
  imports: Map<string, string[]>;
};

const declarationBindings = (
  declaration: Node | null | undefined
): string[] => {
  if (!declaration) {
    return [];
  }

  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.flatMap((item) =>
      collectPatternNames(item.id)
    );
  }

  if (
    (declaration.type === 'FunctionDeclaration' ||
      declaration.type === 'ClassDeclaration' ||
      declaration.type === 'TSEnumDeclaration') &&
    declaration.id
  ) {
    return [declaration.id.name];
  }

  return [];
};

const moduleExportName = (node: Node): string | null => {
  if (node.type === 'Identifier' || node.type === 'Literal') {
    return String((node as AnyNode).name ?? (node as AnyNode).value);
  }

  return null;
};

const hasPotentiallyAbruptPatternEvaluation = (
  node: Node,
  resolveInitializer: PatternInitializerResolver
): boolean => {
  let potentiallyAbrupt = false;
  forEachModuleExecutedNode(node, (current) => {
    if (potentiallyAbrupt) {
      return;
    }

    if (current.type === 'VariableDeclaration') {
      potentiallyAbrupt = current.declarations.some(
        (declarator) =>
          isPattern(declarator.id) &&
          (!declarator.init ||
            !isProvenNonAbruptPatternEvaluation(
              declarator.id,
              declarator.init,
              resolveInitializer
            ))
      );
      return;
    }

    if (
      current.type === 'AssignmentExpression' &&
      current.operator === '=' &&
      isPattern(current.left)
    ) {
      potentiallyAbrupt = !isProvenNonAbruptPatternEvaluation(
        current.left,
        current.right,
        resolveInitializer
      );
    }
  });
  return potentiallyAbrupt;
};

const buildStatementInfo = (
  program: Program,
  collected: ReturnType<typeof collectOxcExportsAndImports>
): StatementInfo[] => {
  const { exports: collectedExports, imports: collectedImports } = collected;
  const importsByStart = new Map<number, OxcCollectedImport[]>();
  collectedImports.forEach((item) => {
    const bucket = importsByStart.get(item.local.start) ?? [];
    bucket.push(item);
    importsByStart.set(item.local.start, bucket);
  });

  return program.body.map((statement) => {
    const node = statement as Node;
    const exportNames = new Set<string>();
    const bindings = new Set<string>();
    const imports: OxcCollectedImport[] = [];
    const references = collectModuleReferences(node);
    let sideEffectImport = false;

    if (node.type === 'ImportDeclaration') {
      sideEffectImport = node.specifiers.length === 0;
      node.specifiers.forEach((specifier) => {
        bindings.add(specifier.local.name);
        const matched = importsByStart.get(specifier.local.start) ?? [];
        imports.push(...matched);
      });

      if (sideEffectImport) {
        const matched = collectedImports.filter(
          (item) =>
            item.imported === 'side-effect' &&
            item.local.start === node.start &&
            item.local.end === node.end
        );
        imports.push(...matched);
      }
    } else if (node.type === 'ExportNamedDeclaration') {
      declarationBindings(node.declaration).forEach((name) =>
        bindings.add(name)
      );
      if (node.declaration) {
        declarationBindings(node.declaration).forEach((name) =>
          exportNames.add(name)
        );
      }

      node.specifiers.forEach((specifier) => {
        const local = moduleExportName(specifier.local);
        const exported = moduleExportName(specifier.exported);
        if (local && !node.source) references.add(local);
        if (exported) exportNames.add(exported);
      });
    } else if (node.type === 'ExportDefaultDeclaration') {
      exportNames.add('default');
      declarationBindings(node.declaration).forEach((name) =>
        bindings.add(name)
      );
    } else if (node.type === 'ExportAllDeclaration') {
      if (node.exported) {
        const exported = moduleExportName(node.exported);
        if (exported) {
          exportNames.add(exported);
        }
      } else {
        exportNames.add('*');
      }
    } else {
      Object.entries(collectedExports).forEach(([exported, local]) => {
        if (local.start >= node.start && local.end <= node.end) {
          exportNames.add(exported);
        }
      });
      declarationBindings(node).forEach((name) => bindings.add(name));
    }

    return {
      bindings,
      exportNames,
      imports,
      mutations: collectMutations(node),
      node,
      references,
      sideEffectImport,
    };
  });
};

const buildShakerProgramFacts = (
  program: Program,
  code: string,
  isEsModule: boolean
) => {
  const collected = collectOxcExportsAndImportsFromProgram(
    program,
    code,
    isEsModule
  );
  const statements = buildStatementInfo(program, collected);
  const bindingOwners = new Map<string, StatementInfo>();
  statements.forEach((statement) => {
    statement.bindings.forEach((binding) => {
      if (!bindingOwners.has(binding)) {
        bindingOwners.set(binding, statement);
      }
    });
  });
  const patternInitializers = new Map<
    string,
    {
      declarationKind: string;
      owner: StatementInfo;
      value: Node;
    }
  >();
  program.body.forEach((statement, index) => {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportDefaultDeclaration'
        ? statement.declaration
        : statement;
    if (declaration?.type !== 'VariableDeclaration') {
      return;
    }

    declaration.declarations.forEach((declarator) => {
      if (declarator.id.type === 'Identifier' && declarator.init) {
        patternInitializers.set(declarator.id.name, {
          declarationKind: declaration.kind,
          owner: statements[index]!,
          value: declarator.init,
        });
      } else if (
        declarator.init &&
        (declarator.id.type === 'ObjectPattern' ||
          declarator.id.type === 'ArrayPattern')
      ) {
        const elements =
          declarator.id.type === 'ObjectPattern'
            ? declarator.id.properties
            : declarator.id.elements;
        elements.forEach((element) => {
          if (
            element?.type === 'RestElement' &&
            element.argument.type === 'Identifier'
          ) {
            patternInitializers.set(element.argument.name, {
              declarationKind: declaration.kind,
              owner: statements[index]!,
              value: declarator.init!,
            });
          }
        });
      }
    });
  });

  const effectsByBinding = new Map<string, Set<StatementInfo>>();
  const receiverEffectsByBinding = new Map<string, Set<StatementInfo>>();
  const nestedReceiverEffectsByBinding = new Map<string, Set<StatementInfo>>();
  const earliestNestedReceiverEffect = new Map<string, number>();
  const nestedImportedReceiverEffects = new Set<StatementInfo>();
  const callableResultEffects = new Map<string, Set<StatementInfo>>();
  let effectVersion = 0;

  const addEffect = (binding: string, statement: StatementInfo): void => {
    const bucket = effectsByBinding.get(binding) ?? new Set<StatementInfo>();
    if (!bucket.has(statement)) {
      bucket.add(statement);
      effectVersion += 1;
    }
    effectsByBinding.set(binding, bucket);
  };

  const addReceiverEffect = (
    binding: string,
    statement: StatementInfo
  ): void => {
    addEffect(binding, statement);
    const bucket =
      receiverEffectsByBinding.get(binding) ?? new Set<StatementInfo>();
    if (!bucket.has(statement)) {
      bucket.add(statement);
      effectVersion += 1;
    }
    receiverEffectsByBinding.set(binding, bucket);
  };

  statements.forEach((statement) => {
    statement.mutations.forEach((binding) => {
      addReceiverEffect(binding, statement);
    });
  });

  const callableProvenance = createCallableProvenanceIndex({
    bindingOwners,
    program,
  });
  const addNestedImportedReceiverEffect = (statement: StatementInfo): void => {
    if (!nestedImportedReceiverEffects.has(statement)) {
      nestedImportedReceiverEffects.add(statement);
      effectVersion += 1;
    }
  };
  const addNestedReceiverEffect = (
    binding: string,
    statement: StatementInfo
  ): void => {
    const component = callableProvenance.aliasComponentId(binding);
    const bucket =
      nestedReceiverEffectsByBinding.get(component) ?? new Set<StatementInfo>();
    if (!bucket.has(statement)) {
      bucket.add(statement);
      effectVersion += 1;
      const pending = [component];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const current = pending.pop()!;
        const currentComponent = callableProvenance.aliasComponentId(current);
        if (visited.has(currentComponent)) {
          continue;
        }
        visited.add(currentComponent);
        const earliest = earliestNestedReceiverEffect.get(currentComponent);
        if (earliest !== undefined && earliest <= statement.node.start) {
          continue;
        }
        earliestNestedReceiverEffect.set(
          currentComponent,
          statement.node.start
        );
        callableProvenance
          .nestedAliasSources(currentComponent)
          .forEach((source) => pending.push(source));
      }
    }
    nestedReceiverEffectsByBinding.set(component, bucket);
    if (callableProvenance.nestedAliasesImportedRoot(component)) {
      addNestedImportedReceiverEffect(statement);
    }
  };
  const noNestedAliasSources = {
    mayAliasAnyRootImport: false,
    sources: new Set<string>(),
  };
  const collectNestedAliasSources = (bindings: Iterable<string>) => {
    const sources = new Set<string>();
    const visited = new Set<string>();
    const pending = [...bindings];
    let mayAliasAnyRootImport = false;
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      const current = pending[cursor]!;
      const componentId = callableProvenance.aliasComponentId(current);
      if (!visited.has(componentId)) {
        visited.add(componentId);
        mayAliasAnyRootImport ||=
          callableProvenance.nestedAliasesImportedRoot(current);
        callableProvenance.nestedAliasSources(current).forEach((source) => {
          sources.add(source);
          pending.push(source);
        });
      }
    }
    return { mayAliasAnyRootImport, sources };
  };

  // Import binding identity is not knowable at the root module boundary.
  // Therefore a module-executed mutation through any imported alias, or an
  // opaque imported call, can affect every otherwise-live root import.
  const importedEffects = new Set<StatementInfo>();

  const bindingEffectsBefore = (
    binding: string,
    statement: StatementInfo
  ): Set<StatementInfo> => {
    const effects = new Set<StatementInfo>();
    const component =
      callableProvenance.aliasComponents.get(binding) ?? new Set([binding]);
    component.forEach((alias) => {
      effectsByBinding.get(alias)?.forEach((effect) => {
        if (effect.node.start < statement.node.start) {
          effects.add(effect);
        }
      });
    });
    return effects;
  };

  const resolveStableInitializer = createStableInitializerResolver({
    aliasComponents: callableProvenance.aliasComponents,
    effectsByBinding,
    getEffectVersion: () => effectVersion,
    patternInitializers,
  });

  const receiverReferences = new Map<StatementInfo, Set<string>>();
  const getReceiverReferences = (statement: StatementInfo): Set<string> => {
    const cached = receiverReferences.get(statement);
    if (cached) {
      return cached;
    }

    const references = new Set(statement.references);
    callableProvenance
      .getExternalStatementReferences(statement)
      .forEach((reference) => references.add(reference));
    receiverReferences.set(statement, references);
    return references;
  };

  type ReceiverRootDemand = {
    effectVersion: number;
    roots: Set<string>;
  };

  const resolveReceiverOperationRoots = (
    binding: string,
    statement: StatementInfo,
    demandCache: Map<string, ReceiverRootDemand>
  ): Set<string> => {
    const rootComponent = callableProvenance.aliasComponentId(binding);
    const cached = demandCache.get(rootComponent);
    if (cached?.effectVersion === effectVersion) {
      return cached.roots;
    }

    const roots = new Set<string>();
    const visitedComponents = new Set<string>();
    const visitedNestedHistoryComponents = new Set<string>();
    const visitedEffects = new Set<StatementInfo>();
    const pending = [rootComponent];
    const pendingNestedHistory: string[] = [];
    let visitedImportedNestedHistory = false;

    const addReferences = (
      owner: StatementInfo,
      effect?: StatementInfo
    ): void => {
      const references = getReceiverReferences(owner);
      references.forEach((reference) => {
        roots.add(reference);
        if (bindingOwners.has(reference)) {
          pending.push(callableProvenance.aliasComponentId(reference));
        }
        if (effect) {
          addReceiverEffect(reference, effect);
        }
      });
    };

    const addHistory = (
      history: ReadonlySet<StatementInfo> | undefined
    ): void =>
      history?.forEach((effect) => {
        if (
          effect.node.start >= statement.node.start ||
          visitedEffects.has(effect)
        ) {
          return;
        }
        visitedEffects.add(effect);
        addReferences(effect, effect);
      });

    const addBindingHistory = (
      current: string,
      history: ReadonlyMap<string, ReadonlySet<StatementInfo>>
    ): void => {
      const component =
        callableProvenance.aliasComponents.get(current) ?? new Set([current]);
      component.forEach((alias) => addHistory(history.get(alias)));
    };

    while (pending.length > 0 || pendingNestedHistory.length > 0) {
      if (pending.length === 0) {
        const current = pendingNestedHistory.pop()!;
        const componentId = callableProvenance.aliasComponentId(current);
        if (visitedNestedHistoryComponents.has(componentId)) {
          continue;
        }
        visitedNestedHistoryComponents.add(componentId);
        if (
          (earliestNestedReceiverEffect.get(componentId) ?? Infinity) >=
          statement.node.start
        ) {
          continue;
        }
        addHistory(nestedReceiverEffectsByBinding.get(componentId));
        callableProvenance
          .nestedAliasDependents(componentId)
          .forEach((dependent) => pendingNestedHistory.push(dependent));
        continue;
      }

      const current = pending.pop()!;
      const componentId = callableProvenance.aliasComponentId(current);
      if (visitedComponents.has(componentId)) {
        continue;
      }
      visitedComponents.add(componentId);
      addBindingHistory(componentId, receiverEffectsByBinding);
      pendingNestedHistory.push(componentId);
      if (
        !visitedImportedNestedHistory &&
        callableProvenance.aliasesImportedRoot(componentId)
      ) {
        visitedImportedNestedHistory = true;
        addHistory(nestedImportedReceiverEffects);
      }
      const component =
        callableProvenance.aliasComponents.get(current) ?? new Set([current]);
      component.forEach((alias) => {
        roots.add(alias);
        const owner = bindingOwners.get(alias);
        if (owner) {
          addReferences(owner);
        }
      });
      callableProvenance
        .nestedAliasSources(current)
        .forEach((source) => pending.push(source));
      if (callableProvenance.nestedAliasesImportedRoot(current)) {
        callableProvenance.rootImportedBindings.forEach((source) =>
          pending.push(source)
        );
      }
    }

    demandCache.set(rootComponent, { effectVersion, roots });
    return roots;
  };

  const invocationAnalysisState = createModuleInvocationAnalysisState();
  statements.forEach((statement) => {
    if ([...statement.mutations].some(callableProvenance.aliasesImportedRoot)) {
      importedEffects.add(statement);
    }

    const nestedMutations = callableProvenance.hasNestedAliases
      ? collectNestedMutations(statement.node)
      : noNestedAliasSources.sources;
    nestedMutations.forEach((binding) =>
      addNestedReceiverEffect(binding, statement)
    );
    const nestedMutationSources = callableProvenance.hasNestedAliases
      ? collectNestedAliasSources(nestedMutations)
      : noNestedAliasSources;
    if (nestedMutationSources.mayAliasAnyRootImport) {
      addNestedImportedReceiverEffect(statement);
    }
    nestedMutationSources.sources.forEach((source) =>
      addEffect(source, statement)
    );
    if (nestedMutationSources.mayAliasAnyRootImport) {
      callableProvenance.rootImportedBindings.forEach((binding) =>
        addEffect(binding, statement)
      );
    }
    if (
      nestedMutationSources.mayAliasAnyRootImport ||
      [...nestedMutationSources.sources].some(
        callableProvenance.aliasesImportedRoot
      )
    ) {
      importedEffects.add(statement);
    }

    const receiverRootDemands = new Map<string, ReceiverRootDemand>();
    const invocation = collectModuleInvocationEffects(
      statement.node,
      callableProvenance,
      (operation) =>
        proveReceiverOperationInert(operation, {
          arrayPrototypeStable:
            bindingEffectsBefore('Array', statement).size === 0,
          objectPrototypeStable:
            bindingEffectsBefore('Object', statement).size === 0,
          resolveInitializer: (name) =>
            resolveStableInitializer(statement, name),
        }),
      (binding) =>
        resolveReceiverOperationRoots(binding, statement, receiverRootDemands),
      invocationAnalysisState
    );
    if (invocation.opaqueImportedCall) {
      importedEffects.add(statement);
    }
    invocation.callableResultPaths.forEach((path) => {
      const effects = callableResultEffects.get(path) ?? new Set();
      effects.add(statement);
      callableResultEffects.set(path, effects);
    });
    invocation.bindings.forEach((binding) => {
      if (bindingOwners.has(binding)) {
        addEffect(binding, statement);
      }
      if (callableProvenance.aliasesImportedRoot(binding)) {
        addEffect(binding, statement);
        importedEffects.add(statement);
      }
    });
    invocation.effectOrigins.forEach((binding) => {
      if (
        bindingOwners.has(binding) ||
        callableProvenance.aliasesImportedRoot(binding)
      ) {
        addReceiverEffect(binding, statement);
      }
      if (callableProvenance.hasNestedAliases) {
        addNestedReceiverEffect(binding, statement);
      }
    });
    const nestedInvocationSources = callableProvenance.hasNestedAliases
      ? collectNestedAliasSources(invocation.bindings)
      : noNestedAliasSources;
    if (nestedInvocationSources.mayAliasAnyRootImport) {
      addNestedImportedReceiverEffect(statement);
    }
    nestedInvocationSources.sources.forEach((source) =>
      addEffect(source, statement)
    );
    if (nestedInvocationSources.mayAliasAnyRootImport) {
      callableProvenance.rootImportedBindings.forEach((binding) =>
        addEffect(binding, statement)
      );
    }
    if (
      nestedInvocationSources.mayAliasAnyRootImport ||
      [...nestedInvocationSources.sources].some(
        callableProvenance.aliasesImportedRoot
      )
    ) {
      importedEffects.add(statement);
    }
  });
  callableProvenance.rootImportedBindings.forEach((binding) => {
    importedEffects.forEach((effect) => addEffect(binding, effect));
  });

  callableProvenance.aliasComponents.forEach((component, binding) => {
    if (component.values().next().value !== binding) {
      return;
    }

    const effects = new Set<StatementInfo>();
    component.forEach((alias) => {
      effectsByBinding.get(alias)?.forEach((effect) => effects.add(effect));
    });
    component.forEach((alias) => {
      if (effects.size > 0) {
        effectsByBinding.set(alias, effects);
      }
    });
  });

  const potentiallyAbruptStatements = statements.filter((statement) =>
    hasPotentiallyAbruptPatternEvaluation(statement.node, (name) =>
      resolveStableInitializer(statement, name, 'evaluation')
    )
  );

  return Object.freeze({
    bindingOwners: bindingOwners as ReadonlyMap<string, StatementInfo>,
    callableProvenance,
    callableResultEffects: callableResultEffects as ReadonlyMap<
      string,
      ReadonlySet<StatementInfo>
    >,
    effectsByBinding: effectsByBinding as ReadonlyMap<
      string,
      ReadonlySet<StatementInfo>
    >,
    potentiallyAbruptStatements: Object.freeze(potentiallyAbruptStatements),
    statements: Object.freeze(statements),
  });
};

type ShakerProgramFacts = ReturnType<typeof buildShakerProgramFacts>;

const getShakerProgramFacts = createShakerProgramFactsCache<ShakerProgramFacts>(
  buildShakerProgramFacts
);

export const shakeOxcToESM = (
  code: string,
  filename: string,
  options: OxcShakerOptions
): OxcShakerResult => {
  const parsed = parseShakerModule(code, filename);
  const {
    bindingOwners,
    callableProvenance,
    callableResultEffects,
    effectsByBinding,
    potentiallyAbruptStatements,
    statements,
  } = getShakerProgramFacts(parsed.program, code, parsed.isEsModule);
  const requested = new Set(options.onlyExports);
  const keepAllExports = requested.has('*');
  const liveStatements = new Set<StatementInfo>();
  const liveExportStatements = new Set<StatementInfo>();
  const queue: StatementInfo[] = [];
  const bindingQueue: string[] = [];
  const liveBindings = new Set<string>();

  const mark = (statement: StatementInfo, exported = false): void => {
    if (!liveStatements.has(statement)) {
      liveStatements.add(statement);
      queue.push(statement);
    }

    if (exported) {
      liveExportStatements.add(statement);
    }
  };

  const visitedCallableResultEffects = new Set<string>();
  const markBinding = (binding: string): void => {
    const owner = bindingOwners.get(binding);
    if (!owner || liveBindings.has(binding)) {
      return;
    }

    liveBindings.add(binding);
    bindingQueue.push(binding);
    mark(owner);
    callableProvenance.visitCallableResultDependents(
      binding,
      visitedCallableResultEffects,
      (path) =>
        callableResultEffects.get(path)?.forEach((effect) => mark(effect))
    );
  };

  potentiallyAbruptStatements.forEach((statement) => mark(statement));

  statements.forEach((statement) => {
    const hasWildcardReexport = statement.exportNames.has('*');
    const selectedExports = [...statement.exportNames].filter(
      (name) =>
        keepAllExports ||
        (name === '*' && requested.size > 0 && !requested.has('side-effect')) ||
        requested.has(name)
    );
    if (
      statement.exportNames.size > 0 &&
      (keepAllExports ||
        (hasWildcardReexport &&
          requested.size > 0 &&
          !requested.has('side-effect')) ||
        selectedExports.length > 0)
    ) {
      mark(statement, true);
      const directBindings = [...statement.bindings].filter((binding) =>
        selectedExports.includes(binding)
      );
      if (directBindings.length === 0 && selectedExports.includes('default')) {
        statement.bindings.forEach(markBinding);
      } else {
        directBindings.forEach(markBinding);
      }
    }

    if (
      statement.sideEffectImport &&
      (requested.has('side-effect') ||
        options.keepSideEffects ||
        statement.imports.some((item) =>
          hasImportOverride(item.source, options)
        ))
    ) {
      mark(statement);
    }
  });

  let statementQueueCursor = 0;
  let bindingQueueCursor = 0;
  while (
    statementQueueCursor < queue.length ||
    bindingQueueCursor < bindingQueue.length
  ) {
    if (statementQueueCursor < queue.length) {
      const current = queue[statementQueueCursor]!;
      statementQueueCursor += 1;
      current.references.forEach(markBinding);
    } else {
      const binding = bindingQueue[bindingQueueCursor]!;
      bindingQueueCursor += 1;
      effectsByBinding.get(binding)?.forEach((effect) => {
        mark(effect);
      });
    }
  }

  const replacements: OxcEdit[] = [];
  statements.forEach((statement) => {
    if (!liveStatements.has(statement)) {
      replacements.push({
        end: statement.node.end,
        start: statement.node.start,
        value: '',
      });
      return;
    }

    if (!liveExportStatements.has(statement)) {
      const replacement = removeExportKeyword(code, statement.node);
      if (replacement) {
        replacements.push(replacement);
      }
      return;
    }

    const splitReplacement = splitExportedVariableDeclaration(
      code,
      statement.node,
      requested
    );
    if (splitReplacement) {
      replacements.push(splitReplacement);
    }
  });

  return finalizeShakenModule(code, filename, replacements, options);
};
