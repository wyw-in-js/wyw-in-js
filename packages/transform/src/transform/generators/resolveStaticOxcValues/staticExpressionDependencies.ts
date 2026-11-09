/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type {
  Expression,
  Node,
  Program,
  VariableDeclaration,
} from 'oxc-parser';

import {
  collectCallableMutationHints,
  mutatingMethodNames,
} from '../../../utils/oxcShaker/callableMutations';

import { collectLocalConstExpressions } from './programAnalysis';
import {
  collectImportBindings,
  collectStaticExpressionReferences,
  isSafeLiteral,
  isSafeStaticExpression,
  unwrapExpression,
} from './staticExpression';
import type {
  AnyNode,
  ExportTarget,
  ImportBinding,
  StaticExpressionDependencies,
  StaticExpressionOptions,
} from './types';

export const rootIdentifierName = (expr: Node): string | null => {
  const unwrapped = unwrapExpression(expr);

  if (unwrapped.type === 'Identifier') {
    return unwrapped.name;
  }

  if (unwrapped.type === 'MemberExpression') {
    return rootIdentifierName(unwrapped.object);
  }

  if (unwrapped.type === 'ChainExpression') {
    return rootIdentifierName(unwrapped.expression);
  }

  return null;
};

export const staticMemberName = (expr: Node): string | null => {
  const unwrapped = unwrapExpression(expr);

  if (unwrapped.type === 'Identifier') {
    return unwrapped.name;
  }

  if (isSafeLiteral(unwrapped) && typeof unwrapped.value === 'string') {
    return unwrapped.value;
  }

  return null;
};

