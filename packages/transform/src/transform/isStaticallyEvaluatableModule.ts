import type {
  ExportNamedDeclaration,
  ImportDeclaration,
  Node,
  Program,
  VariableDeclaration,
  VariableDeclarator,
} from 'oxc-parser';

import { recordPipelineUncachedParse } from '../debug/pipelineTelemetry';
import { parseOxcSync } from '../utils/parseOxc';

const isNode = (value: unknown): value is Node =>
  !!value &&
  typeof value === 'object' &&
  'type' in value &&
  typeof (value as { type?: unknown }).type === 'string';

const getNodeType = (node: Pick<Node, 'type'>): string => node.type as string;

const parseOxc = (code: string, filename: string): Program => {
  const astType =
    filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'ts' : 'js';
  let parsed: ReturnType<typeof parseOxcSync>;
  try {
    parsed = parseOxcSync(filename, code, {
      astType,
      range: true,
      sourceType: 'unambiguous',
    });
  } catch (error) {
    recordPipelineUncachedParse(filename, code, 'unambiguous', astType, true);
    throw error;
  }
  const fatalError = parsed.errors.find((error) => error.severity === 'Error');
  if (fatalError) {
    recordPipelineUncachedParse(filename, code, 'unambiguous', astType, true);
    throw new Error(fatalError.message);
  }
  recordPipelineUncachedParse(filename, code, 'unambiguous', astType, false);

  return parsed.program as Program;
};

const isTypeOnlyImport = (statement: ImportDeclaration): boolean => {
  if (statement.importKind === 'type') {
    return true;
  }

  return Array.isArray(statement.specifiers)
    ? statement.specifiers.every(
        (specifier) =>
          isNode(specifier) &&
          specifier.type === 'ImportSpecifier' &&
          specifier.importKind === 'type'
      )
    : false;
};

const isTypeOnlyReExport = (statement: ExportNamedDeclaration): boolean =>
  !!statement.source && statement.exportKind === 'type';

const isWrapperExpression = (node: Node): node is Node & { expression: Node } =>
  node.type === 'TSAsExpression' ||
  node.type === 'TSSatisfiesExpression' ||
  node.type === 'TSNonNullExpression' ||
  node.type === 'TSInstantiationExpression' ||
  node.type === 'TSTypeAssertion' ||
  node.type === 'ParenthesizedExpression';

const unwrapExpression = (expr: Node): Node => {
  let current = expr;

  while (isWrapperExpression(current)) {
    current = current.expression;
  }

  return current;
};

const isSafeLiteral = (expr: Node): boolean =>
  getNodeType(expr) === 'Literal' &&
  (() => {
    const { value } = expr as Node & { value?: unknown };
    return (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    );
  })();

