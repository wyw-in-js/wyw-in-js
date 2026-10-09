/* eslint-disable no-restricted-syntax,no-continue */

import type { Node, Program } from 'oxc-parser';

import { getOxcNodeChildren, isOxcNode } from '../oxc/ast';
import type { OxcEdit } from '../oxc/fileEdits';
import {
  collectDeclaredNames,
  collectImportLocalNames,
  collectTopLevelBindings,
  getImportSpecifierLocalName,
  isNodeReference,
} from './cleanupBindings';
import { GENERATED_HELPER_NAME_RE } from './shared';
import type {
  AnyNode,
  ScopedBindingInfo,
  ScopedBindingKind,
  ScopedCleanupScope,
  TopLevelStatementInfo,
} from './types';

export const createScopedCleanupScope = (
  parent: ScopedCleanupScope | null
): ScopedCleanupScope => ({
  bindings: new Map(),
  parent,
});

export const resolveScopedBinding = (
  scope: ScopedCleanupScope,
  name: string
): string | null => {
  let current: ScopedCleanupScope | null = scope;
  while (current) {
    const bindingId = current.bindings.get(name);
    if (bindingId) {
      return bindingId;
    }

    current = current.parent;
  }

  return null;
};

export const collectScopedBindingInfos = (
  program: Program
): Map<string, ScopedBindingInfo> => {
  const bindings = new Map<string, ScopedBindingInfo>();
  let sequence = 0;

  const addBinding = (
    scope: ScopedCleanupScope,
    name: string,
    kind: ScopedBindingKind,
    declaration: Node
  ): string => {
    const existingId = scope.bindings.get(name);
    if (existingId) {
      return existingId;
    }

    const id = `${kind}:${name}:${declaration.start}:${sequence}`;
    sequence += 1;

    bindings.set(id, {
      declaration,
      dependencies: new Set(),
      externalReferences: 0,
      id,
      incomingFromBindings: new Set(),
      kind,
      name,
    });
    scope.bindings.set(name, id);
    return id;
  };

  const addPatternBindings = (
    scope: ScopedCleanupScope,
    pattern: Node,
    kind: ScopedBindingKind,
    declaration: Node
  ): void => {
    collectDeclaredNames(pattern).forEach((name) => {
      addBinding(scope, name, kind, declaration);
    });
  };

  const predeclareScopedBindings = (
    scope: ScopedCleanupScope,
    node: Node
  ): void => {
    if (node.type === 'ImportDeclaration') {
      const { specifiers } = node as AnyNode;
      if (Array.isArray(specifiers)) {
        specifiers.forEach((specifier) => {
          const { local } = specifier as AnyNode;
          if (
            isOxcNode(local) &&
            local.type === 'Identifier' &&
            typeof local.name === 'string'
          ) {
            addBinding(scope, local.name, 'import', node);
          }
        });
      }
      return;
    }

    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      predeclareScopedBindings(scope, node.declaration);
      return;
    }

    if (node.type === 'ExportDefaultDeclaration') {
      const { declaration } = node as AnyNode;
      if (
        isOxcNode(declaration) &&
        (declaration.type === 'FunctionDeclaration' ||
          declaration.type === 'ClassDeclaration') &&
        declaration.id
      ) {
        addBinding(
          scope,
          declaration.id.name,
          declaration.type === 'FunctionDeclaration' ? 'function' : 'variable',
          declaration
        );
      }
      return;
    }

    if (node.type === 'VariableDeclaration') {
      const { declarations } = node as AnyNode;
      if (!Array.isArray(declarations)) {
        return;
      }

      declarations.forEach((declarator) => {
        const { id } = declarator as AnyNode;
        if (isOxcNode(id)) {
          addPatternBindings(scope, id, 'variable', node);
        }
      });
      return;
    }

    if (node.type === 'FunctionDeclaration' && node.id) {
      addBinding(scope, node.id.name, 'function', node);
      return;
    }

    if (
      (node.type === 'ClassDeclaration' || node.type === 'TSEnumDeclaration') &&
      'id' in node
    ) {
      const { id } = node as AnyNode;
      if (isOxcNode(id) && id.type === 'Identifier') {
        addBinding(scope, id.name, 'variable', node);
      }
    }
  };

  const predeclareScopedStatementBindings = (
    scope: ScopedCleanupScope,
    statements: Node[]
  ): void => {
    statements.forEach((statement) => {
      predeclareScopedBindings(scope, statement);
    });
  };

  const recordReference = (
    scope: ScopedCleanupScope,
    name: string,
    ownerBindingId: string | null
  ): void => {
    const targetId = resolveScopedBinding(scope, name);
    if (!targetId) {
      return;
    }

    const target = bindings.get(targetId);
    if (!target) {
      return;
    }

    if (ownerBindingId && ownerBindingId !== targetId) {
      target.incomingFromBindings.add(ownerBindingId);
      bindings.get(ownerBindingId)?.dependencies.add(targetId);
      return;
    }

    target.externalReferences += 1;
  };

  type ScopedWalk = (
    node: Node,
    scope: ScopedCleanupScope,
    parent?: Node | null,
    ownerBindingId?: string | null
  ) => void;

  let walk: ScopedWalk;

  function walkPatternReferenceSubexpressions(
    node: Node,
    scope: ScopedCleanupScope,
    ownerBindingId: string | null
  ): void {
    if (node.type === 'Identifier') {
      return;
    }

    if (node.type === 'TSParameterProperty') {
      walkPatternReferenceSubexpressions(node.parameter, scope, ownerBindingId);
      return;
    }

    if (node.type === 'RestElement') {
      walkPatternReferenceSubexpressions(node.argument, scope, ownerBindingId);
      return;
    }

    if (node.type === 'AssignmentPattern') {
      walkPatternReferenceSubexpressions(node.left, scope, ownerBindingId);
      walk(node.right, scope, node, ownerBindingId);
      return;
    }

    if (node.type === 'ObjectPattern') {
      node.properties.forEach((property) => {
        if (property.type === 'RestElement') {
          walkPatternReferenceSubexpressions(
            property.argument,
            scope,
            ownerBindingId
          );
          return;
        }

        if (property.computed && isOxcNode(property.key)) {
          walk(property.key, scope, property, ownerBindingId);
        }

        walkPatternReferenceSubexpressions(
          property.value,
          scope,
          ownerBindingId
        );
      });
      return;
    }

    if (node.type === 'ArrayPattern') {
      node.elements.forEach((element) => {
        if (element && isOxcNode(element)) {
          walkPatternReferenceSubexpressions(element, scope, ownerBindingId);
        }
      });
    }
  }

  walk = (
    node: Node,
    scope: ScopedCleanupScope,
    parent: Node | null = null,
    ownerBindingId: string | null = null
  ): void => {
    if (node.type === 'Program') {
      predeclareScopedStatementBindings(scope, node.body);
      node.body.forEach((child) => walk(child, scope, node, ownerBindingId));
      return;
    }

    if (node.type === 'ImportDeclaration') {
      const { specifiers } = node as AnyNode;
      if (Array.isArray(specifiers)) {
        specifiers.forEach((specifier) => {
          const { local } = specifier as AnyNode;
          if (
            isOxcNode(local) &&
            local.type === 'Identifier' &&
            typeof local.name === 'string'
          ) {
            addBinding(scope, local.name, 'import', node);
          }
        });
      }
      return;
    }

    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      walk(node.declaration, scope, node, ownerBindingId);
      collectTopLevelBindings(node).forEach((name) => {
        recordReference(scope, name, ownerBindingId);
      });
      return;
    }

    if (node.type === 'ExportDefaultDeclaration') {
      const { declaration } = node as AnyNode;
      if (isOxcNode(declaration)) {
        walk(declaration, scope, node, ownerBindingId);
        if (
          (declaration.type === 'FunctionDeclaration' ||
            declaration.type === 'ClassDeclaration') &&
          declaration.id
        ) {
          recordReference(scope, declaration.id.name, ownerBindingId);
        }
      }
      return;
    }

    if (node.type === 'VariableDeclaration') {
      const { declarations } = node as AnyNode;
      if (!Array.isArray(declarations)) {
        return;
      }

      declarations.forEach((declarator) => {
        const { id } = declarator as AnyNode;
        if (isOxcNode(id)) {
          addPatternBindings(scope, id, 'variable', node);
        }
      });

      declarations.forEach((declarator) => {
        const { id } = declarator as AnyNode;
        const { init } = declarator as AnyNode;
        if (!isOxcNode(id) || !isOxcNode(init)) {
          return;
        }

        const ownerName = collectDeclaredNames(id)[0] ?? null;
        const nextOwner =
          ownerName !== null ? resolveScopedBinding(scope, ownerName) : null;
        walk(init, scope, declarator as Node, nextOwner);
      });
      return;
    }

    if (node.type === 'FunctionDeclaration' && node.id) {
      const functionBindingId = addBinding(
        scope,
        node.id.name,
        'function',
        node
      );
      const fnScope = createScopedCleanupScope(scope);

      node.params.forEach((param) => {
        addPatternBindings(fnScope, param, 'param', param);
        walkPatternReferenceSubexpressions(param, fnScope, functionBindingId);
      });

      if (node.body) {
        walk(node.body, fnScope, node, functionBindingId);
      }
      return;
    }

    if (
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      const fnScope = createScopedCleanupScope(scope);
      if (node.type === 'FunctionExpression' && node.id) {
        addBinding(fnScope, node.id.name, 'function', node);
      }

      node.params.forEach((param) => {
        addPatternBindings(fnScope, param, 'param', param);
        walkPatternReferenceSubexpressions(param, fnScope, ownerBindingId);
      });

      if (node.body) {
        walk(node.body, fnScope, node, ownerBindingId);
      }
      return;
    }

    if (node.type === 'BlockStatement') {
      const blockScope = createScopedCleanupScope(scope);
      predeclareScopedStatementBindings(blockScope, node.body);
      getOxcNodeChildren(node).forEach((child) =>
        walk(child, blockScope, node, ownerBindingId)
      );
      return;
    }

    if (
      isNodeReference(node, parent) &&
      'name' in node &&
      typeof node.name === 'string'
    ) {
      recordReference(scope, node.name, ownerBindingId);
    }

    getOxcNodeChildren(node).forEach((child) =>
      walk(child, scope, node, ownerBindingId)
    );
  };

  walk(program, createScopedCleanupScope(null));
  return bindings;
};

