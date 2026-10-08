/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type {
  Expression,
  ImportDeclaration,
  ImportSpecifier,
  ModuleExportName,
  Node,
  Program,
} from 'oxc-parser';

import { createOxcStaticCallableValue } from '../../../utils/collectOxcTemplateDependencies';
import { getOxcNodeChildren } from '../../../utils/oxc/ast';
import {
  isTypeOnlyImport,
  isTypeOnlyImportSpecifier,
} from '../../../utils/oxc/typeOnlyImport';
import { parseProgram } from './environment';
import type {
  AnyNode,
  CollectImportBindingsOptions,
  ImportBinding,
  StaticExportResult,
  StaticExpressionOptions,
} from './types';

export const moduleExportName = (node: ModuleExportName): string =>
  node.type === 'Literal' ? String(node.value) : node.name;

export const unwrapExpression = (expr: Node): Node => {
  let current = expr;

  for (;;) {
    if (
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSInstantiationExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'ParenthesizedExpression'
    ) {
      current = current.expression;
      continue;
    }

    return current;
  }
};

export const isProcessEnvMember = (node: Node): boolean => {
  if (node.type !== 'MemberExpression' || node.computed) {
    return false;
  }

  if (node.property.type !== 'Identifier' || node.property.name !== 'env') {
    return false;
  }

  return node.object.type === 'Identifier' && node.object.name === 'process';
};

export const isSafeLiteral = (
  node: Node
): node is Node & {
  type: 'Literal';
  value: boolean | null | number | string;
} => {
  if (node.type !== 'Literal') {
    return false;
  }

  const { value } = node as AnyNode;
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
};

export const isSafeStaticExpression = (
  expr: Node,
  options: StaticExpressionOptions = {}
): boolean => {
  const unwrapped = unwrapExpression(expr);

  if (isSafeLiteral(unwrapped)) {
    return true;
  }

  if (unwrapped.type === 'Identifier') {
    return true;
  }

  if (unwrapped.type === 'TemplateLiteral') {
    return unwrapped.expressions.every((item) =>
      isSafeStaticExpression(item, options)
    );
  }

  if (unwrapped.type === 'UnaryExpression') {
    return isSafeStaticExpression(unwrapped.argument, options);
  }

  if (
    unwrapped.type === 'BinaryExpression' ||
    unwrapped.type === 'LogicalExpression'
  ) {
    return (
      isSafeStaticExpression(unwrapped.left, options) &&
      isSafeStaticExpression(unwrapped.right, options)
    );
  }

  if (unwrapped.type === 'ConditionalExpression') {
    return (
      isSafeStaticExpression(unwrapped.test, options) &&
      isSafeStaticExpression(unwrapped.consequent, options) &&
      isSafeStaticExpression(unwrapped.alternate, options)
    );
  }

  if (unwrapped.type === 'MemberExpression') {
    return (
      isSafeStaticExpression(unwrapped.object, options) &&
      (unwrapped.computed
        ? isSafeStaticExpression(unwrapped.property, options)
        : unwrapped.property.type === 'Identifier')
    );
  }

  if (options.allowMetadataCalls && unwrapped.type === 'CallExpression') {
    return (
      unwrapped.callee.type === 'Identifier' && unwrapped.arguments.length === 0
    );
  }

  if (
    unwrapped.type === 'CallExpression' &&
    options.staticHelperLocals &&
    unwrapped.callee.type === 'Identifier' &&
    options.staticHelperLocals.has(unwrapped.callee.name)
  ) {
    return unwrapped.arguments.every((argument) =>
      argument.type === 'SpreadElement'
        ? isSafeStaticExpression(argument.argument, options)
        : isSafeStaticExpression(argument as Node, options)
    );
  }

  if (
    options.allowMetadataCalls &&
    (unwrapped.type === 'ArrowFunctionExpression' ||
      unwrapped.type === 'FunctionExpression')
  ) {
    return (
      !unwrapped.async &&
      unwrapped.params.length === 0 &&
      !!unwrapped.body &&
      isSafeFunctionBodyExpression(unwrapped.body, options)
    );
  }

  if (unwrapped.type === 'ArrayExpression') {
    return unwrapped.elements.every((item) => {
      if (!item) {
        return false;
      }

      return item.type === 'SpreadElement'
        ? isSafeStaticExpression(item.argument, options)
        : isSafeStaticExpression(item, options);
    });
  }

  if (unwrapped.type === 'ObjectExpression') {
    return unwrapped.properties.every((property) => {
      if (property.type === 'SpreadElement') {
        return isSafeStaticExpression(property.argument, options);
      }

      const propertyNode = property as AnyNode;
      if (propertyNode.method) {
        return false;
      }

      // Computed keys are admissible as long as the key expression
      // itself is safe-static — the downstream evaluator already folds
      // them against the env. Common shape: `[\`${imp} &\`]: { ... }`.
      if (
        propertyNode.computed &&
        (!propertyNode.key ||
          typeof propertyNode.key !== 'object' ||
          !isSafeStaticExpression(propertyNode.key as Node, options))
      ) {
        return false;
      }

      return (
        propertyNode.value &&
        typeof propertyNode.value === 'object' &&
        isSafeStaticExpression(propertyNode.value as Node, options)
      );
    });
  }

  return false;
};

