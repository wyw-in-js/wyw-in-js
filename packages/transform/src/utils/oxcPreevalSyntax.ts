import type { Expression, Node } from 'oxc-parser';

export const unwrapExpression = (node: Expression): Expression => {
  if (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSTypeAssertion' ||
    node.type === 'ParenthesizedExpression'
  ) {
    return unwrapExpression(node.expression);
  }

  return node;
};

export const getMemberPropertyName = (node: Node): string | null => {
  if (node.type !== 'MemberExpression') {
    return null;
  }

  if (node.computed) {
    return node.property.type === 'Literal' &&
      typeof node.property.value === 'string'
      ? node.property.value
      : null;
  }

  return node.property.type === 'Identifier' ? node.property.name : null;
};

export const isStringLikeExpression = (node: Expression): boolean => {
  const expression = unwrapExpression(node);

  if (expression.type === 'Literal' && typeof expression.value === 'string') {
    return true;
  }

  if (expression.type === 'TemplateLiteral') {
    return true;
  }

  if (expression.type === 'BinaryExpression' && expression.operator === '+') {
    return (
      isStringLikeExpression(expression.left) ||
      isStringLikeExpression(expression.right)
    );
  }

  if (
    expression.type === 'CallExpression' &&
    expression.callee.type === 'MemberExpression' &&
    getMemberPropertyName(expression.callee) === 'concat'
  ) {
    return isStringLikeExpression(expression.callee.object);
  }

  return false;
};

const templateLiteralToConcat = (code: string, node: Expression): string => {
  if (node.type !== 'TemplateLiteral' || node.expressions.length === 0) {
    return code.slice(node.start, node.end);
  }

  const parts: string[] = [];
  node.quasis.forEach((quasi, index) => {
    const cooked = quasi.value.cooked ?? quasi.value.raw;
    if (cooked !== '') {
      parts.push(JSON.stringify(cooked));
    }

    const expression = node.expressions[index];
    if (expression) {
      parts.push(code.slice(expression.start, expression.end));
    }
  });

  return parts.length > 0 ? parts.join(' + ') : '""';
};

export const dynamicImportArgumentCode = (
  code: string,
  node: Expression
): string => {
  if (node.type === 'TemplateLiteral') {
    return templateLiteralToConcat(code, node);
  }

  return code.slice(node.start, node.end);
};