export const collectScopedRemovableBindingIds = (
  bindings: Map<string, ScopedBindingInfo>,
  initialNames: Set<string>
): Set<string> => {
  const removable = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;

    for (const binding of bindings.values()) {
      if (
        !removable.has(binding.id) &&
        binding.kind !== 'import' &&
        binding.kind !== 'param' &&
        binding.externalReferences === 0
      ) {
        const seededByName =
          initialNames.has(binding.name) ||
          (GENERATED_HELPER_NAME_RE.test(binding.name) &&
            binding.incomingFromBindings.size === 0);
        const allIncomingRemovable =
          binding.incomingFromBindings.size > 0 &&
          [...binding.incomingFromBindings].every((sourceId) =>
            removable.has(sourceId)
          );

        if (
          (seededByName && binding.incomingFromBindings.size === 0) ||
          allIncomingRemovable
        ) {
          removable.add(binding.id);
          changed = true;
        }
      }
    }
  }

  return removable;
};

export function expandImportRemovalRange(
  code: string,
  start: number,
  end: number
): OxcEdit {
  let removalStart = start;
  while (
    removalStart > 0 &&
    (code[removalStart - 1] === ' ' || code[removalStart - 1] === '\t')
  ) {
    removalStart -= 1;
  }

  let removalEnd = end;
  if (code[removalEnd] === ';') {
    removalEnd += 1;
  }

  while (
    removalEnd < code.length &&
    (code[removalEnd] === ' ' || code[removalEnd] === '\t')
  ) {
    removalEnd += 1;
  }

  if (code[removalEnd] === '\r' && code[removalEnd + 1] === '\n') {
    removalEnd += 2;
  } else if (code[removalEnd] === '\n') {
    removalEnd += 1;
  }

  return {
    end: removalEnd,
    start: removalStart,
    value: '',
  };
}

