/* eslint-disable no-restricted-syntax */

import type { Expression, MemberExpression, Node } from 'oxc-parser';

import {
  appendOxcAssignmentTargetLeaves,
  getOxcAssignmentTargetRootIdentifier,
  type OxcAssignmentTargetLeaf,
} from '../oxc/assignmentTargets';
import { getOxcNodeChildren } from '../oxc/ast';
import type { OxcEdit } from '../oxc/fileEdits';
import { collectOxcPatternBindingNames } from '../oxc/patterns';
import { getOxcSyntacticPropertyKey } from '../oxc/projections';
import {
  isBindingPosition,
  isInTypeContext,
  isObjectPropertyKey,
  isPropertyOnlyIdentifier,
  resolveBindingAt,
} from './scopeAnalysis';
import { evaluateStatic } from './staticEvaluator';
import { literalCode } from './staticValues';
import type {
  Binding,
  ExtractionContext,
  OxcStaticImportReference,
} from './types';

export const getConstantReplacement = (
  binding: Binding | undefined,
  ctx: ExtractionContext
): string | null => {
  const init = binding?.declarator?.init;
  if (!init || binding.declarator?.id.type !== 'Identifier') {
    return null;
  }

  if (init.type === 'Literal') {
    return literalCode(init.value);
  }

  if (
    init.type === 'ObjectExpression' &&
    binding?.isRoot &&
    binding.declarator?.id.type === 'Identifier'
  ) {
    const evaluated = evaluateStatic(binding.declarator.id, ctx);
    return literalCode(evaluated);
  }

  return null;
};

type ReplacementScope = {
  activeFrom: number;
  bindings: Set<string>;
  functionScope: ReplacementScope;
  parent: ReplacementScope | null;
};

const createReplacementScope = (
  parent: ReplacementScope | null,
  functionBoundary = false,
  activeFrom = Number.NEGATIVE_INFINITY
): ReplacementScope => {
  const scope = {
    activeFrom,
    bindings: new Set<string>(),
    functionScope: null as unknown as ReplacementScope,
    parent,
  };
  scope.functionScope =
    functionBoundary || !parent ? scope : parent.functionScope;
  return scope;
};

type OxcIdentifier = Extract<Node, { type: 'Identifier' }>;

const appendMutationTargetRoots = (
  node: Node,
  roots: OxcIdentifier[]
): void => {
  const targets: OxcAssignmentTargetLeaf[] = [];
  appendOxcAssignmentTargetLeaves(node, targets);
  for (let i = 0; i < targets.length; i += 1) {
    const root = getOxcAssignmentTargetRootIdentifier(targets[i]!);
    if (root) {
      roots.push(root);
    }
  }
};

const isDeferredMutationBoundary = (node: Node): boolean =>
  node.type === 'FunctionDeclaration' ||
  node.type === 'FunctionExpression' ||
  node.type === 'ArrowFunctionExpression' ||
  node.type === 'ClassDeclaration' ||
  node.type === 'ClassExpression';

const immediateFunctionCallee = (node: Node): Node | null => {
  let current = node;
  while (
    current.type === 'ParenthesizedExpression' ||
    current.type === 'ChainExpression' ||
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSTypeAssertion' ||
    current.type === 'TSNonNullExpression' ||
    current.type === 'TSInstantiationExpression'
  ) {
    current = current.expression;
  }

  if (current.type === 'SequenceExpression') {
    current = current.expressions[current.expressions.length - 1] ?? current;
  }

  if (current.type === 'FunctionExpression') {
    return current.async || current.generator ? null : current;
  }

  if (current.type === 'ArrowFunctionExpression') {
    return current.async ? null : current;
  }

  return null;
};

const walkExpressionByExecution = (
  expression: Expression,
  includeDeferred: boolean,
  visit: (node: Node) => void
): void => {
  const eagerlyInvokedFunctions = new WeakSet<Node>();

  const walk = (node: Node): void => {
    if (
      !includeDeferred &&
      isDeferredMutationBoundary(node) &&
      !eagerlyInvokedFunctions.has(node)
    ) {
      return;
    }

    if (!includeDeferred && node.type === 'CallExpression') {
      const immediateFunction = immediateFunctionCallee(node.callee);
      if (immediateFunction) {
        eagerlyInvokedFunctions.add(immediateFunction);
      }
    }

    visit(node);
    getOxcNodeChildren(node).forEach(walk);
  };

  walk(expression);
};

