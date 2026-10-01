/* eslint-disable no-restricted-syntax,no-continue */
import type { Expression, Node } from 'oxc-parser';
import { unwrapOxcRuntimeExpression } from '../oxc/runtimeSemantics';
import { findResolvedReferences as getReferences } from './bindingResolution';
import {
  collectMutationReferenceKeys,
  containsUnprovenAliasSource,
  createDeferredReferencePolicyCollector,
} from './mutationExecution';
import { toMutationBindingKey } from './mutationBindingIdentity';
import type { Binding, BindingIndex } from './types';

export const collectPatternDefaultExpressions = (
  pattern: Node,
  expressions: Expression[] = []
): Expression[] => {
  if (pattern.type === 'AssignmentPattern') {
    expressions.push(pattern.right);
    return collectPatternDefaultExpressions(pattern.left, expressions);
  }

  if (pattern.type === 'RestElement') {
    return collectPatternDefaultExpressions(pattern.argument, expressions);
  }

  if (pattern.type === 'ObjectPattern') {
    pattern.properties.forEach((property) => {
      collectPatternDefaultExpressions(
        property.type === 'RestElement' ? property.argument : property.value,
        expressions
      );
    });
    return expressions;
  }

  if (pattern.type === 'ArrayPattern') {
    pattern.elements.forEach((element) => {
      if (element) {
        collectPatternDefaultExpressions(element, expressions);
      }
    });
  }

  return expressions;
};

export const collectRestContainerBindingNames = (
  pattern: Node,
  names: string[] = []
): string[] => {
  if (pattern.type === 'RestElement') {
    if (pattern.argument.type === 'Identifier') {
      names.push(pattern.argument.name);
    } else {
      collectRestContainerBindingNames(pattern.argument, names);
    }
    return names;
  }

  if (pattern.type === 'AssignmentPattern') {
    return collectRestContainerBindingNames(pattern.left, names);
  }

  if (pattern.type === 'ObjectPattern') {
    pattern.properties.forEach((property) => {
      collectRestContainerBindingNames(
        property.type === 'RestElement' ? property : property.value,
        names
      );
    });
    return names;
  }

  if (pattern.type === 'ArrayPattern') {
    pattern.elements.forEach((element) => {
      if (element) {
        collectRestContainerBindingNames(element, names);
      }
    });
  }

  return names;
};

