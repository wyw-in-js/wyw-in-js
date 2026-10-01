/* eslint-disable no-restricted-syntax */

import type { Node, Program } from 'oxc-parser';
import {
  collectRootImportedBindings,
  createCallableCatalogResolver,
  createAliasComponentIndex,
  createStatementReferenceCollector,
} from './callableCatalogResolver';

import { isOxcNode as isNode } from '../oxc/ast';
import { collectOxcPatternIdentifierNames as collectPatternNames } from '../oxc/patterns';
import {
  appendOxcRuntimePropertyPath,
  appendOxcRuntimePropertyPathKey,
  createOxcRuntimePropertyPath,
  getOxcRuntimePropertyPathKeyRoot,
  isOxcRuntimePropertyPathKeyEqualOrDescendant,
  replaceOxcRuntimePropertyPathKeyRoot,
  replaceOxcRuntimePropertyPathRoot,
  type OxcRuntimePropertyPathKey,
} from '../oxc/projections';
import {
  aliasesImportedRootInState,
  collectAssignedAliasRoots,
  collectTopLevelAccessors,
  collectTopLevelAliases,
  collectTopLevelCallables,
  collectTopLevelClasses,
  getAliasComponentId,
  getCalleeBinding,
  getStaticMemberPath,
  type ClassNode,
} from './bindingProvenance';
import {
  collectExternalReferences,
  forEachModuleExecutedNode,
  getImmediatelyInvokedFunction,
  unwrapAliasExpression,
  type CallableNode,
} from './executableIndex';
import { createCallableSyntaxFactsCache } from './callableSyntaxFacts';
import {
  createMutableProvenanceClosureNode,
  createProvenanceClosureIndex,
  mergeProvenanceClosureNode,
  resolveProvenanceAliases,
  type MutableProvenanceClosureNode,
  type TaggedBindingProvenance,
} from './provenanceClosure';

type AnyNode = Node & Record<string, unknown>;
type StatementOwner = { node: Node };

export type AliasEnvironment = ReadonlyMap<string, ReadonlySet<string>>;

const IMPORTED_ROOT_COHORT = '\0wyw-imported-root-cohort';