const collectIdentifierMutationTargetsImpl = (
  expression: Expression,
  includeDeferred: boolean
): OxcIdentifier[] => {
  const targets: OxcIdentifier[] = [];
  walkExpressionByExecution(expression, includeDeferred, (node) => {
    if (node.type === 'AssignmentExpression') {
      appendMutationTargetRoots(node.left, targets);
    } else if (node.type === 'UpdateExpression') {
      appendMutationTargetRoots(node.argument, targets);
    } else if (node.type === 'UnaryExpression' && node.operator === 'delete') {
      appendMutationTargetRoots(node.argument, targets);
    } else if (
      (node.type === 'ForInStatement' || node.type === 'ForOfStatement') &&
      node.left.type !== 'VariableDeclaration'
    ) {
      appendMutationTargetRoots(node.left, targets);
    }
  });
  return targets;
};

export const collectIdentifierMutationTargets = (
  expression: Expression
): OxcIdentifier[] => collectIdentifierMutationTargetsImpl(expression, true);

export const collectEagerIdentifierMutationTargets = (
  expression: Expression
): OxcIdentifier[] => collectIdentifierMutationTargetsImpl(expression, false);

export const collectEagerNodeStarts = (
  expression: Expression
): ReadonlySet<number> => {
  const starts = new Set<number>();
  walkExpressionByExecution(expression, false, (node) => {
    starts.add(node.start);
  });
  return starts;
};

const createNestedReplacementScope = (
  node: Node,
  scope: ReplacementScope,
  parent: Node | null
): ReplacementScope => {
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    if (node.type === 'FunctionDeclaration' && node.id) {
      scope.bindings.add(node.id.name);
    }

    const functionScope = createReplacementScope(scope, true);
    if (node.type === 'FunctionExpression' && node.id) {
      functionScope.bindings.add(node.id.name);
    }
    node.params.forEach((param) =>
      collectOxcPatternBindingNames(param).forEach((name) =>
        functionScope.bindings.add(name)
      )
    );
    return functionScope;
  }

  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    if (node.type === 'ClassDeclaration' && node.id) {
      scope.bindings.add(node.id.name);
    }

    const classScope = createReplacementScope(scope);
    if (node.id) {
      classScope.bindings.add(node.id.name);
    }
    return classScope;
  }

  if (node.type === 'CatchClause') {
    const catchScope = createReplacementScope(scope);
    if (node.param) {
      collectOxcPatternBindingNames(node.param).forEach((name) =>
        catchScope.bindings.add(name)
      );
    }
    return catchScope;
  }

  if (node.type === 'StaticBlock') {
    return createReplacementScope(scope, true);
  }

  if (
    node.type === 'BlockStatement' &&
    !!parent &&
    (parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ArrowFunctionExpression') &&
    parent.body === node
  ) {
    // Parameter defaults run before the function body var environment exists.
    // Keep body `var` bindings out of the parameter scope while still making
    // them visible throughout the body.
    return createReplacementScope(scope, true);
  }

  if (
    node.type === 'BlockStatement' ||
    node.type === 'ForStatement' ||
    node.type === 'ForInStatement' ||
    node.type === 'ForOfStatement'
  ) {
    return createReplacementScope(scope);
  }

  if (node.type === 'SwitchStatement') {
    return createReplacementScope(
      scope,
      false,
      node.cases[0]?.start ?? node.end
    );
  }

  return scope;
};

const collectReplacementScopes = (
  node: Node,
  scope: ReplacementScope,
  scopes: WeakMap<Node, ReplacementScope>,
  parent: Node | null = null
): void => {
  const currentScope = createNestedReplacementScope(node, scope, parent);
  scopes.set(node, currentScope);

  if (node.type === 'VariableDeclaration') {
    const declarationScope =
      node.kind === 'var' ? currentScope.functionScope : currentScope;
    node.declarations.forEach((declarator) =>
      collectOxcPatternBindingNames(declarator.id).forEach((name) =>
        declarationScope.bindings.add(name)
      )
    );
  }

  getOxcNodeChildren(node).forEach((child) =>
    collectReplacementScopes(child, currentScope, scopes, node)
  );
};