export const createMutationReferencePolicy = (
  bindingIndex: BindingIndex,
  processorManagedExpressionNodes: ReadonlySet<Node>,
  ignoredHazardTreeNodes: ReadonlySet<Node>
) => {
  const ignoredHazardTreeReferenceStarts = new Set<number>();
  ignoredHazardTreeNodes.forEach((node) => {
    if (node.type === 'Identifier') {
      ignoredHazardTreeReferenceStarts.add(node.start);
    }
  });

  const toReferenceKey = (binding: Binding | null, name: string): string =>
    binding ? toMutationBindingKey(binding) : name;
  type ProcessorProjection = {
    referenceStarts: ReadonlySet<number>;
    roots: ReadonlySet<Node>;
  };
  const processorManagedRoots = [...processorManagedExpressionNodes].sort(
    (left, right) => left.start - right.start || left.end - right.end
  );
  const processorReferenceStarts = new WeakMap<Node, readonly number[]>();
  const processorProjectionCache = new WeakMap<
    Node,
    ProcessorProjection | null
  >();
  const findFirstProcessorRootAtOrAfter = (start: number): number => {
    let low = 0;
    let high = processorManagedRoots.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (processorManagedRoots[middle]!.start < start) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  };
  const getProcessorProjection = (node: Node): ProcessorProjection | null => {
    const cached = processorProjectionCache.get(node);
    if (cached !== undefined) {
      return cached;
    }

    const roots = new Set<Node>();
    const referenceStarts = new Set<number>();
    const first = findFirstProcessorRootAtOrAfter(node.start);
    for (let index = first; index < processorManagedRoots.length; index += 1) {
      const root = processorManagedRoots[index]!;
      if (root.start > node.end) {
        break;
      }
      if (root.end > node.end) {
        continue;
      }

      roots.add(root);
      let starts = processorReferenceStarts.get(root);
      if (!starts) {
        starts = getReferences(root, bindingIndex).map(
          (reference) => reference.start
        );
        processorReferenceStarts.set(root, starts);
      }
      starts.forEach((start) => referenceStarts.add(start));
    }

    const projection = roots.size === 0 ? null : { referenceStarts, roots };
    processorProjectionCache.set(node, projection);
    return projection;
  };
  const collectReferenceKeys = (node: Node): string[] => {
    const projection = getProcessorProjection(node);
    return collectMutationReferenceKeys(
      node,
      bindingIndex,
      [
        ignoredHazardTreeReferenceStarts,
        ...(projection ? [projection.referenceStarts] : []),
      ],
      toReferenceKey
    );
  };

  const collectDeferredReferencePolicy =
    createDeferredReferencePolicyCollector(bindingIndex);
  const collectEagerReferences = (node: Node) => {
    const { ignoredStarts } = collectDeferredReferencePolicy(node);
    const projection = getProcessorProjection(node);
    const excludedStarts = [
      ignoredHazardTreeReferenceStarts,
      ignoredStarts,
      ...(projection ? [projection.referenceStarts] : []),
    ];
    return getReferences(node, bindingIndex).filter((reference) =>
      excludedStarts.every((starts) => !starts.has(reference.start))
    );
  };
  const collectEagerReferenceKeys = (node: Node): string[] => [
    ...new Set(
      collectEagerReferences(node).map(({ binding, name }) =>
        toReferenceKey(binding, name)
      )
    ),
  ];

  const collectAliasReferenceKeys = (
    node: Node,
    includeBinding: (binding: Binding | null) => boolean = () => true
  ): string[] => {
    const projection = getProcessorProjection(node);
    return collectMutationReferenceKeys(
      node,
      bindingIndex,
      [
        ignoredHazardTreeReferenceStarts,
        ...(projection ? [projection.referenceStarts] : []),
      ],
      toReferenceKey,
      includeBinding
    );
  };
  const collectCapturedAliasReferenceKeys = (node: Node): string[] =>
    collectAliasReferenceKeys(
      node,
      (binding) =>
        !binding ||
        binding.declaredAt < node.start ||
        node.end <= binding.declaredAt
    );
  const collectCapturedResultAliasReferenceKeys = (node: Node): string[] => {
    const expression = unwrapOxcRuntimeExpression(node, true);
    if (expression.type !== 'CallExpression') {
      return collectCapturedAliasReferenceKeys(node);
    }

    const sources = expression.arguments.flatMap((argument) =>
      collectCapturedAliasReferenceKeys(argument)
    );
    const callee = unwrapOxcRuntimeExpression(expression.callee, true);
    if (callee.type === 'MemberExpression') {
      sources.push(...collectCapturedAliasReferenceKeys(callee.object));
    }

    // An opaque call result may alias argument or receiver capabilities. Other
    // return provenance is represented by unprovenResult; including the callee
    // itself here connects separate calls through an earlier result and can
    // turn a guarded primitive argument hazard into an unconditional one.
    return [...new Set(sources)];
  };

  const containsUnprovenAlias = (node: Node): boolean => {
    const projection = getProcessorProjection(node);
    return containsUnprovenAliasSource(
      node,
      bindingIndex,
      ignoredHazardTreeNodes,
      ignoredHazardTreeReferenceStarts,
      projection ? [projection.roots] : [],
      projection ? [projection.referenceStarts] : []
    );
  };
  const containsEagerUnprovenAlias = (node: Node): boolean => {
    const { ignoredRoots, ignoredStarts } =
      collectDeferredReferencePolicy(node);
    const projection = getProcessorProjection(node);
    return containsUnprovenAliasSource(
      node,
      bindingIndex,
      ignoredHazardTreeNodes,
      ignoredHazardTreeReferenceStarts,
      [ignoredRoots, ...(projection ? [projection.roots] : [])],
      [ignoredStarts, ...(projection ? [projection.referenceStarts] : [])]
    );
  };

  return {
    toReferenceKey,
    collectReferenceKeys,
    collectEagerReferences,
    collectEagerReferenceKeys,
    collectCapturedAliasReferenceKeys,
    collectCapturedResultAliasReferenceKeys,
    containsUnprovenAlias,
    containsEagerUnprovenAlias,
  };
};
