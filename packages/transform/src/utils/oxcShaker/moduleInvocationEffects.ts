/* eslint-disable no-restricted-syntax */

import type { Node } from 'oxc-parser';
import { createReceiverOperationCollector } from './receiverOperationCollector';

import { collectOxcPatternIdentifierNames as collectPatternNames } from '../oxc/patterns';
import {
  createOxcRuntimePropertyPath,
  replaceOxcRuntimePropertyPathRoot,
  type OxcRuntimePropertyPath,
  type OxcRuntimePropertyPathKey,
} from '../oxc/projections';
import {
  getCalleeBinding,
  getStaticMemberPath,
  type ClassNode,
} from './bindingProvenance';
import { extendCallableSyntaxCatalogs } from './callableSyntaxFacts';
import {
  type AliasEnvironment,
  type CallableProvenanceIndex,
} from './callableProvenanceIndex';
import {
  collectExternalReferences,
  forEachModuleExecutedNodeWithParent,
  hasModuleInvocationCandidate,
  isMemberRead,
  unwrapAliasExpression,
  type CallableNode,
} from './executableIndex';
import type { ReceiverOperation } from './patternEffects';

type ModuleInvocationEffects = {
  bindings: Set<string>;
  callableResultPaths: Set<OxcRuntimePropertyPathKey>;
  effectOrigins: Set<string>;
  opaqueImportedCall: boolean;
};

export type ModuleInvocationAnalysisState = {
  consumeWork: (work: number) => boolean;
  isExhausted: () => boolean;
};

// Work shared by the whole module prevents many individually expensive
// statements from multiplying the same callable/alias expansion cost.
const MAX_MODULE_INVOCATION_WORK = 8192;
// This bounded leaf check avoids widening tiny, obviously effect-free calls
// after the module budget is spent without starting another unbounded pass.
const MAX_TRIVIAL_CALLABLE_SIZE = 64;

export const createModuleInvocationAnalysisState =
  (): ModuleInvocationAnalysisState => {
    let remainingWork = MAX_MODULE_INVOCATION_WORK;
    return {
      consumeWork: (work) => {
        if (work <= remainingWork) {
          remainingWork -= work;
          return true;
        }
        remainingWork = -1;
        return false;
      },
      isExhausted: () => remainingWork < 0,
    };
  };

