import type { Node } from 'oxc-parser';

import type {
  DangerousCodeReplacement,
  Replacement,
} from './oxcPreevalTransforms';

type ControlStatementNode = Extract<
  Node,
  {
    type:
      | 'IfStatement'
      | 'ForStatement'
      | 'ForInStatement'
      | 'ForOfStatement'
      | 'WhileStatement'
      | 'DoWhileStatement'
      | 'LabeledStatement';
  }
>;

export type ControlStatement = {
  node: ControlStatementNode;
  parent: Node | null;
};

const removableOwnerTypes = new Set([
  'DoWhileStatement',
  'ExpressionStatement',
  'ForInStatement',
  'ForOfStatement',
  'ForStatement',
  'FunctionDeclaration',
  'IfStatement',
  'PropertyDefinition',
  'ReturnStatement',
  'VariableDeclaration',
  'WhileStatement',
]);

export const isControlStatement = (node: Node): node is ControlStatementNode =>
  node.type === 'IfStatement' ||
  node.type === 'ForStatement' ||
  node.type === 'ForInStatement' ||
  node.type === 'ForOfStatement' ||
  node.type === 'WhileStatement' ||
  node.type === 'DoWhileStatement' ||
  node.type === 'LabeledStatement';

const isSoleStatementBody = (owner: Node, parent: Node | null): boolean => {
  switch (parent?.type) {
    case 'IfStatement':
      return parent.consequent === owner || parent.alternate === owner;
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'LabeledStatement':
      return parent.body === owner;
    default:
      return false;
  }
};

export const removeOwner = (node: Node, ancestors: Node[]): Replacement => {
  let owner: Node = node;
  // The visited node is not on the stack yet; promise-callback owners are.
  let ownerAncestorIndex = ancestors.lastIndexOf(node);
  if (ownerAncestorIndex === -1) {
    ownerAncestorIndex = ancestors.length;
  }

  if (!removableOwnerTypes.has(node.type)) {
    for (let idx = ancestors.length - 1; idx >= 0; idx -= 1) {
      const ancestor = ancestors[idx];
      if (removableOwnerTypes.has(ancestor.type)) {
        owner = ancestor;
        ownerAncestorIndex = idx;
        break;
      }
    }
  }

  const parent =
    ownerAncestorIndex > 0 ? ancestors[ownerAncestorIndex - 1] : null;
  if (
    parent?.type === 'ExportNamedDeclaration' &&
    parent.declaration === owner
  ) {
    return { start: parent.start, end: parent.end, value: '' };
  }

  return {
    start: owner.start,
    end: owner.end,
    value: isSoleStatementBody(owner, parent) ? '{}' : '',
  };
};

type BodyState = { empty: boolean; removed: boolean };
const preservedBody: BodyState = { empty: false, removed: false };
const emptyBody: BodyState = { empty: true, removed: false };
const removedBody: BodyState = { empty: true, removed: true };

export const removeEmptyControlStatements = (
  replacements: DangerousCodeReplacement[],
  controlStatements: ControlStatement[]
): DangerousCodeReplacement[] => {
  const result = [...replacements];
  const byStart = new Map(
    result.map((replacement) => [replacement.start, replacement])
  );
  const blockStates = new WeakMap<Node, BodyState>();

  const getBodyState = (node: Node): BodyState => {
    const replacement = byStart.get(node.start);
    if (
      replacement?.end === node.end &&
      (replacement.value === '' || replacement.value === '{}')
    ) {
      return removedBody;
    }
    if (node.type === 'EmptyStatement') {
      return emptyBody;
    }
    if (node.type !== 'BlockStatement') {
      return preservedBody;
    }
    const cached = blockStates.get(node);
    if (cached) {
      return cached;
    }
    const statements = node.body.map(getBodyState);
    const state = {
      empty: statements.every((statement) => statement.empty),
      removed: statements.some((statement) => statement.removed),
    };
    blockStates.set(node, state);
    return state;
  };

  // The traversal records parents before children. Work backwards so a
  // removed inner control statement can empty its enclosing body too.
  for (let idx = controlStatements.length - 1; idx >= 0; idx -= 1) {
    const { node, parent } = controlStatements[idx];
    let bodies: Node[];
    if (node.type === 'IfStatement') {
      bodies = node.alternate
        ? [node.consequent, node.alternate]
        : [node.consequent];
    } else {
      bodies = [node.body];
    }
    const states = bodies.map(getBodyState);
    if (
      states.every((state) => state.empty) &&
      states.some((state) => state.removed)
    ) {
      // A removed loop body may have been responsible for termination. Do not
      // leave its header executable merely because it mutates a live binding.
      const replacement = {
        start: node.start,
        end: node.end,
        value: isSoleStatementBody(node, parent) ? '{}' : '',
      };
      result.push(replacement);
      byStart.set(node.start, replacement);
    }
  }

  return result;
};