export const collectUnusedScopedDeclarationRemovals = (
  code: string,
  bindings: Map<string, ScopedBindingInfo>,
  initialRemovableNames: Set<string>
): OxcEdit[] => {
  const removableBindingIds = collectScopedRemovableBindingIds(
    bindings,
    initialRemovableNames
  );
  const removals = new Map<string, OxcEdit>();

  bindings.forEach((binding) => {
    if (
      !removableBindingIds.has(binding.id) ||
      binding.kind === 'import' ||
      binding.kind === 'param' ||
      binding.externalReferences > 0 ||
      [...binding.incomingFromBindings].some(
        (sourceId) => !removableBindingIds.has(sourceId)
      )
    ) {
      return;
    }

    if (
      binding.kind === 'function' &&
      binding.declaration.type === 'FunctionDeclaration'
    ) {
      const range = expandImportRemovalRange(
        code,
        binding.declaration.start,
        binding.declaration.end
      );
      removals.set(`${range.start}:${range.end}`, range);
      return;
    }

    if (binding.declaration.type !== 'VariableDeclaration') {
      return;
    }

    const { declarations } = binding.declaration as AnyNode;
    if (!Array.isArray(declarations) || declarations.length !== 1) {
      return;
    }

    const range = expandImportRemovalRange(
      code,
      binding.declaration.start,
      binding.declaration.end
    );
    removals.set(`${range.start}:${range.end}`, range);
  });

  return [...removals.values()];
};

