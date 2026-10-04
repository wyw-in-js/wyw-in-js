import type { Node } from 'oxc-parser';
import { getOxcNodeChildren } from '../oxc/ast';
import type { SpanLookup } from './types';

const toSpanKey = (start: number, end: number): string => `${start}:${end}`;

const markIgnoredMutationHazardTree = (
  node: Node,
  ignoredHazardNodes: Set<Node>
): void => {
  ignoredHazardNodes.add(node);
  getOxcNodeChildren(node).forEach((child) =>
    markIgnoredMutationHazardTree(child, ignoredHazardNodes)
  );
};

export const registerMutationHazardNode = (
  node: Node,
  ignoreLookup: SpanLookup,
  ignoreTreeLookup: SpanLookup,
  processorManagedExpressionNodes: Set<Node>,
  ignoredHazardNodes: Set<Node>,
  ignoredHazardTreeNodes: Set<Node>
): void => {
  if (ignoreTreeLookup?.has(toSpanKey(node.start, node.end))) {
    markIgnoredMutationHazardTree(node, ignoredHazardNodes);
    markIgnoredMutationHazardTree(node, ignoredHazardTreeNodes);
    return;
  }

  if (!ignoreLookup?.has(toSpanKey(node.start, node.end))) {
    return;
  }

  processorManagedExpressionNodes.add(node);
  ignoredHazardNodes.add(node);
  if (node.type === 'TaggedTemplateExpression') {
    // Suppress the processor tag construction/invocation itself. Quasi
    // interpolations remain visible so nested calls and mutations still
    // participate in provenance analysis.
    markIgnoredMutationHazardTree(node.tag, ignoredHazardNodes);
  }
};

const isMutationHazardSeed = (node: Node): boolean =>
  node.type === 'AssignmentExpression' ||
  node.type === 'UpdateExpression' ||
  (node.type === 'UnaryExpression' && node.operator === 'delete') ||
  node.type === 'CallExpression' ||
  node.type === 'NewExpression' ||
  node.type === 'TaggedTemplateExpression';

export const isEffectiveMutationHazardSeed = (
  node: Node,
  ignoredHazardNodes: ReadonlySet<Node>
): boolean => isMutationHazardSeed(node) && !ignoredHazardNodes.has(node);