export const getImportBinding = (
  statement: ImportDeclaration,
  specifier: ImportDeclaration['specifiers'][number],
  options: CollectImportBindingsOptions = {}
): ImportBinding | null => {
  const local = specifier.local?.name;
  if (!local) {
    return null;
  }

  if (specifier.type === 'ImportNamespaceSpecifier') {
    return options.includeNamespace
      ? {
          imported: '*',
          local,
          source: statement.source.value,
        }
      : null;
  }

  if (specifier.type === 'ImportDefaultSpecifier') {
    return {
      imported: 'default',
      local,
      source: statement.source.value,
    };
  }

  if (specifier.type !== 'ImportSpecifier') {
    return null;
  }

  if (isTypeOnlyImportSpecifier(statement, specifier)) {
    return null;
  }

  return {
    imported: moduleExportName((specifier as ImportSpecifier).imported),
    local,
    source: statement.source.value,
  };
};

export const collectImportBindings = (
  program: Program,
  options: CollectImportBindingsOptions = {}
): Map<string, ImportBinding> => {
  const result = new Map<string, ImportBinding>();

  program.body.forEach((statement) => {
    if (statement.type !== 'ImportDeclaration' || isTypeOnlyImport(statement)) {
      return;
    }

    statement.specifiers.forEach((specifier) => {
      const binding = getImportBinding(statement, specifier, options);
      if (binding) {
        result.set(binding.local, binding);
      }
    });
  });

  return result;
};
export const parseStaticExpressionSource = (
  source: string,
  filename: string
): Expression | null => {
  try {
    const program = parseProgram(
      `const __wyw_static_value = ${source};`,
      filename
    );
    const declaration = program.body[0];
    if (declaration?.type !== 'VariableDeclaration') {
      return null;
    }

    const [declarator] = declaration.declarations;
    return declarator?.init ?? null;
  } catch {
    return null;
  }
};

export const isRuntimeCallbackExpression = (
  expression: Expression | null
): boolean => {
  const unwrapped = expression ? unwrapExpression(expression) : null;
  return (
    unwrapped?.type === 'ArrowFunctionExpression' ||
    unwrapped?.type === 'FunctionExpression'
  );
};

export const runtimeCallbackPlaceholder = (): undefined => undefined;