export const expandImportSpecifierRemovalRange = (
  code: string,
  start: number,
  end: number
): OxcEdit => {
  let removalStart = start;
  let removalEnd = end;

  let whitespaceStart = removalStart;
  while (
    whitespaceStart > 0 &&
    (code[whitespaceStart - 1] === ' ' || code[whitespaceStart - 1] === '\t')
  ) {
    whitespaceStart -= 1;
  }
  if (code[whitespaceStart - 1] !== '{') {
    removalStart = whitespaceStart;
  }

  while (
    removalEnd < code.length &&
    (code[removalEnd] === ' ' || code[removalEnd] === '\t')
  ) {
    removalEnd += 1;
  }

  if (code[removalEnd] === ',') {
    removalEnd += 1;
    while (
      removalEnd < code.length &&
      (code[removalEnd] === ' ' || code[removalEnd] === '\t')
    ) {
      removalEnd += 1;
    }
  } else {
    while (
      removalStart > 0 &&
      (code[removalStart - 1] === ' ' || code[removalStart - 1] === '\t')
    ) {
      removalStart -= 1;
    }

    if (code[removalStart - 1] === ',') {
      removalStart -= 1;
      while (
        removalStart > 0 &&
        (code[removalStart - 1] === ' ' || code[removalStart - 1] === '\t')
      ) {
        removalStart -= 1;
      }
    }
  }

  return {
    end: removalEnd,
    start: removalStart,
    value: '',
  };
};

export const collectUnusedImportRemovals = (
  code: string,
  program: Program,
  referencedNames: Set<string>,
  removableNames: Set<string>,
  preserveSideEffectImportLocals: Set<string>,
  preserveSideEffectImportOrderLocals: Set<string> = preserveSideEffectImportLocals
): OxcEdit[] => {
  const removals: OxcEdit[] = [];
  const importSourceByLocal = new Map<string, string>();
  const removedSideEffectImportRanges: { end: number; start: number }[] = [];
  const keptImportRangesBySource = new Map<
    string,
    { end: number; start: number }
  >();

  program.body.forEach((statement) => {
    if (statement.type !== 'ImportDeclaration') {
      return;
    }

    const localNames = collectImportLocalNames(statement);
    const source = code.slice(statement.source.start, statement.source.end);
    const orderedLocalNames = localNames.filter((localName) =>
      preserveSideEffectImportOrderLocals.has(localName)
    );
    const sideEffectLocalNames = localNames.filter((localName) =>
      preserveSideEffectImportLocals.has(localName)
    );
    [...orderedLocalNames, ...sideEffectLocalNames].forEach((localName) => {
      importSourceByLocal.set(localName, source);
    });
    const removableLocalNames = localNames.filter((localName) =>
      removableNames.has(localName)
    );
    if (
      removableLocalNames.length > 0 &&
      removableLocalNames.length === localNames.length &&
      removableLocalNames.every((localName) => !referencedNames.has(localName))
    ) {
      if (
        removableLocalNames.some((localName) =>
          preserveSideEffectImportLocals.has(localName)
        )
      ) {
        removedSideEffectImportRanges.push({
          end: statement.end,
          start: statement.start,
        });
        return;
      }

      removals.push(
        expandImportRemovalRange(code, statement.start, statement.end)
      );
      return;
    }

    if (orderedLocalNames.length > 0 && !keptImportRangesBySource.has(source)) {
      keptImportRangesBySource.set(source, {
        end: statement.end,
        start: statement.start,
      });
    }

    const { specifiers } = statement as AnyNode;
    if (!Array.isArray(specifiers) || specifiers.length <= 1) {
      return;
    }

    specifiers.forEach((specifier) => {
      if (!isOxcNode(specifier)) {
        return;
      }

      const localName = getImportSpecifierLocalName(specifier);
      if (
        localName &&
        removableNames.has(localName) &&
        !referencedNames.has(localName)
      ) {
        removals.push(
          expandImportSpecifierRemovalRange(
            code,
            specifier.start,
            specifier.end
          )
        );
      }
    });
  });

  if (removedSideEffectImportRanges.length > 0) {
    const seenSources = new Set<string>();
    const removedRanges = removedSideEffectImportRanges.sort(
      (a, b) => a.start - b.start
    );
    const [firstRemoved, ...restRemoved] = removedRanges;
    const pendingImports: string[] = [];
    let insertionAfterLastKept: number | null = null;
    let usedFirstRemovedRange = false;
    const flushBefore = (position: number): void => {
      if (pendingImports.length === 0) {
        return;
      }

      removals.push({
        end: position,
        start: position,
        value: `${pendingImports.join('\n')}\n`,
      });
      pendingImports.length = 0;
    };

    [...preserveSideEffectImportOrderLocals].forEach((localName) => {
      const source = importSourceByLocal.get(localName);
      if (!source) {
        return;
      }

      const keptRange = keptImportRangesBySource.get(source);
      if (keptRange) {
        flushBefore(keptRange.start);
        insertionAfterLastKept = keptRange.end;
        if (preserveSideEffectImportLocals.has(localName)) {
          seenSources.add(source);
        }
        return;
      }

      if (
        !preserveSideEffectImportLocals.has(localName) ||
        seenSources.has(source)
      ) {
        return;
      }

      seenSources.add(source);
      pendingImports.push(`import ${source};`);
    });

    if (pendingImports.length > 0) {
      if (insertionAfterLastKept !== null) {
        removals.push({
          end: insertionAfterLastKept,
          start: insertionAfterLastKept,
          value: `\n${pendingImports.join('\n')}`,
        });
      } else if (firstRemoved) {
        usedFirstRemovedRange = true;
        removals.push({
          end: firstRemoved.end,
          start: firstRemoved.start,
          value: pendingImports.join('\n'),
        });
      }
    }

    removals.push(
      ...(usedFirstRemovedRange ? restRemoved : removedRanges).map((range) => ({
        ...range,
        value: '',
      }))
    );
  }

  return removals;
};