export const createCallableProvenanceIndex = ({
  bindingOwners,
  program,
}: {
  bindingOwners: ReadonlyMap<string, StatementOwner>;
  program: Program;
}) => {
  const getCallableSyntaxFacts = createCallableSyntaxFactsCache();
  const rootImportedBindings = collectRootImportedBindings(program);

  // Component effects pull otherwise-dead alias declarations into liveness.
  const topLevelAliasState = collectTopLevelAliases(
    program,
    rootImportedBindings
  );
  const {
    importedRootAliasBindings,
    nestedAliases: topLevelNestedAliases,
    nestedImportedRootAliasBindings,
  } = topLevelAliasState;
  const aliasComponentId = (binding: string): string =>
    getAliasComponentId(topLevelAliasState, binding);
  const aliasesImportedRoot = (binding: string): boolean =>
    aliasesImportedRootInState(topLevelAliasState, binding);
  const getProvenanceComponentRoot = (binding: string): string =>
    aliasesImportedRoot(binding)
      ? IMPORTED_ROOT_COHORT
      : aliasComponentId(binding);
  const normalizeProvenancePath = (
    path: OxcRuntimePropertyPathKey
  ): OxcRuntimePropertyPathKey =>
    replaceOxcRuntimePropertyPathKeyRoot(
      path,
      getProvenanceComponentRoot(getOxcRuntimePropertyPathKeyRoot(path))
    );
  const aliasComponents = createAliasComponentIndex(topLevelAliasState);

  const directNestedAliasSources = new Map<string, Set<string>>();
  const directNestedAliasDependents = new Map<string, Set<string>>();
  topLevelNestedAliases.forEach((sources, nestedCopy) => {
    const componentId = aliasComponentId(nestedCopy);
    const directSources =
      directNestedAliasSources.get(componentId) ?? new Set();
    sources.forEach((source) => {
      const sourceComponent = aliasComponentId(source);
      directSources.add(sourceComponent);
      const directDependents =
        directNestedAliasDependents.get(sourceComponent) ?? new Set();
      directDependents.add(componentId);
      directNestedAliasDependents.set(sourceComponent, directDependents);
    });
    directNestedAliasSources.set(componentId, directSources);
  });
  const nestedImportedRootComponents = new Set(
    [...nestedImportedRootAliasBindings].map(aliasComponentId)
  );
  const nestedAliasSources = (binding: string): Set<string> =>
    new Set(directNestedAliasSources.get(aliasComponentId(binding)));
  const nestedAliasDependents = (binding: string): Set<string> =>
    new Set(directNestedAliasDependents.get(aliasComponentId(binding)));
  const nestedAliasesImportedRoot = (binding: string): boolean =>
    nestedImportedRootComponents.has(aliasComponentId(binding));
  const hasNestedAliases =
    directNestedAliasSources.size > 0 || nestedImportedRootComponents.size > 0;
  const callables = collectTopLevelCallables(program);
  const accessors = collectTopLevelAccessors(program);
  const classes = collectTopLevelClasses(program);
  const createCatalogResolver = <T>(catalog: ReadonlyMap<string, T>) =>
    createCallableCatalogResolver(
      catalog,
      topLevelAliasState,
      normalizeProvenancePath
    );

  const resolveCallable = createCatalogResolver<CallableNode>(callables);
  const resolveAccessor = createCatalogResolver<CallableNode>(accessors);
  const resolveClass = createCatalogResolver<ClassNode>(classes);
  // Keep fail-closed call-result captures separate from object aliases; they
  // become effects only when a result or one of its aliases is invoked.
  const callableResultRoots = new Map<
    OxcRuntimePropertyPathKey,
    MutableProvenanceClosureNode
  >();
  const getExternalStatementReferences = createStatementReferenceCollector();

  const reachableBindingReferences = new Map<string, Set<string>>();
  const collectReachableBindingReferences = (binding: string): Set<string> => {
    const cached = reachableBindingReferences.get(binding);
    if (cached) {
      return cached;
    }
    const references = new Set<string>();
    const visited = new Set<string>();
    const pending = [binding];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const component = aliasComponents.get(current) ?? new Set([current]);
      component.forEach((alias) => {
        if (visited.has(alias)) {
          return;
        }
        visited.add(alias);
        const owner = bindingOwners.get(alias);
        if (!owner) {
          return;
        }
        getExternalStatementReferences(owner).forEach((reference) => {
          references.add(reference);
          if (bindingOwners.has(reference)) {
            pending.push(reference);
          }
        });
      });
    }
    reachableBindingReferences.set(binding, references);
    return references;
  };
  const callableCaptureRoots = new Map<CallableNode, Set<string>>();
  const collectInlineCallableCaptureRoots = (
    callable: CallableNode
  ): Set<string> => {
    const cached = callableCaptureRoots.get(callable);
    if (cached) {
      return cached;
    }
    const roots = collectExternalReferences(callable);
    [...roots].forEach((root) => {
      collectReachableBindingReferences(root).forEach((reference) =>
        roots.add(reference)
      );
    });
    callableCaptureRoots.set(callable, roots);
    return roots;
  };
  const resolveCallableCaptureRoots = (binding: string): Set<string> => {
    const roots = new Set<string>();
    resolveCallable(binding).forEach((callable) =>
      collectInlineCallableCaptureRoots(callable).forEach((root) =>
        roots.add(root)
      )
    );
    return roots;
  };
  const addCallableResultRoots = (
    binding: OxcRuntimePropertyPathKey,
    roots: MutableProvenanceClosureNode
  ): void => {
    if (
      roots.bindings.size === 0 &&
      roots.dependencies.size === 0 &&
      !roots.mayAliasAnyRootImport
    ) {
      return;
    }
    const bucket =
      callableResultRoots.get(binding) ?? createMutableProvenanceClosureNode();
    mergeProvenanceClosureNode(bucket, roots);
    callableResultRoots.set(binding, bucket);
  };
  const appendAssignedRoots = (
    target: MutableProvenanceClosureNode,
    assigned: ReturnType<typeof collectAssignedAliasRoots>
  ): void => {
    const roots = target;
    assigned.bindings.forEach((binding) => {
      // The virtual cohort already represents every imported-root alias. Keep
      // only independent local alternatives as concrete result edges.
      if (!assigned.mayAliasAnyRootImport || !aliasesImportedRoot(binding)) {
        roots.bindings.add(binding);
      } else {
        roots.dependencies.add(binding);
      }
    });
    roots.mayAliasAnyRootImport ||= assigned.mayAliasAnyRootImport;
  };
  function collectCallableExpressionProvenance(
    value: Node
  ): MutableProvenanceClosureNode {
    const current = unwrapAliasExpression(value);
    if (
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      return createMutableProvenanceClosureNode(
        collectInlineCallableCaptureRoots(current as CallableNode)
      );
    }
    if (current.type === 'CallExpression') {
      const roots = createMutableProvenanceClosureNode();
      appendAssignedRoots(
        roots,
        collectAssignedAliasRoots(current, topLevelAliasState)
      );
      const inlineFactory = getImmediatelyInvokedFunction(current.callee);
      if (inlineFactory) {
        collectInlineCallableCaptureRoots(inlineFactory).forEach((root) =>
          roots.bindings.add(root)
        );
      }
      const factoryBinding = getCalleeBinding(current.callee);
      if (factoryBinding) {
        collectReachableBindingReferences(factoryBinding).forEach((root) =>
          roots.bindings.add(root)
        );
      }
      current.arguments.forEach((argument) => {
        const argumentValue =
          argument.type === 'SpreadElement' ? argument.argument : argument;
        appendAssignedRoots(
          roots,
          collectAssignedAliasRoots(argumentValue, topLevelAliasState)
        );
        mergeProvenanceClosureNode(
          roots,
          collectCallableExpressionProvenance(argumentValue)
        );
      });
      return roots;
    }
    if (current.type === 'Identifier') {
      const roots = createMutableProvenanceClosureNode(
        resolveCallableCaptureRoots(current.name)
      );
      roots.dependencies.add(createOxcRuntimePropertyPath(current.name).key);
      return roots;
    }
    if (current.type === 'MemberExpression') {
      const staticPath = getStaticMemberPath(current);
      if (!staticPath) {
        return collectCallableExpressionProvenance(current.object);
      }
      const roots = createMutableProvenanceClosureNode(
        resolveCallableCaptureRoots(staticPath.key)
      );
      roots.dependencies.add(staticPath.key);
      return roots;
    }
    const roots = createMutableProvenanceClosureNode();
    const addValue = (item: Node): void => {
      mergeProvenanceClosureNode(
        roots,
        collectCallableExpressionProvenance(item)
      );
    };
    if (current.type === 'ArrayExpression') {
      current.elements.forEach((element) => {
        if (element) {
          addValue(
            element.type === 'SpreadElement' ? element.argument : element
          );
        }
      });
    } else if (current.type === 'ObjectExpression') {
      current.properties.forEach((property) => {
        addValue(
          property.type === 'SpreadElement' ? property.argument : property.value
        );
      });
    } else if (current.type === 'ConditionalExpression') {
      addValue(current.consequent);
      addValue(current.alternate);
    } else if (current.type === 'LogicalExpression') {
      addValue(current.left);
      addValue(current.right);
    } else if (current.type === 'SequenceExpression') {
      const last = current.expressions[current.expressions.length - 1];
      if (last) {
        addValue(last);
      }
    } else if (current.type === 'AssignmentExpression') {
      addValue(current.right);
    } else if (current.type === 'AwaitExpression') {
      addValue(current.argument);
    }
    return roots;
  }
  const collectCallableExpressionRoots = (value: Node): Set<string> =>
    collectCallableExpressionProvenance(value).bindings;
  const getObjectPropertyName = (property: Node): string | null => {
    if (property.type === 'SpreadElement') {
      return null;
    }
    const propertyNode = property as AnyNode;
    const { key } = propertyNode;
    if (!isNode(key)) {
      return null;
    }
    if (propertyNode.computed !== true && key.type === 'Identifier') {
      return key.name;
    }
    if (key.type === 'Literal') {
      return String(key.value);
    }
    return null;
  };
  const recordCallableResultValue = (
    value: Node,
    bindingPath: OxcRuntimePropertyPathKey
  ): void => {
    const current = unwrapAliasExpression(value);
    if (
      current.type === 'CallExpression' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      addCallableResultRoots(
        bindingPath,
        collectCallableExpressionProvenance(current)
      );
      return;
    }
    if (current.type === 'ObjectExpression') {
      current.properties.forEach((property) => {
        const propertyName = getObjectPropertyName(property);
        if (propertyName !== null && property.type !== 'SpreadElement') {
          recordCallableResultValue(
            property.value,
            appendOxcRuntimePropertyPathKey(bindingPath, propertyName)
          );
        } else if (property.type !== 'SpreadElement') {
          recordCallableResultValue(property.value, bindingPath);
        }
      });
      return;
    }
    if (current.type === 'ArrayExpression') {
      current.elements.forEach((element, index) => {
        if (element) {
          recordCallableResultValue(
            element.type === 'SpreadElement' ? element.argument : element,
            appendOxcRuntimePropertyPathKey(bindingPath, String(index))
          );
        }
      });
      return;
    }
    if (current.type === 'ConditionalExpression') {
      recordCallableResultValue(current.consequent, bindingPath);
      recordCallableResultValue(current.alternate, bindingPath);
    } else if (current.type === 'LogicalExpression') {
      recordCallableResultValue(current.left, bindingPath);
      recordCallableResultValue(current.right, bindingPath);
    } else if (current.type === 'SequenceExpression') {
      const last = current.expressions[current.expressions.length - 1];
      if (last) {
        recordCallableResultValue(last, bindingPath);
      }
    } else if (current.type === 'AssignmentExpression') {
      recordCallableResultValue(current.right, bindingPath);
    } else if (current.type === 'AwaitExpression') {
      recordCallableResultValue(current.argument, bindingPath);
    } else if (current.type === 'MemberExpression') {
      addCallableResultRoots(
        bindingPath,
        collectCallableExpressionProvenance(current)
      );
    }
  };
  program.body.forEach((statement) => {
    forEachModuleExecutedNode(statement, (current) => {
      if (current.type === 'VariableDeclaration') {
        current.declarations.forEach((declarator) => {
          if (!declarator.init) {
            return;
          }
          if (declarator.id.type === 'Identifier') {
            recordCallableResultValue(
              declarator.init,
              createOxcRuntimePropertyPath(declarator.id.name).key
            );
            return;
          }
          const roots = collectCallableExpressionProvenance(declarator.init);
          collectPatternNames(declarator.id).forEach((binding) =>
            addCallableResultRoots(
              createOxcRuntimePropertyPath(binding).key,
              roots
            )
          );
        });
        return;
      }
      if (current.type !== 'AssignmentExpression' || current.operator !== '=') {
        return;
      }
      const staticPath = getStaticMemberPath(current.left);
      if (staticPath) {
        recordCallableResultValue(current.right, staticPath.key);
        return;
      }
      const roots = collectCallableExpressionProvenance(current.right);
      collectPatternNames(current.left).forEach((binding) =>
        addCallableResultRoots(createOxcRuntimePropertyPath(binding).key, roots)
      );
    });
  });
  const callableResultNodes = new Map<string, MutableProvenanceClosureNode>();
  const callableResultPathsByRoot = new Map<
    string,
    Set<OxcRuntimePropertyPathKey>
  >();
  const callableResultPaths = new Set(
    [...callableResultRoots.keys()].map(normalizeProvenancePath)
  );
  type ResultNode = MutableProvenanceClosureNode;
  const normalizeDependency = (dependency: string) =>
    normalizeProvenancePath(
      dependency.includes('#')
        ? (dependency as OxcRuntimePropertyPathKey)
        : createOxcRuntimePropertyPath(dependency).key
    );
  const addResultDependency = (node: ResultNode, dependency: string): void => {
    const normalized = normalizeDependency(dependency);
    if (callableResultPaths.has(normalized)) {
      node.dependencies.add(normalized);
      return;
    }
    const rawPath = dependency as OxcRuntimePropertyPathKey;
    node.bindings.add(getOxcRuntimePropertyPathKeyRoot(rawPath));
  };
  callableResultRoots.forEach((provenance, path) => {
    const normalizedPath = normalizeProvenancePath(path);
    const node = callableResultNodes.get(normalizedPath) ?? {
      bindings: new Set<string>(),
      dependencies: new Set<string>(),
      mayAliasAnyRootImport: false,
    };
    node.mayAliasAnyRootImport ||= provenance.mayAliasAnyRootImport;
    provenance.bindings.forEach((binding) =>
      addResultDependency(node, binding)
    );
    provenance.dependencies.forEach((dependency) =>
      addResultDependency(node, dependency)
    );
    callableResultNodes.set(normalizedPath, node);
    const root = getOxcRuntimePropertyPathKeyRoot(normalizedPath);
    const paths = callableResultPathsByRoot.get(root) ?? new Set();
    paths.add(normalizedPath);
    callableResultPathsByRoot.set(root, paths);
  });
  const resolveCallableResultPaths = (
    binding: OxcRuntimePropertyPathKey,
    includeDescendants = false
  ): Set<OxcRuntimePropertyPathKey> => {
    const normalized = normalizeProvenancePath(binding);
    if (!includeDescendants) {
      return callableResultNodes.has(normalized)
        ? new Set([normalized])
        : new Set();
    }
    return new Set(
      [
        ...(callableResultPathsByRoot.get(
          getOxcRuntimePropertyPathKeyRoot(normalized)
        ) ?? []),
      ].filter((candidate) =>
        isOxcRuntimePropertyPathKeyEqualOrDescendant(candidate, normalized)
      )
    );
  };
  const callableResultClosure = createProvenanceClosureIndex(
    callableResultNodes,
    getProvenanceComponentRoot
  );
  const resolveCallableResultRoots = (
    binding: OxcRuntimePropertyPathKey,
    includeDescendants = false
  ): TaggedBindingProvenance =>
    callableResultClosure.resolve(
      resolveCallableResultPaths(binding, includeDescendants)
    );
  const callableResultPathsMayAliasImport = (
    paths: ReadonlySet<OxcRuntimePropertyPathKey>
  ): boolean => callableResultClosure.pathsMayAliasAnyRootImport(paths);
  const visitCallableResultDependents = (
    binding: string,
    visited: Set<string>,
    visit: (path: OxcRuntimePropertyPathKey) => void
  ): void =>
    callableResultClosure.visitDependents(binding, visited, (path) =>
      visit(path as OxcRuntimePropertyPathKey)
    );
  const resolveAliasBinding = resolveProvenanceAliases;
  const addCallableResultEffects = (
    roots: Set<string>,
    provenance: TaggedBindingProvenance
  ): void => {
    provenance.bindings.forEach((binding) => roots.add(binding));
    if (provenance.mayAliasAnyRootImport) {
      // This is the liveness boundary: the virtual cohort becomes concrete
      // only while computing effects of code that is actually reached.
      rootImportedBindings.forEach((binding) => roots.add(binding));
    }
  };
  const collectContextualRoots = (
    value: Node,
    aliases: AliasEnvironment,
    expandCallableResults = true
  ): Set<string> => {
    const current = unwrapAliasExpression(value);
    const collect = (node: Node): Set<string> =>
      collectContextualRoots(node, aliases, expandCallableResults);
    if (current.type === 'Identifier') {
      const roots = resolveAliasBinding(current.name, aliases);
      if (!expandCallableResults) {
        return roots;
      }
      [...roots].forEach((root) => {
        resolveCallableCaptureRoots(root).forEach((capture) =>
          roots.add(capture)
        );
        addCallableResultEffects(
          roots,
          resolveCallableResultRoots(createOxcRuntimePropertyPath(root).key)
        );
      });
      return roots;
    }

    if (current.type === 'MemberExpression') {
      const roots = collect(current.object);
      if (!expandCallableResults) {
        return roots;
      }
      const staticPath = getStaticMemberPath(current);
      if (staticPath) {
        resolveCallableCaptureRoots(staticPath.key).forEach((capture) =>
          roots.add(capture)
        );
        addCallableResultEffects(
          roots,
          resolveCallableResultRoots(staticPath.key)
        );
      } else {
        [...roots].forEach((root) => {
          addCallableResultEffects(
            roots,
            resolveCallableResultRoots(
              createOxcRuntimePropertyPath(root).key,
              true
            )
          );
        });
      }
      return roots;
    }

    if (
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      return new Set(
        collectInlineCallableCaptureRoots(current as CallableNode)
      );
    }

    if (current.type === 'ConditionalExpression') {
      return new Set([
        ...collect(current.consequent),
        ...collect(current.alternate),
      ]);
    }

    if (current.type === 'LogicalExpression') {
      return new Set([...collect(current.left), ...collect(current.right)]);
    }

    if (current.type === 'SequenceExpression') {
      const last = current.expressions[current.expressions.length - 1];
      return last ? collect(last) : new Set();
    }

    if (current.type === 'AssignmentExpression') {
      return collect(current.right);
    }

    if (current.type === 'ArrayExpression') {
      const roots = new Set<string>();
      current.elements.forEach((element) => {
        if (element) {
          const item =
            element.type === 'SpreadElement' ? element.argument : element;
          collect(item).forEach((root) => roots.add(root));
        }
      });
      return roots;
    }

    if (current.type === 'ObjectExpression') {
      const roots = new Set<string>();
      current.properties.forEach((property) => {
        const item =
          property.type === 'SpreadElement'
            ? property.argument
            : property.value;
        collect(item).forEach((root) => roots.add(root));
      });
      return roots;
    }

    if (current.type === 'AwaitExpression') {
      return collect(current.argument);
    }

    if (current.type === 'CallExpression') {
      const roots = new Set(collectCallableExpressionRoots(current));
      const calleeBinding = getCalleeBinding(current.callee);
      if (
        calleeBinding &&
        [...resolveAliasBinding(calleeBinding, aliases)].some(
          aliasesImportedRoot
        )
      ) {
        rootImportedBindings.forEach((root) => roots.add(root));
      }
      return roots;
    }

    return new Set();
  };
  // A null result asks invocation analysis to use its conservative capture
  // summary instead of materializing more alias roots.
  const collectCallableAliases = (
    callable: CallableNode,
    args: readonly (Node | null)[],
    callerAliases: AliasEnvironment,
    consumeWork: (work: number) => boolean
  ): Map<string, Set<string>> | null => {
    const aliases = new Map<string, Set<string>>();
    const addBindingRoots = (
      pattern: Node,
      roots: ReadonlySet<string>
    ): boolean | null => {
      let changed = false;
      for (const binding of collectPatternNames(pattern)) {
        if (!consumeWork(Math.max(1, roots.size))) {
          return null;
        }
        const previous = aliases.get(binding);
        if (!previous) {
          aliases.set(binding, new Set(roots));
          changed = true;
        } else {
          for (const root of roots) {
            if (!previous.has(root)) {
              previous.add(root);
              changed = true;
            }
          }
        }
      }
      return changed;
    };

    for (let index = 0; index < callable.params.length; index += 1) {
      const parameter = callable.params[index]!;
      const argument = args[index];
      const roots =
        argument && argument.type !== 'SpreadElement'
          ? collectContextualRoots(argument, callerAliases, false)
          : new Set<string>();
      if (!consumeWork(Math.max(1, roots.size))) {
        return null;
      }
      if (parameter.type === 'AssignmentPattern') {
        const defaultRoots = collectContextualRoots(parameter.right, aliases);
        if (!consumeWork(Math.max(1, defaultRoots.size))) {
          return null;
        }
        defaultRoots.forEach((root) => roots.add(root));
      }
      if (addBindingRoots(parameter, roots) === null) {
        return null;
      }
    }

    const { assignmentPairs } = getCallableSyntaxFacts(callable.body);

    let changed = true;
    let passes = assignmentPairs.length + 1;
    while (changed && passes > 0) {
      passes -= 1;
      changed = false;
      for (const { pattern, value } of assignmentPairs) {
        const roots = collectContextualRoots(value, aliases);
        if (!consumeWork(Math.max(1, roots.size))) {
          return null;
        }
        const added = addBindingRoots(pattern, roots);
        if (added === null) {
          return null;
        }
        if (added) {
          changed = true;
        }
      }
    }

    return aliases;
  };
  const resolveCalleeCallables = (
    callee: Node,
    aliases: AliasEnvironment,
    scopedCallables: ReadonlyMap<string, CallableNode>
  ): Set<CallableNode> => {
    const current = unwrapAliasExpression(callee);
    const resolved = new Set<CallableNode>();
    const addBinding = (binding: string): void => {
      resolveAliasBinding(binding, aliases).forEach((alias) => {
        const scoped = scopedCallables.get(alias);
        if (scoped) {
          resolved.add(scoped);
        } else {
          resolveCallable(alias).forEach((callable) => resolved.add(callable));
        }
      });
    };
    const addExpression = (expression: Node): void => {
      resolveCalleeCallables(expression, aliases, scopedCallables).forEach(
        (callable) => resolved.add(callable)
      );
    };

    if (
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      resolved.add(current as CallableNode);
      return resolved;
    }

    const staticPath = getStaticMemberPath(current);
    if (staticPath) {
      if (staticPath.segments.length === 0) {
        addBinding(staticPath.key);
      } else {
        resolveAliasBinding(staticPath.root, aliases).forEach((alias) =>
          addBinding(replaceOxcRuntimePropertyPathRoot(staticPath, alias).key)
        );
      }
      if (resolved.size > 0) {
        return resolved;
      }
    }

    if (current.type === 'ConditionalExpression') {
      addExpression(current.consequent);
      addExpression(current.alternate);
    } else if (current.type === 'LogicalExpression') {
      addExpression(current.left);
      addExpression(current.right);
    } else if (current.type === 'SequenceExpression') {
      const last = current.expressions[current.expressions.length - 1];
      if (last) {
        addExpression(last);
      }
    } else if (current.type === 'AssignmentExpression') {
      addExpression(current.right);
    } else if (current.type === 'AwaitExpression') {
      addExpression(current.argument);
    } else if (current.type === 'MemberExpression') {
      const object = unwrapAliasExpression(current.object);
      let propertyName: string | null = null;
      if (!current.computed && current.property.type === 'Identifier') {
        propertyName = current.property.name;
      } else if (current.property.type === 'Literal') {
        propertyName = String(current.property.value);
      }

      if (object.type === 'NewExpression' && propertyName !== null) {
        const constructorPath = getStaticMemberPath(object.callee);
        if (constructorPath) {
          resolveAliasBinding(constructorPath.root, aliases).forEach(
            (alias) => {
              const aliasedConstructor = replaceOxcRuntimePropertyPathRoot(
                constructorPath,
                alias
              );
              addBinding(
                appendOxcRuntimePropertyPath(
                  appendOxcRuntimePropertyPath(aliasedConstructor, 'prototype'),
                  propertyName
                ).key
              );
            }
          );
        }
      } else if (object.type === 'ArrayExpression') {
        const index =
          propertyName !== null && /^\d+$/.test(propertyName)
            ? Number(propertyName)
            : null;
        const elements =
          index === null ? object.elements : [object.elements[index]];
        elements.forEach((element) => {
          if (element) {
            addExpression(
              element.type === 'SpreadElement' ? element.argument : element
            );
          }
        });
      } else if (object.type === 'ObjectExpression') {
        object.properties.forEach((property) => {
          if (property.type === 'SpreadElement') {
            if (propertyName === null) {
              addExpression(property.argument);
            }
            return;
          }

          let candidateName: string | null = null;
          if (!property.computed && property.key.type === 'Identifier') {
            candidateName = property.key.name;
          } else if (property.key.type === 'Literal') {
            candidateName = String(property.key.value);
          }
          if (propertyName === null || candidateName === propertyName) {
            addExpression(property.value);
          }
        });
      }
    }

    return resolved;
  };
  const resolveCalleeClasses = (
    callee: Node,
    aliases: AliasEnvironment,
    scopedClasses: ReadonlyMap<string, ClassNode>
  ): Set<ClassNode> => {
    const current = unwrapAliasExpression(callee);
    const resolved = new Set<ClassNode>();
    const addBinding = (binding: string): void => {
      resolveAliasBinding(binding, aliases).forEach((alias) => {
        const scoped = scopedClasses.get(alias);
        if (scoped) {
          resolved.add(scoped);
        } else {
          resolveClass(alias).forEach((classNode) => resolved.add(classNode));
        }
      });
    };
    const addExpression = (expression: Node): void => {
      resolveCalleeClasses(expression, aliases, scopedClasses).forEach(
        (classNode) => resolved.add(classNode)
      );
    };

    if (current.type === 'ClassExpression') {
      resolved.add(current as ClassNode);
      return resolved;
    }

    const staticPath = getStaticMemberPath(current);
    if (staticPath) {
      addBinding(staticPath.key);
      if (resolved.size > 0) {
        return resolved;
      }
    }

    if (current.type === 'ConditionalExpression') {
      addExpression(current.consequent);
      addExpression(current.alternate);
    } else if (current.type === 'LogicalExpression') {
      addExpression(current.left);
      addExpression(current.right);
    } else if (current.type === 'SequenceExpression') {
      const last = current.expressions[current.expressions.length - 1];
      if (last) {
        addExpression(last);
      }
    } else if (current.type === 'AssignmentExpression') {
      addExpression(current.right);
    } else if (current.type === 'AwaitExpression') {
      addExpression(current.argument);
    }

    return resolved;
  };
  const resolveMemberAccessors = (
    member: Node,
    aliases: AliasEnvironment,
    scopedAccessors: ReadonlyMap<string, CallableNode>
  ): Set<CallableNode> => {
    const staticPath = getStaticMemberPath(member);
    if (!staticPath) {
      return new Set();
    }

    const resolved = new Set<CallableNode>();
    resolveAliasBinding(staticPath.root, aliases).forEach((alias) => {
      const accessorPath = replaceOxcRuntimePropertyPathRoot(
        staticPath,
        alias
      ).key;
      const scoped = scopedAccessors.get(accessorPath);
      if (scoped) {
        resolved.add(scoped);
      } else {
        resolveAccessor(accessorPath).forEach((accessor) =>
          resolved.add(accessor)
        );
      }
    });
    return resolved;
  };

  return {
    aliasComponentId,
    aliasComponents,
    aliasesImportedRoot,
    collectCallableAliases,
    collectCallableExpressionRoots,
    collectContextualRoots,
    collectInlineCallableCaptureRoots,
    getCallableSyntaxFacts,
    getExternalStatementReferences,
    hasNestedAliases,
    importedRootAliasBindings,
    nestedAliasDependents,
    nestedAliasesImportedRoot,
    nestedAliasSources,
    resolveAliasBinding,
    resolveCallableCaptureRoots,
    resolveCallableResultPaths,
    resolveCallableResultRoots,
    resolveCalleeCallables,
    resolveCalleeClasses,
    resolveMemberAccessors,
    rootImportedBindings,
    callableResultPathsMayAliasImport,
    visitCallableResultDependents,
  };
};

export type CallableProvenanceIndex = ReturnType<
  typeof createCallableProvenanceIndex
>;