const isSafeExpression = (expr: Node): boolean => {
  const unwrapped = unwrapExpression(expr);
  const type = unwrapped.type as string;

  if (isSafeLiteral(unwrapped)) {
    return true;
  }

  if (type === 'ArrowFunctionExpression' || type === 'FunctionExpression') {
    return true;
  }

  if (type === 'Identifier') {
    const identifier = unwrapped as Node & { name: string };
    return (
      identifier.name === 'undefined' ||
      identifier.name === 'NaN' ||
      identifier.name === 'Infinity'
    );
  }

  if (type === 'TemplateLiteral') {
    return (unwrapped as Node & { expressions: Node[] }).expressions.every(
      (item) => isSafeExpression(item)
    );
  }

  if (type === 'UnaryExpression') {
    return isSafeExpression((unwrapped as Node & { argument: Node }).argument);
  }

  if (type === 'BinaryExpression' || type === 'LogicalExpression') {
    const binaryLike = unwrapped as Node & { left: Node; right: Node };
    return (
      isSafeExpression(binaryLike.left) && isSafeExpression(binaryLike.right)
    );
  }

  if (type === 'ConditionalExpression') {
    const conditional = unwrapped as Node & {
      alternate: Node;
      consequent: Node;
      test: Node;
    };
    return (
      isSafeExpression(conditional.test) &&
      isSafeExpression(conditional.consequent) &&
      isSafeExpression(conditional.alternate)
    );
  }

  if (type === 'ArrayExpression') {
    return (
      unwrapped as Node & { elements: Array<Node | null> }
    ).elements.every((item) => {
      if (!item) {
        return true;
      }

      if (item.type === 'SpreadElement') {
        return false;
      }

      return isSafeExpression(item);
    });
  }

  if (type === 'ObjectExpression') {
    return (unwrapped as Node & { properties: Node[] }).properties.every(
      (property) => {
        if (property.type === 'SpreadElement') {
          return false;
        }

        const propertyNode = property as Node & {
          computed?: boolean;
          method?: boolean;
          value?: Node;
        };

        if (propertyNode.computed) {
          return false;
        }

        if (propertyNode.method) {
          return true;
        }

        return (
          isNode(propertyNode.value) && isSafeExpression(propertyNode.value)
        );
      }
    );
  }

  if (
    type === 'CallExpression' ||
    type === 'NewExpression' ||
    type === 'TaggedTemplateExpression' ||
    type === 'AwaitExpression' ||
    type === 'YieldExpression' ||
    type === 'UpdateExpression' ||
    type === 'AssignmentExpression' ||
    type === 'SequenceExpression' ||
    type === 'ClassExpression' ||
    type === 'ClassDeclaration'
  ) {
    return false;
  }

  return false;
};

const isSafeDeclarator = (declarator: VariableDeclarator): boolean =>
  !isNode(declarator.init) || isSafeExpression(declarator.init);

const isSafeVariableDeclaration = (statement: VariableDeclaration): boolean =>
  statement.declarations.every((declarator) => isSafeDeclarator(declarator));

const isSafeStatement = (statement: Node): boolean => {
  if (statement.type.startsWith('TS') || statement.type.startsWith('JSDoc')) {
    return statement.type !== 'TSEnumDeclaration';
  }

  if (statement.type === 'ImportDeclaration') {
    return isTypeOnlyImport(statement);
  }

  if (statement.type === 'ExportAllDeclaration') {
    return false;
  }

  if (statement.type === 'ExportNamedDeclaration') {
    if (!isNode(statement.declaration)) {
      return !isNode(statement.source) || isTypeOnlyReExport(statement);
    }

    if (statement.declaration.type === 'FunctionDeclaration') {
      return true;
    }

    if (statement.declaration.type === 'ClassDeclaration') {
      return false;
    }

    return (
      statement.declaration.type === 'VariableDeclaration' &&
      isSafeVariableDeclaration(statement.declaration)
    );
  }

  if (statement.type === 'ExportDefaultDeclaration') {
    const { declaration } = statement;
    if (!isNode(declaration)) {
      return false;
    }

    if (
      declaration.type === 'FunctionDeclaration' ||
      declaration.type === 'FunctionExpression' ||
      declaration.type === 'ArrowFunctionExpression' ||
      declaration.type === 'ClassExpression' ||
      declaration.type === 'ClassDeclaration'
    ) {
      return false;
    }

    return isSafeExpression(declaration);
  }

  if (statement.type === 'VariableDeclaration') {
    return isSafeVariableDeclaration(statement);
  }

  if (
    statement.type === 'FunctionDeclaration' ||
    statement.type === 'EmptyStatement'
  ) {
    return true;
  }

  if (statement.type === 'ExpressionStatement') {
    return isNode(statement.expression) && isSafeLiteral(statement.expression);
  }

  return false;
};

export function isStaticallyEvaluatableModule(
  code: string,
  filename: string
): boolean {
  return parseOxc(code, filename).body.every((statement) =>
    isSafeStatement(statement)
  );
}