export const expressionMayProduceMutableValue = (
  expr: Node,
  locals: Map<string, Expression>,
  visiting: Set<string>
): boolean => {
  const unwrapped = unwrapExpression(expr);

  if (
    unwrapped.type === 'ObjectExpression' ||
    unwrapped.type === 'ArrayExpression'
  ) {
    return true;
  }

  if (unwrapped.type === 'Identifier') {
    const local = locals.get(unwrapped.name);
    if (!local || visiting.has(unwrapped.name)) {
      return true;
    }

    visiting.add(unwrapped.name);
    const result = expressionMayProduceMutableValue(local, locals, visiting);
    visiting.delete(unwrapped.name);
    return result;
  }

  if (unwrapped.type === 'ConditionalExpression') {
    return (
      expressionMayProduceMutableValue(
        unwrapped.consequent,
        locals,
        visiting
      ) ||
      expressionMayProduceMutableValue(unwrapped.alternate, locals, visiting)
    );
  }

  if (
    unwrapped.type === 'LogicalExpression' ||
    unwrapped.type === 'MemberExpression'
  ) {
    return true;
  }

  return false;
};
export const collectExpressionMutationHints = (
  expr: Node,
  mutatedNames: Set<string>,
  callArgumentNames: Set<string>
): void => {
  const unwrapped = unwrapExpression(expr);

  if (unwrapped.type === 'AssignmentExpression') {
    const rootName = rootIdentifierName(unwrapped.left);
    if (rootName) {
      mutatedNames.add(rootName);
    }

    collectExpressionMutationHints(
      unwrapped.right,
      mutatedNames,
      callArgumentNames
    );
    return;
  }

  if (unwrapped.type === 'UpdateExpression') {
    const rootName = rootIdentifierName(unwrapped.argument);
    if (rootName) {
      mutatedNames.add(rootName);
    }

    return;
  }

  if (unwrapped.type === 'UnaryExpression') {
    if (unwrapped.operator === 'delete') {
      const rootName = rootIdentifierName(unwrapped.argument);
      if (rootName) {
        mutatedNames.add(rootName);
      }
    }

    collectExpressionMutationHints(
      unwrapped.argument,
      mutatedNames,
      callArgumentNames
    );
    return;
  }

  if (unwrapped.type === 'CallExpression') {
    const callee = unwrapExpression(unwrapped.callee);
    if (callee.type === 'MemberExpression') {
      const methodName = staticMemberName(callee.property);
      const rootName = rootIdentifierName(callee.object);
      if (rootName && methodName && mutatingMethodNames.has(methodName)) {
        mutatedNames.add(rootName);
      }

      collectExpressionMutationHints(
        callee.object,
        mutatedNames,
        callArgumentNames
      );
      if (callee.computed) {
        collectExpressionMutationHints(
          callee.property,
          mutatedNames,
          callArgumentNames
        );
      }
    } else {
      collectExpressionMutationHints(
        unwrapped.callee,
        mutatedNames,
        callArgumentNames
      );
    }

    unwrapped.arguments.forEach((argument) => {
      const argumentNode =
        argument.type === 'SpreadElement' ? argument.argument : argument;
      const rootName = rootIdentifierName(argumentNode);
      if (rootName) {
        callArgumentNames.add(rootName);
      }

      collectExpressionMutationHints(
        argumentNode,
        mutatedNames,
        callArgumentNames
      );
    });
    return;
  }

  if (unwrapped.type === 'TaggedTemplateExpression') {
    collectExpressionMutationHints(
      unwrapped.tag,
      mutatedNames,
      callArgumentNames
    );
    unwrapped.quasi.expressions.forEach((item) =>
      collectExpressionMutationHints(item, mutatedNames, callArgumentNames)
    );
    return;
  }

  if (unwrapped.type === 'ConditionalExpression') {
    collectExpressionMutationHints(
      unwrapped.test,
      mutatedNames,
      callArgumentNames
    );
    collectExpressionMutationHints(
      unwrapped.consequent,
      mutatedNames,
      callArgumentNames
    );
    collectExpressionMutationHints(
      unwrapped.alternate,
      mutatedNames,
      callArgumentNames
    );
    return;
  }

  if (
    unwrapped.type === 'BinaryExpression' ||
    unwrapped.type === 'LogicalExpression'
  ) {
    collectExpressionMutationHints(
      unwrapped.left,
      mutatedNames,
      callArgumentNames
    );
    collectExpressionMutationHints(
      unwrapped.right,
      mutatedNames,
      callArgumentNames
    );
    return;
  }

  if (unwrapped.type === 'MemberExpression') {
    collectExpressionMutationHints(
      unwrapped.object,
      mutatedNames,
      callArgumentNames
    );
    if (unwrapped.computed) {
      collectExpressionMutationHints(
        unwrapped.property,
        mutatedNames,
        callArgumentNames
      );
    }
    return;
  }

  if (unwrapped.type === 'ArrayExpression') {
    unwrapped.elements.forEach((item) => {
      if (!item) {
        return;
      }

      collectExpressionMutationHints(
        item.type === 'SpreadElement' ? item.argument : item,
        mutatedNames,
        callArgumentNames
      );
    });
    return;
  }

  if (unwrapped.type === 'ObjectExpression') {
    unwrapped.properties.forEach((property) => {
      if (property.type === 'SpreadElement') {
        collectExpressionMutationHints(
          property.argument,
          mutatedNames,
          callArgumentNames
        );
        return;
      }

      const propertyNode = property as AnyNode;
      if (propertyNode.computed && propertyNode.key) {
        collectExpressionMutationHints(
          propertyNode.key as Node,
          mutatedNames,
          callArgumentNames
        );
      }

      if (propertyNode.value && typeof propertyNode.value === 'object') {
        collectExpressionMutationHints(
          propertyNode.value as Node,
          mutatedNames,
          callArgumentNames
        );
      }
    });
  }
};

