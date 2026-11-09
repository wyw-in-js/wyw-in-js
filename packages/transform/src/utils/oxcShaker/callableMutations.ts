import type { Node, Program } from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import {
  collectModuleReferences,
  collectMutations,
  forEachModuleExecutedNode,
  getImmediatelyInvokedFunction,
  getMutatedBinding,
  unwrapAliasExpression,
} from './executableIndex';

export const mutatingMethodNames = new Set([
  'add',
  'clear',
  'copyWithin',
  'delete',
  'fill',
  'pop',
  'push',
  'reverse',
  'set',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

export type CallableMutationHints = {
  callArgumentNames: Set<string>;
  mutatedNames: Set<string>;
};

const isFunctionNode = (node: Node): node is Node & { body: Node } =>
  node.type === 'FunctionDeclaration' ||
  node.type === 'FunctionExpression' ||
  node.type === 'ArrowFunctionExpression';

const isClassNode = (node: Node): boolean =>
  node.type === 'ClassDeclaration' || node.type === 'ClassExpression';

const staticMethodName = (callee: Node): string | null => {
  if (callee.type !== 'MemberExpression') {
    return null;
  }

  const { property } = callee;
  if (!callee.computed && property.type === 'Identifier') {
    return property.name;
  }

  return property.type === 'Literal' && typeof property.value === 'string'
    ? property.value
    : null;
};

const isCallableNode = (node: Node): boolean =>
  isFunctionNode(node) || isClassNode(node);

const isAccessor = (node: Node, parent: Node | null): boolean =>
  !!parent &&
  (parent.type === 'Property' || parent.type === 'MethodDefinition') &&
  (parent.kind === 'get' || parent.kind === 'set') &&
  parent.value === node;

/** Functions and classes in `node`, not counting those nested in them. */
const collectOutermostCallables = (node: Node, result: Node[] = []): Node[] => {
  if (isCallableNode(node)) {
    result.push(node);
    return result;
  }

  getOxcNodeChildren(node).forEach((child) =>
    collectOutermostCallables(child, result)
  );
  return result;
};

const collectBodyMutations = (body: Node, names: Set<string>): void => {
  collectMutations(body).forEach((name) => names.add(name));
  forEachModuleExecutedNode(body, (current) => {
    if (current.type !== 'CallExpression' && current.type !== 'NewExpression') {
      return;
    }

    const callee = unwrapAliasExpression(current.callee);
    const methodName = staticMethodName(callee);
    if (
      callee.type === 'MemberExpression' &&
      methodName &&
      mutatingMethodNames.has(methodName)
    ) {
      const rootName = getMutatedBinding(callee.object);
      if (rootName) {
        names.add(rootName);
      }
    }
  });
};

const collectBodyCallArguments = (body: Node, names: Set<string>): void => {
  forEachModuleExecutedNode(body, (current) => {
    if (current.type !== 'CallExpression' && current.type !== 'NewExpression') {
      return;
    }

    current.arguments.forEach((argument) => {
      const rootName = getMutatedBinding(
        argument.type === 'SpreadElement' ? argument.argument : argument
      );
      if (rootName) {
        names.add(rootName);
      }
    });
  });
};

type CallableIndex = {
  /** Functions and classes a binding name may refer to when it is called. */
  byName: Map<string, Node[]>;
  /** The object literal or class whose members a callable belongs to. */
  groups: Map<Node, Node[]>;
  /** The outermost function or class that contains a callable. */
  units: Map<Node, Node>;
  accessors: Node[];
};

const indexCallables = (program: Program): CallableIndex => {
  const index: CallableIndex = {
    accessors: [],
    byName: new Map(),
    groups: new Map(),
    units: new Map(),
  };
  const addName = (name: string, callables: Node[]): void => {
    index.byName.set(name, [...(index.byName.get(name) ?? []), ...callables]);
  };
  const addGroup = (owner: Node): Node[] => {
    const group = isClassNode(owner)
      ? [
          owner,
          ...getOxcNodeChildren(owner).flatMap((child) =>
            collectOutermostCallables(child)
          ),
        ]
      : collectOutermostCallables(owner);
    group.forEach((member) => index.groups.set(member, group));
    return group;
  };

  const visit = (node: Node, parent: Node | null, unit: Node | null): void => {
    let currentUnit = unit;
    if (isCallableNode(node)) {
      currentUnit = unit ?? node;
      index.units.set(node, currentUnit);
      if (isAccessor(node, parent)) {
        index.accessors.push(node);
      }
    }

    if (
      (node.type === 'FunctionDeclaration' ||
        node.type === 'ClassDeclaration') &&
      node.id
    ) {
      addName(node.id.name, isClassNode(node) ? addGroup(node) : [node]);
    } else if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'Identifier' &&
      node.init
    ) {
      const init = unwrapAliasExpression(node.init);
      if (isFunctionNode(init)) {
        addName(node.id.name, [init]);
      } else if (isClassNode(init) || init.type === 'ObjectExpression') {
        addName(node.id.name, addGroup(init));
      }
    }

    getOxcNodeChildren(node).forEach((child) =>
      visit(child, node, currentUnit)
    );
  };

  visit(program, null, null);
  return index;
};

/**
 * Finds the functions and classes that can run while the module loads: those
 * called, constructed or used as a tag by top-level code, immediately invoked
 * functions, callbacks handed to such calls, members of objects and classes
 * whose members are called, accessors, and everything those call in turn.
 */
const collectLoadTimeCallables = (
  program: Program,
  index: CallableIndex
): Set<Node> => {
  const reached = new Set<Node>();
  const queue: Node[] = [];
  const reachOne = (callable: Node): void => {
    if (!reached.has(callable)) {
      reached.add(callable);
      queue.push(callable);
    }
  };
  const reach = (callable: Node): void => {
    (index.groups.get(callable) ?? [callable]).forEach(reachOne);
  };
  const reachName = (name: string | null): void => {
    if (name) {
      index.byName.get(name)?.forEach(reach);
    }
  };
  const reachValue = (value: Node): void => {
    collectOutermostCallables(value).forEach(reach);
    forEachModuleExecutedNode(value, (current) => {
      if (current.type === 'Identifier') {
        reachName(current.name);
      }
    });
  };
  const visitExecuted = (node: Node): void => {
    forEachModuleExecutedNode(node, (current) => {
      if (isClassNode(current) && current !== node) {
        // A class definition runs its static blocks and field initializers.
        reachOne(current);
        return;
      }

      let callee: Node | null = null;
      let callArguments: readonly Node[] = [];
      if (
        current.type === 'CallExpression' ||
        current.type === 'NewExpression'
      ) {
        callee = current.callee;
        callArguments = current.arguments;
        const invoked = getImmediatelyInvokedFunction(current.callee);
        if (invoked) {
          reach(invoked);
        }
      } else if (current.type === 'TaggedTemplateExpression') {
        callee = current.tag;
      }

      if (!callee) {
        return;
      }

      const target = unwrapAliasExpression(callee);
      reachName(
        target.type === 'Identifier'
          ? target.name
          : getMutatedBinding(
              target.type === 'MemberExpression' ? target.object : target
            )
      );
      callArguments.forEach(reachValue);
    });
  };

  index.accessors.forEach(reach);
  visitExecuted(program);
  while (queue.length > 0) {
    const callable = queue.pop()!;
    visitExecuted(
      isFunctionNode(callable)
        ? (callable as Node & { body: Node }).body
        : callable
    );
  }

  return reached;
};

/**
 * Collects the module-level names that functions and classes which can run
 * while the module loads may change: names they assign, update, delete, write
 * a property of or call a mutating method on (`mutatedNames`), and names they
 * pass to calls (`callArgumentNames`). Code that only runs later, such as an
 * exported function, does not change what the module holds once it has loaded;
 * an importer that calls it first is handled where that call is made. Names a
 * callable declares itself, such as parameters and locals, are left out.
 */
export const collectCallableMutationHints = (
  program: Program
): CallableMutationHints => {
  const hints: CallableMutationHints = {
    callArgumentNames: new Set(),
    mutatedNames: new Set(),
  };
  const index = indexCallables(program);
  const freeNamesByUnit = new Map<Node, Set<string>>();
  const addFree = (callable: Node, names: Set<string>, target: Set<string>) => {
    const unit = index.units.get(callable) ?? callable;
    let freeNames = freeNamesByUnit.get(unit);
    if (!freeNames) {
      freeNames = collectModuleReferences(unit);
      freeNamesByUnit.set(unit, freeNames);
    }
    names.forEach((name) => {
      if (freeNames!.has(name)) {
        target.add(name);
      }
    });
  };
  const bodyOf = (callable: Node): Node =>
    isFunctionNode(callable)
      ? (callable as Node & { body: Node }).body
      : callable;

  collectLoadTimeCallables(program, index).forEach((callable) => {
    const mutated = new Set<string>();
    collectBodyMutations(bodyOf(callable), mutated);
    addFree(callable, mutated, hints.mutatedNames);

    const passed = new Set<string>();
    collectBodyCallArguments(bodyOf(callable), passed);
    addFree(callable, passed, hints.callArgumentNames);
  });

  return hints;
};

/** Defers {@link collectCallableMutationHints} until the first call. */
export const createCallableMutationHintsReader = (
  program: Program
): (() => CallableMutationHints) => {
  let hints: CallableMutationHints | null = null;
  return () => {
    hints ??= collectCallableMutationHints(program);
    return hints;
  };
};