export const collectModuleInvocationEffects = (
  node: Node,
  provenance: CallableProvenanceIndex,
  isReceiverOperationProvenInert: (operation: ReceiverOperation) => boolean,
  resolveReceiverOperationRoots: (binding: string) => ReadonlySet<string>,
  analysisState: ModuleInvocationAnalysisState
): ModuleInvocationEffects => {
  if (!hasModuleInvocationCandidate(node)) {
    return {
      bindings: new Set(),
      callableResultPaths: new Set(),
      effectOrigins: new Set(),
      opaqueImportedCall: false,
    };
  }

  const {
    aliasesImportedRoot,
    collectCallableAliases,
    collectCallableExpressionRoots,
    collectContextualRoots,
    collectInlineCallableCaptureRoots,
    getCallableSyntaxFacts,
    resolveAliasBinding,
    resolveCallableCaptureRoots,
    resolveCallableResultPaths,
    resolveCalleeCallables,
    resolveCalleeClasses,
    resolveMemberAccessors,
    callableResultPathsMayAliasImport,
  } = provenance;
  const bindings = new Set<string>();
  const callableResultPaths = new Set<OxcRuntimePropertyPathKey>();
  const effectOrigins = new Set<string>();
  const addEffectOrigin = (binding: string): void => {
    bindings.add(binding);
    effectOrigins.add(binding);
  };
  let opaqueImportedCall = false;
  let widened = false;
  const { consumeWork } = analysisState;
  const emptyAliases: AliasEnvironment = new Map();
  const activeCallableAliases = new Map<CallableNode, AliasEnvironment>();
  const hasImportedCallee = (
    candidates: ReadonlySet<string>,
    aliases: AliasEnvironment
  ): boolean =>
    [...candidates].some((binding) =>
      [...resolveAliasBinding(binding, aliases)].some(aliasesImportedRoot)
    );
  const addFallbackRoot = (
    binding: string,
    aliases: AliasEnvironment
  ): void => {
    resolveAliasBinding(binding, aliases).forEach((root) => {
      addEffectOrigin(root);
      if (aliasesImportedRoot(root)) {
        opaqueImportedCall = true;
      }
    });
  };
  const addCallableFallbackRoots = (
    callable: CallableNode,
    aliases: AliasEnvironment
  ): void => {
    // Arguments are recorded before descent. Captures cover effects that do
    // not flow through those arguments, including transitive local wrappers.
    collectInlineCallableCaptureRoots(callable).forEach((root) =>
      addFallbackRoot(root, aliases)
    );
  };

  const addResultPaths = (
    binding: OxcRuntimePropertyPathKey,
    includeDescendants = false
  ): void => {
    const paths = resolveCallableResultPaths(binding, includeDescendants);
    paths.forEach((path) => callableResultPaths.add(path));
    if (callableResultPathsMayAliasImport(paths)) {
      opaqueImportedCall = true;
    }
  };
  const addRoots = (
    value: Node,
    aliases: AliasEnvironment = emptyAliases
  ): void => {
    const current = unwrapAliasExpression(value);
    const addValue = (item: Node): void => addRoots(item, aliases);
    if (current.type === 'Identifier') {
      resolveAliasBinding(current.name, aliases).forEach((root) => {
        addEffectOrigin(root);
        resolveCallableCaptureRoots(root).forEach((capture) =>
          addEffectOrigin(capture)
        );
        addResultPaths(createOxcRuntimePropertyPath(root).key);
      });
      return;
    }
    if (current.type === 'MemberExpression') {
      const staticPath = getStaticMemberPath(current);
      if (staticPath) {
        resolveAliasBinding(staticPath.root, aliases).forEach((root) => {
          addEffectOrigin(root);
          const path = replaceOxcRuntimePropertyPathRoot(staticPath, root).key;
          resolveCallableCaptureRoots(path).forEach((capture) =>
            addEffectOrigin(capture)
          );
          addResultPaths(path);
        });
      } else {
        collectContextualRoots(current.object, aliases, false).forEach(
          (root) => {
            addEffectOrigin(root);
            addResultPaths(createOxcRuntimePropertyPath(root).key, true);
          }
        );
      }
      return;
    }
    if (
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      collectInlineCallableCaptureRoots(current as CallableNode).forEach(
        addEffectOrigin
      );
      return;
    }
    if (current.type === 'ConditionalExpression') {
      addValue(current.consequent);
      addValue(current.alternate);
    } else if (current.type === 'LogicalExpression') {
      addValue(current.left);
      addValue(current.right);
    } else if (current.type === 'SequenceExpression') {
      const last = current.expressions[current.expressions.length - 1];
      if (last) addValue(last);
    } else if (current.type === 'AssignmentExpression') {
      addValue(current.right);
    } else if (current.type === 'ArrayExpression') {
      current.elements.forEach((element) => {
        if (element) {
          addValue(
            element.type === 'SpreadElement' ? element.argument : element
          );
        }
      });
    } else if (current.type === 'ObjectExpression') {
      current.properties.forEach((property) =>
        addValue(
          property.type === 'SpreadElement' ? property.argument : property.value
        )
      );
    } else if (current.type === 'AwaitExpression') {
      addValue(current.argument);
    } else if (current.type === 'CallExpression') {
      collectContextualRoots(current, aliases).forEach((root) =>
        addEffectOrigin(root)
      );
    }
  };

  const addReceiverOperationEffects = (
    operation: ReceiverOperation,
    aliases: AliasEnvironment
  ): void => {
    if (isReceiverOperationProvenInert(operation)) {
      return;
    }

    const roots = collectContextualRoots(operation.receiver, aliases);
    collectExternalReferences(operation.receiver).forEach((binding) => {
      resolveAliasBinding(binding, aliases).forEach((root) => roots.add(root));
    });
    roots.add('Object');
    if (operation.kind === 'iterate') {
      roots.add('Array');
    }
    [...roots].forEach((root) => {
      addEffectOrigin(root);
      resolveReceiverOperationRoots(root).forEach((resolved) =>
        bindings.add(resolved)
      );
    });
  };

  const addReceiverOperationsForNode = createReceiverOperationCollector(
    addReceiverOperationEffects
  );

  const addInvokedBinding = (
    binding: string,
    aliases: AliasEnvironment,
    staticPath: OxcRuntimePropertyPath | null
  ): void => {
    resolveAliasBinding(binding, aliases).forEach((root) => {
      addEffectOrigin(root);
      const resultBinding =
        staticPath?.root === binding
          ? replaceOxcRuntimePropertyPathRoot(staticPath, root).key
          : createOxcRuntimePropertyPath(root).key;
      const resultPaths = resolveCallableResultPaths(
        resultBinding,
        staticPath === null
      );
      resultPaths.forEach((path) => callableResultPaths.add(path));
      if (callableResultPathsMayAliasImport(resultPaths)) {
        opaqueImportedCall = true;
      }
    });
  };

  const addInvokedCalleeBindings = (
    callee: Node,
    aliases: AliasEnvironment
  ): void => {
    const current = unwrapAliasExpression(callee);
    if (current.type === 'Identifier' || current.type === 'MemberExpression') {
      const binding = getCalleeBinding(current);
      if (binding) {
        addInvokedBinding(binding, aliases, getStaticMemberPath(current));
        if (
          [...resolveAliasBinding(binding, aliases)].some(aliasesImportedRoot)
        ) {
          opaqueImportedCall = true;
        }
      } else if (
        current.type === 'MemberExpression' &&
        unwrapAliasExpression(current.object).type === 'CallExpression'
      ) {
        collectCallableExpressionRoots(current.object).forEach((root) =>
          addEffectOrigin(root)
        );
      }
      return;
    }

    const addExpression = (expression: Node): void =>
      addInvokedCalleeBindings(expression, aliases);
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
    } else if (current.type === 'CallExpression') {
      collectCallableExpressionRoots(current).forEach((root) =>
        addEffectOrigin(root)
      );
    }
  };

  let addClassConstructionEffects: (
    classNode: ClassNode,
    args: readonly (Node | null)[],
    callerAliases: AliasEnvironment,
    visiting: Set<CallableNode>,
    inheritedCallables: ReadonlyMap<string, CallableNode>,
    inheritedAccessors: ReadonlyMap<string, CallableNode>,
    inheritedClasses: ReadonlyMap<string, ClassNode>,
    visitingClasses: Set<ClassNode>
  ) => void;

  const addCallableEffects = (
    callable: CallableNode,
    args: readonly (Node | null)[],
    callerAliases: AliasEnvironment,
    visiting: Set<CallableNode>,
    inheritedCallables: ReadonlyMap<string, CallableNode>,
    inheritedAccessors: ReadonlyMap<string, CallableNode>,
    inheritedClasses: ReadonlyMap<string, ClassNode>
  ): void => {
    if (visiting.has(callable)) {
      return;
    }
    if (widened) {
      addCallableFallbackRoots(callable, callerAliases);
      return;
    }
    if (
      analysisState.isExhausted() &&
      callable.params.length === 0 &&
      callable.body.end - callable.body.start <= MAX_TRIVIAL_CALLABLE_SIZE
    ) {
      const facts = getCallableSyntaxFacts(callable.body);
      if (
        facts.mutationBindings.size === 0 &&
        !hasModuleInvocationCandidate(callable.body)
      ) {
        return;
      }
    }
    const widenFrom = (): void => {
      widened = true;
      const affected = new Set(visiting).add(callable);
      affected.forEach((active) => {
        const aliases =
          active === callable
            ? callerAliases
            : activeCallableAliases.get(active) ?? emptyAliases;
        addCallableFallbackRoots(active, aliases);
      });
    };
    if (!consumeWork(1)) {
      widenFrom();
      return;
    }
    visiting.add(callable);

    const aliases = collectCallableAliases(
      callable,
      args,
      callerAliases,
      consumeWork
    );
    if (!aliases) {
      widenFrom();
      visiting.delete(callable);
      return;
    }
    activeCallableAliases.set(callable, aliases);
    const facts = getCallableSyntaxFacts(callable.body);
    const {
      accessors: scopedAccessors,
      callables: scopedCallables,
      classes: scopedClasses,
    } = extendCallableSyntaxCatalogs(facts, {
      accessors: inheritedAccessors,
      callables: inheritedCallables,
      classes: inheritedClasses,
    });
    callable.params.forEach((parameter) => {
      collectPatternNames(parameter).forEach((binding) => {
        resolveAliasBinding(binding, aliases).forEach((root) =>
          addEffectOrigin(root)
        );
      });
    });

    facts.mutationBindings.forEach((binding) => {
      resolveAliasBinding(binding, aliases).forEach((root) =>
        addEffectOrigin(root)
      );
    });
    if (hasImportedCallee(facts.calleeCandidates, aliases)) {
      opaqueImportedCall = true;
    }

    forEachModuleExecutedNodeWithParent(callable.body, (current, parent) => {
      addReceiverOperationsForNode(current, parent, aliases);

      if (
        current.type === 'MemberExpression' &&
        isMemberRead(current, parent)
      ) {
        resolveMemberAccessors(current, aliases, scopedAccessors).forEach(
          (accessor) =>
            addCallableEffects(
              accessor,
              [],
              aliases,
              visiting,
              scopedCallables,
              scopedAccessors,
              scopedClasses
            )
        );
      }

      if (current.type === 'CallExpression') {
        addInvokedCalleeBindings(current.callee, aliases);
        const nestedCallables = resolveCalleeCallables(
          current.callee,
          aliases,
          scopedCallables
        );
        current.arguments.forEach((argument) => {
          addRoots(
            argument.type === 'SpreadElement' ? argument.argument : argument,
            aliases
          );
        });
        nestedCallables.forEach((nestedCallable) => {
          addCallableEffects(
            nestedCallable,
            current.arguments,
            aliases,
            visiting,
            scopedCallables,
            scopedAccessors,
            scopedClasses
          );
        });
      } else if (current.type === 'NewExpression') {
        addInvokedCalleeBindings(current.callee, aliases);
        current.arguments.forEach((argument) => {
          addRoots(
            argument.type === 'SpreadElement' ? argument.argument : argument,
            aliases
          );
        });
        resolveCalleeCallables(
          current.callee,
          aliases,
          scopedCallables
        ).forEach((constructor) => {
          addCallableEffects(
            constructor,
            current.arguments,
            aliases,
            visiting,
            scopedCallables,
            scopedAccessors,
            scopedClasses
          );
        });
        resolveCalleeClasses(current.callee, aliases, scopedClasses).forEach(
          (classNode) =>
            addClassConstructionEffects(
              classNode,
              current.arguments,
              aliases,
              visiting,
              scopedCallables,
              scopedAccessors,
              scopedClasses,
              new Set()
            )
        );
      } else if (current.type === 'TaggedTemplateExpression') {
        addInvokedCalleeBindings(current.tag, aliases);
        current.quasi.expressions.forEach((expression) =>
          addRoots(expression, aliases)
        );
        const tagArguments: Array<Node | null> = [
          null,
          ...current.quasi.expressions,
        ];
        resolveCalleeCallables(current.tag, aliases, scopedCallables).forEach(
          (tag) => {
            addCallableEffects(
              tag,
              tagArguments,
              aliases,
              visiting,
              scopedCallables,
              scopedAccessors,
              scopedClasses
            );
          }
        );
      }
    });

    activeCallableAliases.delete(callable);
    visiting.delete(callable);
  };

  addClassConstructionEffects = (
    classNode,
    args,
    callerAliases,
    visiting,
    inheritedCallables,
    inheritedAccessors,
    inheritedClasses,
    visitingClasses
  ): void => {
    if (visitingClasses.has(classNode)) {
      return;
    }
    if (!widened && !consumeWork(1)) {
      widened = true;
    }
    visitingClasses.add(classNode);

    const constructor = classNode.body.body.find(
      (element) =>
        element.type === 'MethodDefinition' &&
        element.kind === 'constructor' &&
        element.value
    );
    if (constructor?.type === 'MethodDefinition' && constructor.value) {
      addCallableEffects(
        constructor.value as CallableNode,
        args,
        callerAliases,
        visiting,
        inheritedCallables,
        inheritedAccessors,
        inheritedClasses
      );
    }

    classNode.body.body.forEach((element) => {
      if (
        element.type !== 'PropertyDefinition' ||
        element.static === true ||
        !element.value
      ) {
        return;
      }

      const facts = getCallableSyntaxFacts(element.value);
      facts.mutationBindings.forEach((binding) => {
        resolveAliasBinding(binding, callerAliases).forEach((root) =>
          addEffectOrigin(root)
        );
      });
      if (hasImportedCallee(facts.calleeCandidates, callerAliases)) {
        opaqueImportedCall = true;
      }
      forEachModuleExecutedNodeWithParent(element.value, (current, parent) => {
        addReceiverOperationsForNode(current, parent, callerAliases);

        if (
          current.type === 'MemberExpression' &&
          isMemberRead(current, parent)
        ) {
          resolveMemberAccessors(
            current,
            callerAliases,
            inheritedAccessors
          ).forEach((accessor) =>
            addCallableEffects(
              accessor,
              [],
              callerAliases,
              visiting,
              inheritedCallables,
              inheritedAccessors,
              inheritedClasses
            )
          );
        }

        if (current.type === 'CallExpression') {
          addInvokedCalleeBindings(current.callee, callerAliases);
          const nestedCallables = resolveCalleeCallables(
            current.callee,
            callerAliases,
            inheritedCallables
          );
          current.arguments.forEach((argument) =>
            addRoots(
              argument.type === 'SpreadElement' ? argument.argument : argument,
              callerAliases
            )
          );
          nestedCallables.forEach((callable) =>
            addCallableEffects(
              callable,
              current.arguments,
              callerAliases,
              visiting,
              inheritedCallables,
              inheritedAccessors,
              inheritedClasses
            )
          );
        } else if (current.type === 'NewExpression') {
          addInvokedCalleeBindings(current.callee, callerAliases);
          current.arguments.forEach((argument) =>
            addRoots(
              argument.type === 'SpreadElement' ? argument.argument : argument,
              callerAliases
            )
          );
          resolveCalleeClasses(
            current.callee,
            callerAliases,
            inheritedClasses
          ).forEach((nestedClass) =>
            addClassConstructionEffects(
              nestedClass,
              current.arguments,
              callerAliases,
              visiting,
              inheritedCallables,
              inheritedAccessors,
              inheritedClasses,
              visitingClasses
            )
          );
        } else if (current.type === 'TaggedTemplateExpression') {
          addInvokedCalleeBindings(current.tag, callerAliases);
          current.quasi.expressions.forEach((expression) =>
            addRoots(expression, callerAliases)
          );
          const tagArguments: Array<Node | null> = [
            null,
            ...current.quasi.expressions,
          ];
          resolveCalleeCallables(
            current.tag,
            callerAliases,
            inheritedCallables
          ).forEach((tag) =>
            addCallableEffects(
              tag,
              tagArguments,
              callerAliases,
              visiting,
              inheritedCallables,
              inheritedAccessors,
              inheritedClasses
            )
          );
        }
      });
    });

    if (classNode.superClass) {
      resolveCalleeClasses(
        classNode.superClass,
        callerAliases,
        inheritedClasses
      ).forEach((baseClass) =>
        addClassConstructionEffects(
          baseClass,
          args,
          callerAliases,
          visiting,
          inheritedCallables,
          inheritedAccessors,
          inheritedClasses,
          visitingClasses
        )
      );
    }

    visitingClasses.delete(classNode);
  };

  forEachModuleExecutedNodeWithParent(node, (current, parent) => {
    addReceiverOperationsForNode(current, parent, emptyAliases);

    if (current.type === 'MemberExpression' && isMemberRead(current, parent)) {
      resolveMemberAccessors(current, emptyAliases, new Map()).forEach(
        (accessor) =>
          addCallableEffects(
            accessor,
            [],
            emptyAliases,
            new Set(),
            new Map(),
            new Map(),
            new Map()
          )
      );
    }

    if (current.type === 'CallExpression') {
      addInvokedCalleeBindings(current.callee, emptyAliases);
      const callablesForCallee = resolveCalleeCallables(
        current.callee,
        emptyAliases,
        new Map()
      );
      current.arguments.forEach((argument) => {
        addRoots(
          argument.type === 'SpreadElement' ? argument.argument : argument,
          emptyAliases
        );
      });
      callablesForCallee.forEach((callable) => {
        addCallableEffects(
          callable,
          current.arguments,
          emptyAliases,
          new Set(),
          new Map(),
          new Map(),
          new Map()
        );
      });
      return;
    }

    if (current.type === 'NewExpression') {
      addInvokedCalleeBindings(current.callee, emptyAliases);
      current.arguments.forEach((argument) => {
        addRoots(
          argument.type === 'SpreadElement' ? argument.argument : argument
        );
      });
      resolveCalleeCallables(current.callee, emptyAliases, new Map()).forEach(
        (constructor) => {
          addCallableEffects(
            constructor,
            current.arguments,
            emptyAliases,
            new Set(),
            new Map(),
            new Map(),
            new Map()
          );
        }
      );
      resolveCalleeClasses(current.callee, emptyAliases, new Map()).forEach(
        (classNode) =>
          addClassConstructionEffects(
            classNode,
            current.arguments,
            emptyAliases,
            new Set(),
            new Map(),
            new Map(),
            new Map(),
            new Set()
          )
      );
      return;
    }

    if (current.type === 'TaggedTemplateExpression') {
      addInvokedCalleeBindings(current.tag, emptyAliases);
      current.quasi.expressions.forEach((expression) => addRoots(expression));
      const tagArguments: Array<Node | null> = [
        null,
        ...current.quasi.expressions,
      ];
      resolveCalleeCallables(current.tag, emptyAliases, new Map()).forEach(
        (tag) => {
          addCallableEffects(
            tag,
            tagArguments,
            emptyAliases,
            new Set(),
            new Map(),
            new Map(),
            new Map()
          );
        }
      );
    }
  });

  return {
    bindings,
    callableResultPaths,
    effectOrigins,
    opaqueImportedCall,
  };
};