export const collectTopLevelMutationHints = (
  program: Program,
  closureNames: ReadonlySet<string> | null = null
): { callArgumentNames: Set<string>; mutatedNames: Set<string> } => {
  const callArgumentNames = new Set<string>();
  const mutatedNames = new Set<string>();

  const collectDeclaration = (declaration: VariableDeclaration): void => {
    declaration.declarations.forEach((declarator) => {
      if (closureNames) {
        const declaredName =
          declarator.id.type === 'Identifier' ? declarator.id.name : null;
        if (!declaredName || !closureNames.has(declaredName)) {
          return;
        }
      }
      if (declarator.init) {
        collectExpressionMutationHints(
          declarator.init,
          mutatedNames,
          callArgumentNames
        );
      }
    });
  };

  program.body.forEach((statement) => {
    if (statement.type === 'VariableDeclaration') {
      collectDeclaration(statement);
      return;
    }

    if (statement.type === 'ExpressionStatement') {
      collectExpressionMutationHints(
        statement.expression,
        mutatedNames,
        callArgumentNames
      );
      return;
    }

    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.declaration?.type === 'VariableDeclaration') {
        collectDeclaration(statement.declaration);
      }

      return;
    }

    if (statement.type === 'ExportDefaultDeclaration') {
      if (
        statement.declaration.type !== 'FunctionDeclaration' &&
        statement.declaration.type !== 'ClassDeclaration'
      ) {
        collectExpressionMutationHints(
          statement.declaration,
          mutatedNames,
          callArgumentNames
        );
      }
    }
  });

  return { callArgumentNames, mutatedNames };
};
export const collectStaticExpressionDependencies = (
  program: Program,
  target: Extract<ExportTarget, { kind: 'expression' }>,
  options: StaticExpressionOptions = {}
): StaticExpressionDependencies | null => {
  const imports = collectImportBindings(program);
  const locals = collectLocalConstExpressions(program);
  const collectedImports = new Map<string, ImportBinding>();
  const referencedNames = new Set<string>();
  const mutableReferencedNames = new Set<string>();
  const visitedLocals = new Set<string>();
  const visitingLocals = new Set<string>();

  const markMutable = (name: string, expression: Node): void => {
    if (expressionMayProduceMutableValue(expression, locals, new Set())) {
      mutableReferencedNames.add(name);
    }
  };

  const collectLocal = (name: string): boolean => {
    // Pre-resolved locals (e.g. `const x = css\`\``) have a known value
    // (the className string). Skip walking their init — its
    // TaggedTemplateExpression isn't safe-static by itself, but the
    // value is already determined.
    if (options.preResolvedLocals?.has(name)) {
      referencedNames.add(name);
      visitedLocals.add(name);
      return true;
    }

    const expression = locals.get(name);
    if (!expression || visitingLocals.has(name)) {
      return false;
    }

    referencedNames.add(name);
    markMutable(name, expression);

    if (visitedLocals.has(name)) {
      return true;
    }

    visitingLocals.add(name);
    const result = collectExpression(expression);
    visitingLocals.delete(name);

    if (result) {
      visitedLocals.add(name);
    }

    return result;
  };

  const collectExpression = (expr: Node): boolean => {
    if (!isSafeStaticExpression(expr, options)) {
      return false;
    }

    const references = new Set<string>();
    if (!collectStaticExpressionReferences(expr, references, options)) {
      return false;
    }

    for (const reference of references) {
      referencedNames.add(reference);

      const importBinding = imports.get(reference);
      if (importBinding) {
        collectedImports.set(
          `${importBinding.source}\0${importBinding.imported}\0${importBinding.local}`,
          importBinding
        );
        mutableReferencedNames.add(reference);
        continue;
      }

      if (!collectLocal(reference)) {
        // Unknown identifier — neither an import nor a same-file local.
        // Common case: undeclared globals like __DEV__ used in
        // `typeof __DEV__ !== "undefined"` short-circuit guards. The
        // evaluator returns undefined for unknowns, which the outer
        // expression's logical short-circuits handle correctly. Don't
        // reject the whole walk upfront — let the evaluator decide.
        continue;
      }
    }

    return true;
  };

  if (target.localName) {
    referencedNames.add(target.localName);
    markMutable(target.localName, target.expression);
  }

  if (!collectExpression(target.expression)) {
    return null;
  }

  const closureNames = new Set(referencedNames);
  if (target.localName) {
    closureNames.add(target.localName);
  }
  const mutationHints = collectTopLevelMutationHints(program, closureNames);
  // Code inside functions and classes can only change a binding that is not
  // a `const` local or that holds a mutable value; skip the scan otherwise.
  const callableHints = [...referencedNames].some(
    (name) =>
      mutableReferencedNames.has(name) ||
      (!locals.has(name) && !options.preResolvedLocals?.has(name))
  )
    ? collectCallableMutationHints(program)
    : null;
  for (const name of referencedNames) {
    if (
      mutationHints.mutatedNames.has(name) ||
      callableHints?.mutatedNames.has(name)
    ) {
      return null;
    }
  }

  for (const name of mutableReferencedNames) {
    if (
      (mutationHints.callArgumentNames.has(name) ||
        callableHints?.callArgumentNames.has(name)) &&
      !options.ignoredMutableCallArgumentNames?.has(name)
    ) {
      return null;
    }
  }

  return {
    imports: [...collectedImports.values()],
  };
};