const hasReplacementShadow = (
  scope: ReplacementScope,
  name: string,
  referenceStart: number
): boolean => {
  let current: ReplacementScope | null = scope;
  while (current) {
    if (referenceStart >= current.activeFrom && current.bindings.has(name)) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

const isNonReferenceIdentifier = (node: Node, parent: Node | null): boolean =>
  !!parent &&
  ((parent.type === 'LabeledStatement' && parent.label === node) ||
    (parent.type === 'BreakStatement' && parent.label === node) ||
    (parent.type === 'ContinueStatement' && parent.label === node) ||
    parent.type === 'MetaProperty');

export const collectIdentifierReferenceReplacements = (
  expression: Expression,
  replacements: ReadonlyMap<string, string>,
  exactReplacements?: ReadonlyMap<number, string>
): OxcEdit[] => {
  const localReplacements: OxcEdit[] = [];
  const ancestors: Node[] = [];
  const rootScope = createReplacementScope(null, true);
  const scopes = new WeakMap<Node, ReplacementScope>();
  collectReplacementScopes(expression, rootScope, scopes);

  const walk = (current: Node, parent: Node | null) => {
    const exactReplacement = exactReplacements?.get(current.start);
    if (
      current.type === 'Identifier' &&
      (exactReplacement !== undefined || replacements.has(current.name)) &&
      !hasReplacementShadow(
        scopes.get(current) ?? rootScope,
        current.name,
        current.start
      ) &&
      !isInTypeContext(ancestors) &&
      !isBindingPosition(current, parent) &&
      !isPropertyOnlyIdentifier(current, parent) &&
      !isObjectPropertyKey(current, parent) &&
      !isNonReferenceIdentifier(current, parent)
    ) {
      const replacement = exactReplacement ?? replacements.get(current.name)!;
      // Shorthand property `{ width }` → `{ width: 500 }` when the
      // identifier is the value side of a shorthand ObjectProperty.
      const isShorthandValue =
        !!parent &&
        parent.type === 'Property' &&
        (parent as unknown as { shorthand?: boolean }).shorthand &&
        parent.value === current;
      localReplacements.push({
        start: isShorthandValue ? parent.start : current.start,
        end: current.end,
        value: isShorthandValue
          ? `${current.name}: ${replacement}`
          : replacement,
      });
    }

    ancestors.push(current);
    getOxcNodeChildren(current).forEach((child) => walk(child, current));
    ancestors.pop();
  };

  walk(expression, null);
  return localReplacements;
};

export const applyExpressionReplacements = (
  expression: Pick<Node, 'end' | 'start'>,
  replacements: OxcEdit[],
  code: string
): string => {
  let result = code.slice(expression.start, expression.end);
  replacements
    .sort((a, b) => b.start - a.start)
    .forEach((replacement) => {
      const start = replacement.start - expression.start;
      const end = replacement.end - expression.start;
      result = result.slice(0, start) + replacement.value + result.slice(end);
    });
  return result;
};

export const replaceIdentifierReferences = (
  expression: Expression,
  replacements: ReadonlyMap<string, string>,
  code: string,
  exactReplacements?: ReadonlyMap<number, string>
): string => {
  return applyExpressionReplacements(
    expression,
    collectIdentifierReferenceReplacements(
      expression,
      replacements,
      exactReplacements
    ),
    code
  );
};

const staticImportAliasPart = (value: string): string =>
  value.replace(/[^A-Za-z0-9_$]/g, '_') || 'value';

const allocateStaticImportAlias = (
  binding: Binding,
  imported: string,
  ctx: ExtractionContext
): string => {
  const key = `${binding.importedFrom ?? ''}\0${binding.name}\0${imported}`;
  const existing = ctx.staticImportAliases.get(key);
  if (existing) {
    return existing;
  }

  const namespacePart = staticImportAliasPart(binding.name);
  const importedPart = staticImportAliasPart(imported);
  let alias = `_wyw_static_${namespacePart}_${importedPart}`;
  let idx = 1;
  while (ctx.usedNames.has(alias)) {
    idx += 1;
    alias = `_wyw_static_${namespacePart}_${importedPart}_${idx}`;
  }

  ctx.usedNames.add(alias);
  ctx.staticImportAliases.set(key, alias);
  return alias;
};

const staticMemberPropertyName = (
  expression: MemberExpression
): string | null => {
  const key = getOxcSyntacticPropertyKey(
    expression.property,
    expression.computed
  );
  return typeof key === 'string' ? key : null;
};

export const collectStaticNamespaceMemberReferences = (
  expression: Expression,
  ctx: ExtractionContext
): {
  coveredReferenceStarts: Set<number>;
  imports: OxcStaticImportReference[];
  replacements: OxcEdit[];
} => {
  const coveredReferenceStarts = new Set<number>();
  const imports = new Map<string, OxcStaticImportReference>();
  const replacements: OxcEdit[] = [];

  const walk = (node: Node): void => {
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier') {
      const binding = resolveBindingAt(
        ctx,
        node.object.name,
        node.object.start
      );
      const imported = staticMemberPropertyName(node);
      if (
        binding?.importedFrom &&
        binding.imported === '*' &&
        imported !== null
      ) {
        const alias = allocateStaticImportAlias(binding, imported, ctx);
        imports.set(`${binding.importedFrom}\0${imported}\0${alias}`, {
          imported,
          importLocal: binding.name,
          local: alias,
          source: binding.importedFrom,
        });
        replacements.push({
          end: node.end,
          start: node.start,
          value: alias,
        });
        coveredReferenceStarts.add(node.object.start);
      }
    }

    getOxcNodeChildren(node).forEach(walk);
  };

  walk(expression);

  return {
    coveredReferenceStarts,
    imports: [...imports.values()],
    replacements,
  };
};