export const collectUnusedTopLevelDeclarationRemovals = (
  code: string,
  program: Program,
  referencedNames: Set<string>,
  removableNames: Set<string>
): OxcEdit[] => {
  const removals: OxcEdit[] = [];

  program.body.forEach((statement) => {
    if (statement.type !== 'VariableDeclaration') {
      return;
    }

    const localNames = [...collectTopLevelBindings(statement)];

    if (
      localNames.length > 0 &&
      localNames.every((localName) => removableNames.has(localName)) &&
      localNames.every((localName) => !referencedNames.has(localName))
    ) {
      removals.push(
        expandImportRemovalRange(code, statement.start, statement.end)
      );
    }
  });

  return removals;
};

export const collectUnusedGeneratedHelperDeclarationRemovals = (
  code: string,
  program: Program,
  referencedNames: Set<string>
): OxcEdit[] => {
  const removals: OxcEdit[] = [];

  program.body.forEach((statement) => {
    if (statement.type !== 'VariableDeclaration') {
      return;
    }

    const localNames = [...collectTopLevelBindings(statement)];
    if (
      localNames.length > 0 &&
      localNames.every((localName) =>
        GENERATED_HELPER_NAME_RE.test(localName)
      ) &&
      localNames.every((localName) => !referencedNames.has(localName))
    ) {
      removals.push(
        expandImportRemovalRange(code, statement.start, statement.end)
      );
    }
  });

  return removals;
};

export const collectTopLevelExpressionStatementRemovals = (
  code: string,
  statements: TopLevelStatementInfo[],
  topLevelBindings: Set<string>,
  removableExpressionRefs: Set<string>
): OxcEdit[] => {
  const removals: OxcEdit[] = [];

  statements.forEach((statement) => {
    if (statement.node.type !== 'ExpressionStatement') {
      return;
    }

    const { expression } = statement.node;
    const isPureExpression =
      expression.type === 'Identifier' ||
      expression.type === 'Literal' ||
      expression.type === 'ObjectExpression' ||
      expression.type === 'ArrayExpression' ||
      expression.type === 'ArrowFunctionExpression' ||
      expression.type === 'FunctionExpression' ||
      (expression.type === 'TemplateLiteral' &&
        expression.expressions.length === 0);
    if (!isPureExpression) {
      return;
    }

    const localReferences = [...statement.references].filter((name) =>
      topLevelBindings.has(name)
    );

    if (
      localReferences.length > 0 &&
      localReferences.every((name) => removableExpressionRefs.has(name))
    ) {
      removals.push(
        expandImportRemovalRange(code, statement.node.start, statement.node.end)
      );
    }
  });

  return removals;
};

export const collectEmptyTopLevelBlockRemovals = (
  code: string,
  program: Program
): OxcEdit[] => {
  const removals: OxcEdit[] = [];

  program.body.forEach((statement) => {
    if (statement.type !== 'BlockStatement' || statement.body.length > 0) {
      return;
    }

    removals.push(
      expandImportRemovalRange(code, statement.start, statement.end)
    );
  });

  return removals;
};