export const isIdentifierBindingPosition = (
  node: Node,
  parent: Node | null
): boolean => {
  if (node.type !== 'Identifier' || !parent) {
    return false;
  }

  if (
    (parent.type === 'VariableDeclarator' && parent.id === node) ||
    (parent.type === 'FunctionDeclaration' && parent.id === node) ||
    (parent.type === 'FunctionExpression' && parent.id === node) ||
    (parent.type === 'ClassDeclaration' && parent.id === node) ||
    (parent.type === 'ClassExpression' && parent.id === node)
  ) {
    return true;
  }

  if (
    (parent.type === 'ArrowFunctionExpression' ||
      parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression') &&
    parent.params.some((param) => param === node)
  ) {
    return true;
  }

  return (
    (parent.type === 'ImportSpecifier' && parent.local === node) ||
    (parent.type === 'ImportDefaultSpecifier' && parent.local === node) ||
    (parent.type === 'ImportNamespaceSpecifier' && parent.local === node)
  );
};

export const isPropertyKeyOnlyIdentifier = (
  node: Node,
  parent: Node | null
): boolean =>
  node.type === 'Identifier' &&
  !!parent &&
  ((parent.type === 'MemberExpression' &&
    parent.property === node &&
    !parent.computed) ||
    (parent.type === 'Property' &&
      parent.key === node &&
      !parent.computed &&
      !parent.shorthand));

export const expressionUsesNameOnlyAsZeroArgCalls = (
  expression: Node,
  name: string
): boolean => {
  let seen = false;
  let valid = true;

  const walk = (node: Node, parent: Node | null): void => {
    if (!valid) {
      return;
    }

    if (
      node.type === 'Identifier' &&
      node.name === name &&
      !isIdentifierBindingPosition(node, parent) &&
      !isPropertyKeyOnlyIdentifier(node, parent)
    ) {
      if (
        parent?.type === 'CallExpression' &&
        parent.callee === node &&
        parent.arguments.length === 0
      ) {
        seen = true;
      } else {
        valid = false;
        return;
      }
    }

    getOxcNodeChildren(node).forEach((child) => walk(child, node));
  };

  walk(expression, null);
  return seen && valid;
};

export const bindStaticResolvedValue = (
  env: Map<string, unknown>,
  expression: Node,
  local: string,
  resolved: StaticExportResult,
  options: { wrapNonCallable?: boolean } = {}
): boolean => {
  if (resolved.callable === 'zero-arg') {
    if (!expressionUsesNameOnlyAsZeroArgCalls(expression, local)) {
      return false;
    }

    env.set(local, createOxcStaticCallableValue(resolved.value));
    return true;
  }

  env.set(
    local,
    options.wrapNonCallable
      ? createOxcStaticCallableValue(resolved.value)
      : resolved.value
  );
  return true;
};
export const isSafeFunctionBodyExpression = (
  body: Node,
  options: StaticExpressionOptions
): boolean => {
  if (body.type !== 'BlockStatement') {
    return isSafeStaticExpression(body, options);
  }

  return body.body.every((statement) => {
    if (statement.type === 'VariableDeclaration') {
      return (
        statement.kind === 'const' &&
        statement.declarations.every(
          (declarator) =>
            declarator.init &&
            declarator.id.type === 'Identifier' &&
            isSafeStaticExpression(declarator.init, options)
        )
      );
    }

    return (
      statement.type === 'ReturnStatement' &&
      !!statement.argument &&
      isSafeStaticExpression(statement.argument, options)
    );
  });
};

export const collectStaticFunctionBodyReferences = (
  body: Node,
  references: Set<string>,
  options: StaticExpressionOptions
): boolean => {
  if (body.type !== 'BlockStatement') {
    return collectStaticExpressionReferences(body, references, options);
  }

  return body.body.every((statement) => {
    if (statement.type === 'VariableDeclaration') {
      return (
        statement.kind === 'const' &&
        statement.declarations.every(
          (declarator) =>
            declarator.init &&
            declarator.id.type === 'Identifier' &&
            collectStaticExpressionReferences(
              declarator.init,
              references,
              options
            )
        )
      );
    }

    return (
      statement.type === 'ReturnStatement' &&
      !!statement.argument &&
      collectStaticExpressionReferences(statement.argument, references, options)
    );
  });
};

export const collectStaticExpressionReferences = (
  expr: Node,
  references: Set<string>,
  options: StaticExpressionOptions = {}
): boolean => {
  const unwrapped = unwrapExpression(expr);

  if (isSafeLiteral(unwrapped)) {
    return true;
  }

  if (unwrapped.type === 'Identifier') {
    references.add(unwrapped.name);
    return true;
  }

  if (unwrapped.type === 'TemplateLiteral') {
    return unwrapped.expressions.every((item) =>
      collectStaticExpressionReferences(item, references, options)
    );
  }

  if (unwrapped.type === 'UnaryExpression') {
    return collectStaticExpressionReferences(
      unwrapped.argument,
      references,
      options
    );
  }

  if (
    unwrapped.type === 'BinaryExpression' ||
    unwrapped.type === 'LogicalExpression'
  ) {
    return (
      collectStaticExpressionReferences(unwrapped.left, references, options) &&
      collectStaticExpressionReferences(unwrapped.right, references, options)
    );
  }

  if (unwrapped.type === 'ConditionalExpression') {
    return (
      collectStaticExpressionReferences(unwrapped.test, references, options) &&
      collectStaticExpressionReferences(
        unwrapped.consequent,
        references,
        options
      ) &&
      collectStaticExpressionReferences(
        unwrapped.alternate,
        references,
        options
      )
    );
  }

  if (unwrapped.type === 'MemberExpression') {
    if (isProcessEnvMember(unwrapped) || isProcessEnvMember(unwrapped.object)) {
      // process.env / process.env.X is an opaque build-time global —
      // don't treat `process` as an unresolved local reference.
      return true;
    }

    return (
      collectStaticExpressionReferences(
        unwrapped.object,
        references,
        options
      ) &&
      (!unwrapped.computed ||
        collectStaticExpressionReferences(
          unwrapped.property,
          references,
          options
        ))
    );
  }

  if (options.allowMetadataCalls && unwrapped.type === 'CallExpression') {
    if (
      unwrapped.callee.type !== 'Identifier' ||
      unwrapped.arguments.length !== 0
    ) {
      return false;
    }

    references.add(unwrapped.callee.name);
    return true;
  }

  if (
    unwrapped.type === 'CallExpression' &&
    options.staticHelperLocals &&
    unwrapped.callee.type === 'Identifier' &&
    options.staticHelperLocals.has(unwrapped.callee.name)
  ) {
    references.add(unwrapped.callee.name);
    return unwrapped.arguments.every((argument) =>
      argument.type === 'SpreadElement'
        ? collectStaticExpressionReferences(
            argument.argument,
            references,
            options
          )
        : collectStaticExpressionReferences(
            argument as Node,
            references,
            options
          )
    );
  }

  if (
    options.allowMetadataCalls &&
    (unwrapped.type === 'ArrowFunctionExpression' ||
      unwrapped.type === 'FunctionExpression')
  ) {
    if (unwrapped.async || unwrapped.params.length !== 0) {
      return false;
    }

    return (
      !!unwrapped.body &&
      collectStaticFunctionBodyReferences(unwrapped.body, references, options)
    );
  }

  if (unwrapped.type === 'ArrayExpression') {
    return unwrapped.elements.every((item) => {
      if (!item) {
        return false;
      }

      return item.type === 'SpreadElement'
        ? collectStaticExpressionReferences(item.argument, references, options)
        : collectStaticExpressionReferences(item, references, options);
    });
  }

  if (unwrapped.type === 'ObjectExpression') {
    return unwrapped.properties.every((property) => {
      if (property.type === 'SpreadElement') {
        return collectStaticExpressionReferences(
          property.argument,
          references,
          options
        );
      }

      const propertyNode = property as AnyNode;
      if (!propertyNode.value || typeof propertyNode.value !== 'object') {
        return false;
      }

      if (
        propertyNode.computed &&
        (!propertyNode.key ||
          typeof propertyNode.key !== 'object' ||
          !collectStaticExpressionReferences(
            propertyNode.key as Node,
            references,
            options
          ))
      ) {
        return false;
      }

      return collectStaticExpressionReferences(
        propertyNode.value as Node,
        references,
        options
      );
    });
  }

  return false;
};
