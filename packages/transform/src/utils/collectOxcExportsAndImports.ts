/* eslint-disable @typescript-eslint/no-use-before-define,no-restricted-syntax,no-continue */

import type {
  AssignmentExpression,
  BindingPattern,
  CallExpression,
  Class as OxcClass,
  ExportAllDeclaration,
  ExportDefaultDeclaration,
  ExportNamedDeclaration,
  ExportSpecifier,
  Expression,
  ExpressionStatement,
  Function as OxcFunction,
  ImportDeclaration,
  ImportExpression,
  MemberExpression,
  ModuleExportName,
  Node,
  ObjectExpression,
  ObjectPattern,
  Program,
  PropertyKey,
  VariableDeclarator,
} from 'oxc-parser';

import {
  cacheOxcCollection,
  cacheOxcProcessorImports,
  getCachedOxcCollection,
  getCachedOxcProcessorImports,
  type ImportKind,
  type OxcCollectedImport,
  type OxcCollectedReexport,
  type OxcCollectedState,
  type OxcLocal,
} from './collectOxcExportsAndImportsCache';
import { isOxcRuntimeReferenceIdentifier } from './oxc/lexicalScopes';
import {
  isTypeOnlyImport,
  isTypeOnlyImportSpecifier,
} from './oxc/typeOnlyImport';
import { parseOxcCached } from './parseOxc';

export type {
  OxcCollectedExport,
  OxcCollectedImport,
  OxcCollectedReexport,
  OxcCollectedState,
  OxcLocal,
} from './collectOxcExportsAndImportsCache';

type VisitMode = 'all' | 'importsOnly';

type NamespaceBinding = {
  kind: 'namespace';
  local: OxcLocal;
  name: string;
  source: string;
  type: ImportKind;
  used: boolean;
};

type LocalBinding = {
  kind: 'local';
  name: string;
};

type Binding = LocalBinding | NamespaceBinding;

type Scope = {
  bindings: Map<string, Binding>;
  parent: Scope | null;
};

type VisitContext = {
  parent: Node | null;
  scope: Scope;
};

type AnyNode = Node & Record<string, unknown>;

type OxcIdentifier = Node & { name: string; type: 'Identifier' };

type Destructed = {
  as: Node;
  what: string | '*';
};

type AnalyzerState = {
  // Ancestors of the node being visited, nearest last; shared with the
  // oxc/lexicalScopes predicates, which classify identifiers by their path.
  ancestors: Node[];
  code: string;
  namespaces: NamespaceBinding[];
  requireSources: Map<string, string>;
  result: OxcCollectedState;
};

const createScope = (parent: Scope | null): Scope => ({
  bindings: new Map(),
  parent,
});

const isNode = (value: unknown): value is Node =>
  !!value &&
  typeof value === 'object' &&
  'type' in value &&
  typeof (value as { type?: unknown }).type === 'string';

const localFromNode = (node: Node, code: string, name?: string): OxcLocal => ({
  code: code.slice(node.start, node.end),
  end: node.end,
  name: name ?? (node.type === 'Identifier' ? node.name : undefined),
  start: node.start,
});

const nameFromModuleExport = (node: ModuleExportName): string =>
  node.type === 'Literal' ? node.value : node.name;

const nameFromPropertyKey = (key: PropertyKey): string | null => {
  if (key.type === 'Identifier') {
    return key.name;
  }

  if (key.type === 'Literal' && typeof key.value === 'string') {
    return key.value;
  }

  return null;
};

const nameFromMemberProperty = (node: MemberExpression): string | null => {
  if (node.computed) {
    return node.property.type === 'Literal' &&
      typeof node.property.value === 'string'
      ? node.property.value
      : null;
  }

  return node.property.type === 'Identifier' ? node.property.name : null;
};

const defineBinding = (scope: Scope, binding: Binding): void => {
  scope.bindings.set(binding.name, binding);
};

const lookupBinding = (scope: Scope, name: string): Binding | null => {
  let current: Scope | null = scope;
  while (current) {
    const binding = current.bindings.get(name);
    if (binding) {
      return binding;
    }

    current = current.parent;
  }

  return null;
};

const collectBindingNames = (pattern: BindingPattern): string[] => {
  if (pattern.type === 'Identifier') {
    return [pattern.name];
  }

  if (pattern.type === 'AssignmentPattern') {
    return collectBindingNames(pattern.left);
  }

  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.flatMap((property) =>
      property.type === 'RestElement'
        ? collectBindingNames(property.argument)
        : collectBindingNames(property.value)
    );
  }

  if (pattern.type === 'ArrayPattern') {
    return pattern.elements.flatMap((element) =>
      element ? collectBindingLikeNames(element) : []
    );
  }

  return [];
};

const collectBindingLikeNames = (node: Node): string[] => {
  if (node.type === 'RestElement') {
    return collectBindingLikeNames(node.argument);
  }

  if (node.type === 'TSParameterProperty') {
    return collectBindingLikeNames(node.parameter);
  }

  return collectBindingNames(node as BindingPattern);
};

const declareLocalPattern = (scope: Scope, pattern: BindingPattern): void => {
  collectBindingNames(pattern).forEach((name) =>
    defineBinding(scope, { kind: 'local', name })
  );
};

const declareLocalBindingLike = (scope: Scope, node: Node): void => {
  collectBindingLikeNames(node).forEach((name) =>
    defineBinding(scope, { kind: 'local', name })
  );
};

const isTypeOnlyExport = (
  declaration:
    | ExportAllDeclaration
    | ExportDefaultDeclaration
    | ExportNamedDeclaration
    | ExportSpecifier
): boolean => 'exportKind' in declaration && declaration.exportKind === 'type';

const addImport = (
  state: AnalyzerState,
  item: Omit<OxcCollectedImport, 'local'> & { local: Node; name?: string }
): void => {
  state.result.imports.push({
    imported: item.imported,
    local: localFromNode(item.local, state.code, item.name),
    source: item.source,
    type: item.type,
  });
};

const addExport = (
  state: AnalyzerState,
  exported: string | 'default' | '*',
  local: Node,
  name?: string
): void => {
  const { result } = state;
  result.exports[exported] = localFromNode(local, state.code, name);
};

const addReexport = (
  state: AnalyzerState,
  item: Omit<OxcCollectedReexport, 'local'> & { local: Node }
): void => {
  state.result.reexports.push({
    exported: item.exported,
    imported: item.imported,
    local: localFromNode(item.local, state.code),
    source: item.source,
  });
};

const collectDestructed = (pattern: ObjectPattern): Destructed[] =>
  pattern.properties.flatMap((property) => {
    if (property.type === 'RestElement') {
      return collectBindingNames(property.argument).map(() => ({
        as: property.argument,
        what: '*' as const,
      }));
    }

    const firstKey = nameFromPropertyKey(property.key);
    if (!firstKey) {
      return [];
    }

    if (property.value.type === 'ObjectPattern') {
      return collectBindingNames(property.value).map(() => ({
        as: property.value,
        what: firstKey,
      }));
    }

    if (property.value.type === 'ArrayPattern') {
      return collectBindingNames(property.value).map(() => ({
        as: property.value,
        what: firstKey,
      }));
    }

    if (property.value.type === 'AssignmentPattern') {
      return collectBindingNames(property.value.left).map(() => ({
        as: property.value,
        what: firstKey,
      }));
    }

    return collectBindingNames(property.value).map(() => ({
      as: property.value,
      what: firstKey,
    }));
  });

const getStringConstant = (expression: Expression): string | null => {
  if (expression.type === 'Literal' && typeof expression.value === 'string') {
    return expression.value;
  }

  if (
    expression.type === 'TemplateLiteral' &&
    expression.expressions.length === 0
  ) {
    return expression.quasis[0]?.value.cooked ?? null;
  }

  if (expression.type === 'BinaryExpression' && expression.operator === '+') {
    const left = getStringConstant(expression.left);
    const right = getStringConstant(expression.right);
    return left === null || right === null ? null : left + right;
  }

  if (
    expression.type === 'CallExpression' &&
    expression.callee.type === 'MemberExpression' &&
    nameFromMemberProperty(expression.callee) === 'concat'
  ) {
    const base = getStringConstant(expression.callee.object);
    if (base === null) {
      return null;
    }

    const parts = expression.arguments.map((arg) =>
      arg.type === 'SpreadElement' ? null : getStringConstant(arg)
    );
    if (parts.some((part) => part === null)) {
      return null;
    }

    return [base, ...(parts as string[])].join('');
  }

  if (
    expression.type === 'TSAsExpression' ||
    expression.type === 'TSSatisfiesExpression' ||
    expression.type === 'TSNonNullExpression' ||
    expression.type === 'TSTypeAssertion' ||
    expression.type === 'ParenthesizedExpression'
  ) {
    return getStringConstant(expression.expression);
  }

  return null;
};

const isRequireCall = (node: Node, scope: Scope): boolean =>
  node.type === 'CallExpression' &&
  node.callee.type === 'Identifier' &&
  node.callee.name === 'require' &&
  lookupBinding(scope, 'require') === null;

const sourceFromRequireLike = (
  node: Node,
  scope: Scope,
  state: AnalyzerState
): string | null => {
  if (isRequireCall(node, scope)) {
    const call = node as CallExpression;
    const [sourceArg] = call.arguments;
    if (!sourceArg || sourceArg.type === 'SpreadElement') {
      return null;
    }

    return getStringConstant(sourceArg);
  }

  if (node.type === 'Identifier') {
    return state.requireSources.get(node.name) ?? null;
  }

  if (node.type === 'CallExpression') {
    for (const arg of node.arguments) {
      if (arg.type === 'SpreadElement') {
        continue;
      }

      const source = sourceFromRequireLike(arg, scope, state);
      if (source) {
        return source;
      }
    }
  }

  return null;
};

const sourceFromDirectRequireBinding = (
  node: Node,
  scope: Scope,
  state: AnalyzerState
): string | null => {
  if (isRequireCall(node, scope)) {
    const call = node as CallExpression;
    const [sourceArg] = call.arguments;
    if (!sourceArg || sourceArg.type === 'SpreadElement') {
      return null;
    }

    return getStringConstant(sourceArg);
  }

  if (node.type === 'Identifier') {
    return state.requireSources.get(node.name) ?? null;
  }

  return null;
};

const sourceFromRequireSyntax = (node: Node): string | null => {
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require'
  ) {
    const [sourceArg] = node.arguments;
    return sourceArg && sourceArg.type !== 'SpreadElement'
      ? getStringConstant(sourceArg)
      : null;
  }

  if (node.type === 'CallExpression') {
    for (const arg of node.arguments) {
      if (arg.type === 'SpreadElement') {
        continue;
      }

      const source = sourceFromRequireSyntax(arg);
      if (source) {
        return source;
      }
    }
  }

  return null;
};

const sourceFromImportedMember = (
  node: Node,
  scope: Scope,
  state: AnalyzerState
): { imported: string | '*' | 'default'; source: string } | null => {
  if (node.type !== 'MemberExpression') {
    return null;
  }

  const source = sourceFromRequireLike(node.object, scope, state);
  const imported = nameFromMemberProperty(node);
  if (!source || !imported) {
    return null;
  }

  return { imported, source };
};

const isExportsObject = (node: Node): boolean =>
  node.type === 'Identifier' && node.name === 'exports';

const getExportAssignmentName = (node: Node): string | 'default' | null => {
  if (node.type !== 'MemberExpression') {
    return null;
  }

  if (isExportsObject(node.object)) {
    return nameFromMemberProperty(node);
  }

  if (
    node.object.type === 'Identifier' &&
    node.object.name === 'module' &&
    nameFromMemberProperty(node) === 'exports'
  ) {
    return 'default';
  }

  return null;
};

const getCalleeName = (node: Expression): string | null => {
  if (node.type === 'Identifier') {
    return node.name;
  }

  if (node.type === 'MemberExpression') {
    return nameFromMemberProperty(node);
  }

  return null;
};

const getObjectProperty = (
  objectExpression: ObjectExpression,
  name: string
): Node | null => {
  for (const property of objectExpression.properties) {
    if (property.type === 'SpreadElement') {
      continue;
    }

    if (nameFromPropertyKey(property.key) === name) {
      return property.value;
    }
  }

  return null;
};

const getReturnedExpression = (node: Node): Expression | null => {
  if (node.type === 'ArrowFunctionExpression') {
    return node.body.type === 'BlockStatement'
      ? getReturnedExpression(node.body)
      : node.body;
  }

  if (
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration'
  ) {
    return node.body ? getReturnedExpression(node.body) : null;
  }

  if (node.type === 'BlockStatement') {
    const returned = node.body.find(
      (statement) => statement.type === 'ReturnStatement'
    );
    return returned?.type === 'ReturnStatement' ? returned.argument : null;
  }

  return null;
};

const collectFromImportDeclaration = (
  node: ImportDeclaration,
  scope: Scope,
  state: AnalyzerState
): void => {
  if (isTypeOnlyImport(node)) {
    return;
  }

  const source = node.source.value;
  if (node.specifiers.length === 0) {
    addImport(state, {
      imported: 'side-effect',
      local: node,
      source,
      type: 'esm',
    });
    return;
  }

  node.specifiers.forEach((specifier) => {
    if (isTypeOnlyImportSpecifier(node, specifier)) {
      return;
    }

    if (specifier.type === 'ImportNamespaceSpecifier') {
      const binding: NamespaceBinding = {
        kind: 'namespace',
        local: localFromNode(specifier.local, state.code, specifier.local.name),
        name: specifier.local.name,
        source,
        type: 'esm',
        used: false,
      };
      defineBinding(scope, binding);
      state.namespaces.push(binding);
      return;
    }

    if (specifier.type === 'ImportDefaultSpecifier') {
      defineBinding(scope, { kind: 'local', name: specifier.local.name });
      addImport(state, {
        imported: 'default',
        local: specifier.local,
        name: specifier.local.name,
        source,
        type: 'esm',
      });
      return;
    }

    defineBinding(scope, { kind: 'local', name: specifier.local.name });
    addImport(state, {
      imported: nameFromModuleExport(specifier.imported),
      local: specifier.local,
      name: specifier.local.name,
      source,
      type: 'esm',
    });
  });
};

const collectExportedDeclaration = (
  declaration: ExportNamedDeclaration['declaration'],
  state: AnalyzerState
): void => {
  if (!declaration) {
    return;
  }

  if (declaration.type === 'VariableDeclaration') {
    declaration.declarations.forEach((declarator) => {
      exportFromVariableDeclarator(declarator, state);
    });
    return;
  }

  if (declaration.type === 'TSEnumDeclaration') {
    addExport(state, declaration.id.name, declaration.id, declaration.id.name);
    return;
  }

  if (
    declaration.type === 'FunctionDeclaration' ||
    declaration.type === 'ClassDeclaration'
  ) {
    const { id } = declaration as OxcFunction | OxcClass;
    if (id) {
      addExport(state, id.name, id, id.name);
    }
  }
};

const collectFromExportNamedDeclaration = (
  node: ExportNamedDeclaration,
  state: AnalyzerState
): void => {
  if (isTypeOnlyExport(node)) {
    return;
  }

  const source = node.source?.value;
  node.specifiers.forEach((specifier) => {
    if (isTypeOnlyExport(specifier)) {
      return;
    }

    const exported = nameFromModuleExport(specifier.exported);
    const imported = nameFromModuleExport(specifier.local);

    if (source) {
      addReexport(state, {
        exported,
        imported,
        local: specifier,
        source,
      });
      return;
    }

    addExport(state, exported, specifier.local, imported);
  });

  collectExportedDeclaration(node.declaration, state);
};

const collectFromExportAllDeclaration = (
  node: ExportAllDeclaration,
  state: AnalyzerState
): void => {
  if (isTypeOnlyExport(node)) {
    return;
  }

  addReexport(state, {
    exported: node.exported ? nameFromModuleExport(node.exported) : '*',
    imported: '*',
    local: node,
    source: node.source.value,
  });
};

const collectFromExportDefaultDeclaration = (
  node: ExportDefaultDeclaration,
  state: AnalyzerState
): void => {
  if (isTypeOnlyExport(node)) {
    return;
  }

  addExport(state, 'default', node.declaration);
};

const exportFromVariableDeclarator = (
  node: VariableDeclarator,
  state: AnalyzerState
): void => {
  if (node.id.type === 'Identifier') {
    addExport(state, node.id.name, node.init ?? node.id, node.id.name);
    return;
  }

  if (node.id.type === 'ObjectPattern') {
    collectDestructed(node.id).forEach((destructed) => {
      if (destructed.as.type === 'Identifier') {
        addExport(
          state,
          destructed.as.name,
          node.init ?? destructed.as,
          destructed.as.name
        );
      }
    });
    return;
  }

  if (node.id.type === 'ArrayPattern') {
    collectBindingNames(node.id).forEach((name) =>
      addExport(state, name, node.init ?? node.id, name)
    );
  }
};

const collectFromImportExpression = (
  node: ImportExpression,
  parent: Node | null,
  state: AnalyzerState
): void => {
  const source = getStringConstant(node.source);
  if (!source) {
    return;
  }

  let container = parent;
  let awaited = false;
  if (container?.type === 'AwaitExpression') {
    awaited = true;
    container = findParentContainer(container);
  }

  if (container?.type === 'VariableDeclarator') {
    importFromVariableDeclarator(container, awaited, source, 'dynamic', state);
  }
};

const collectFromWywDynamicImport = (
  node: CallExpression,
  parent: Node | null,
  state: AnalyzerState
): void => {
  if (
    node.callee.type !== 'Identifier' ||
    node.callee.name !== '__wyw_dynamic_import'
  ) {
    return;
  }

  const [sourceArg] = node.arguments;
  if (!sourceArg || sourceArg.type === 'SpreadElement') {
    return;
  }

  const source = getStringConstant(sourceArg);
  if (!source) {
    return;
  }

  let container = parent;
  let awaited = false;
  if (container?.type === 'AwaitExpression') {
    awaited = true;
    container = findParentContainer(container);
  }

  if (container?.type === 'VariableDeclarator') {
    importFromVariableDeclarator(container, awaited, source, 'dynamic', state);
    return;
  }

  addImport(state, {
    imported: '*',
    local: node,
    source,
    type: 'dynamic',
  });
};

const parentContainers = new WeakMap<Node, Node | null>();

const findParentContainer = (node: Node): Node | null =>
  parentContainers.get(node) ?? null;

const importFromVariableDeclarator = (
  node: VariableDeclarator,
  isSync: boolean,
  source: string,
  type: ImportKind,
  state: AnalyzerState
): void => {
  if (node.id.type === 'Identifier') {
    addImport(state, {
      imported: '*',
      local: node.id,
      name: node.id.name,
      source,
      type,
    });
    return;
  }

  if (!isSync || node.id.type !== 'ObjectPattern') {
    return;
  }

  collectDestructed(node.id).forEach((destructed) => {
    addImport(state, {
      imported: destructed.what,
      local: destructed.as,
      source,
      type,
    });
  });
};

const collectFromRequireDeclarator = (
  node: VariableDeclarator,
  scope: Scope,
  state: AnalyzerState
): boolean => {
  if (!node.init) {
    return false;
  }

  const memberImport = sourceFromImportedMember(node.init, scope, state);
  if (memberImport) {
    if (node.id.type === 'Identifier') {
      defineBinding(scope, { kind: 'local', name: node.id.name });
      addImport(state, {
        imported: memberImport.imported,
        local: node.id,
        name: node.id.name,
        source: memberImport.source,
        type: 'cjs',
      });
    }
    return true;
  }

  const source = sourceFromRequireLike(node.init, scope, state);
  if (!source) {
    return false;
  }

  if (node.id.type === 'Identifier') {
    state.requireSources.set(node.id.name, source);
    const binding: NamespaceBinding = {
      kind: 'namespace',
      local: localFromNode(node.id, state.code, node.id.name),
      name: node.id.name,
      source,
      type: 'cjs',
      used: false,
    };
    defineBinding(scope, binding);
    state.namespaces.push(binding);
    return true;
  }

  if (node.id.type === 'ObjectPattern') {
    collectDestructed(node.id).forEach((destructed) => {
      addImport(state, {
        imported: destructed.what,
        local: destructed.as,
        source,
        type: 'cjs',
      });
    });
    return true;
  }

  return false;
};

const collectFromNamespaceReference = (
  node: OxcIdentifier,
  parent: Node | null,
  ctx: VisitContext,
  state: AnalyzerState
): void => {
  const binding = lookupBinding(ctx.scope, node.name);
  if (!binding || binding.kind !== 'namespace') {
    return;
  }

  if (!isOxcRuntimeReferenceIdentifier(node, parent, state.ancestors)) {
    return;
  }

  if (isTypeNode(parent)) {
    return;
  }

  binding.used = true;

  if (parent?.type === 'MemberExpression' && parent.object === node) {
    const imported = nameFromMemberProperty(parent);
    addImport(state, {
      imported: imported ?? '*',
      local: imported ? parent : node,
      source: binding.source,
      type: binding.type,
    });
    return;
  }

  if (parent?.type === 'VariableDeclarator' && parent.init === node) {
    if (parent.id.type === 'ObjectPattern') {
      collectDestructed(parent.id).forEach((destructed) => {
        addImport(state, {
          imported: destructed.what,
          local: destructed.as,
          source: binding.source,
          type: binding.type,
        });
      });
      return;
    }
  }

  addImport(state, {
    imported: '*',
    local: node,
    name: node.name,
    source: binding.source,
    type: binding.type,
  });
};

const isTypeNode = (node: Node | null): boolean =>
  !!node && (node.type.startsWith('TS') || node.type.startsWith('JSDoc'));

const collectFromAssignmentExpression = (
  node: AssignmentExpression,
  ctx: VisitContext,
  state: AnalyzerState
): void => {
  if (node.operator !== '=') {
    return;
  }

  const exported = getExportAssignmentName(node.left);
  if (!exported || exported === '__esModule') {
    return;
  }

  const imported = sourceFromImportedMember(node.right, ctx.scope, state);
  if (imported) {
    addReexport(state, {
      exported,
      imported: imported.imported,
      local: node,
      source: imported.source,
    });
    return;
  }

  const directRequireSource = sourceFromDirectRequireBinding(
    node.right,
    ctx.scope,
    state
  );
  if (directRequireSource) {
    addReexport(state, {
      exported,
      imported: '*',
      local: node,
      source: directRequireSource,
    });
    return;
  }

  addExport(state, exported, node.right);
};

const collectFromRequireExpressionStatement = (
  node: ExpressionStatement,
  scope: Scope,
  state: AnalyzerState
): void => {
  const source = sourceFromDirectRequireBinding(node.expression, scope, state);
  if (!source) {
    return;
  }

  addImport(state, {
    imported: 'side-effect',
    local: node.expression,
    source,
    type: 'cjs',
  });
};

const collectFromDefineProperty = (
  node: CallExpression,
  ctx: VisitContext,
  state: AnalyzerState
): boolean => {
  if (
    node.callee.type !== 'MemberExpression' ||
    node.callee.object.type !== 'Identifier' ||
    node.callee.object.name !== 'Object' ||
    nameFromMemberProperty(node.callee) !== 'defineProperty'
  ) {
    return false;
  }

  const [target, nameArg, descriptor] = node.arguments;
  if (
    !target ||
    !nameArg ||
    !descriptor ||
    target.type === 'SpreadElement' ||
    nameArg.type === 'SpreadElement' ||
    descriptor.type === 'SpreadElement' ||
    !isExportsObject(target)
  ) {
    return false;
  }

  const exported = getStringConstant(nameArg);
  if (!exported || exported === '__esModule') {
    return true;
  }

  if (descriptor.type === 'ObjectExpression') {
    const getter = getObjectProperty(descriptor, 'get');
    const returned = getter ? getReturnedExpression(getter) : null;
    const imported = returned
      ? sourceFromImportedMember(returned, ctx.scope, state)
      : null;

    if (imported) {
      addReexport(state, {
        exported,
        imported: imported.imported,
        local: node,
        source: imported.source,
      });
      return true;
    }

    const directRequireSource = returned
      ? sourceFromDirectRequireBinding(returned, ctx.scope, state)
      : null;
    if (directRequireSource) {
      addReexport(state, {
        exported,
        imported: '*',
        local: node,
        source: directRequireSource,
      });
      return true;
    }

    if (returned) {
      addExport(state, exported, returned);
      return true;
    }
  }

  addExport(state, exported, node);
  return true;
};

const collectFromHelperCall = (
  node: CallExpression,
  ctx: VisitContext,
  state: AnalyzerState
): void => {
  const callee = getCalleeName(node.callee);
  if (!callee) {
    return;
  }

  if (collectFromDefineProperty(node, ctx, state)) {
    return;
  }

  if (callee === 'forEach' && node.callee.type === 'MemberExpression') {
    const { object } = node.callee;
    if (
      object.type === 'CallExpression' &&
      object.callee.type === 'MemberExpression' &&
      object.callee.object.type === 'Identifier' &&
      object.callee.object.name === 'Object' &&
      nameFromMemberProperty(object.callee) === 'keys'
    ) {
      const [keysArg] = object.arguments;
      if (keysArg && keysArg.type !== 'SpreadElement') {
        const source = sourceFromRequireLike(keysArg, ctx.scope, state);
        if (source) {
          addReexport(state, {
            exported: '*',
            imported: '*',
            local: node,
            source,
          });
        }
      }
    }
    return;
  }

  if (
    /(?:^|_)exportStar$/i.test(callee) ||
    callee === '_export_star' ||
    callee === '__reExport'
  ) {
    for (const arg of node.arguments) {
      if (arg.type === 'SpreadElement') {
        continue;
      }

      const source = sourceFromRequireLike(arg, ctx.scope, state);
      if (source) {
        addReexport(state, {
          exported: '*',
          imported: '*',
          local: node,
          source,
        });
        return;
      }
    }
  }

  if (callee === '__export' || callee === '_export') {
    const [firstArg, secondArg] = node.arguments;
    if (firstArg && firstArg.type !== 'SpreadElement') {
      const source = sourceFromRequireLike(firstArg, ctx.scope, state);
      if (source) {
        addReexport(state, {
          exported: '*',
          imported: '*',
          local: node,
          source,
        });
        return;
      }
    }

    if (secondArg?.type === 'ObjectExpression') {
      secondArg.properties.forEach((property) => {
        if (property.type === 'SpreadElement') {
          return;
        }

        const exported = nameFromPropertyKey(property.key);
        const returned = getReturnedExpression(property.value);
        if (!exported || !returned) {
          return;
        }

        const imported = sourceFromImportedMember(returned, ctx.scope, state);
        if (imported) {
          addReexport(state, {
            exported,
            imported: imported.imported,
            local: property,
            source: imported.source,
          });
          return;
        }

        const directRequireSource = sourceFromDirectRequireBinding(
          returned,
          ctx.scope,
          state
        );
        if (directRequireSource) {
          addReexport(state, {
            exported,
            imported: '*',
            local: property,
            source: directRequireSource,
          });
          return;
        }

        addExport(state, exported, returned);
      });
    }
  }
};

const visit = (
  node: Node,
  ctx: VisitContext,
  state: AnalyzerState,
  mode: VisitMode = 'all'
): void => {
  if (mode === 'all') {
    parentContainers.set(node, ctx.parent);
  }

  let { scope } = ctx;
  if (
    node.type === 'Program' ||
    node.type === 'BlockStatement' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    scope = createScope(ctx.scope);
  }

  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    node.params.forEach((param) => declareLocalBindingLike(scope, param));
  }

  if (node.type === 'ImportDeclaration') {
    collectFromImportDeclaration(node, scope, state);
  } else if (mode === 'all' && node.type === 'ExportNamedDeclaration') {
    collectFromExportNamedDeclaration(node, state);
  } else if (mode === 'all' && node.type === 'ExportAllDeclaration') {
    collectFromExportAllDeclaration(node, state);
  } else if (mode === 'all' && node.type === 'ExportDefaultDeclaration') {
    collectFromExportDefaultDeclaration(node, state);
  } else if (node.type === 'VariableDeclarator') {
    if (!collectFromRequireDeclarator(node, scope, state)) {
      declareLocalPattern(scope, node.id);
    }
  } else if (mode === 'all' && node.type === 'ImportExpression') {
    collectFromImportExpression(node, ctx.parent, state);
  } else if (mode === 'all' && node.type === 'CallExpression') {
    collectFromWywDynamicImport(node, ctx.parent, state);
    collectFromHelperCall(node, { ...ctx, scope }, state);
  } else if (mode === 'all' && node.type === 'ExpressionStatement') {
    collectFromRequireExpressionStatement(node, scope, state);
  } else if (mode === 'all' && node.type === 'AssignmentExpression') {
    collectFromAssignmentExpression(node, { ...ctx, scope }, state);
  } else if (node.type === 'Identifier') {
    collectFromNamespaceReference(node, ctx.parent, { ...ctx, scope }, state);
  }

  state.ancestors.push(node);
  for (const child of getChildren(node)) {
    visit(child, { parent: node, scope }, state, mode);
  }
  state.ancestors.pop();
};

const getChildren = (node: Node): Node[] => {
  const result: Node[] = [];
  const record = node as AnyNode;

  Object.keys(record).forEach((key) => {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'range') {
      return;
    }

    const value = record[key];
    if (isNode(value)) {
      result.push(value);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (isNode(item)) {
          result.push(item);
        }
      });
    }
  });

  return result;
};

const precollectRequireSources = (node: Node, state: AnalyzerState): void => {
  // Cheap text precheck at the Program entry: if the file body has no
  // 'require(' substring there can be no CommonJS require() init to collect.
  // Skip the full AST walk — meaningful saving on ESM-only modules in large
  // monorepos. Done at Program-level only so nested recursion doesn't pay
  // the indexOf cost per node.
  if (node.type === 'Program' && state.code.indexOf('require(') === -1) {
    return;
  }

  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
    const source = node.init ? sourceFromRequireSyntax(node.init) : null;
    if (source) {
      state.requireSources.set(node.id.name, source);
    }
  }

  getChildren(node).forEach((child) => precollectRequireSources(child, state));
};

const addUnusedNamespaceSideEffects = (state: AnalyzerState): void => {
  state.namespaces.forEach((binding) => {
    if (!binding.used) {
      state.result.imports.push({
        imported: 'side-effect',
        local: binding.local,
        source: binding.source,
        type: binding.type,
      });
    }
  });
};

export function collectOxcExportsAndImportsFromProgram(
  program: Program,
  code: string,
  isEsModule: boolean
): OxcCollectedState {
  const cached = getCachedOxcCollection(program, code, isEsModule);
  if (cached) {
    return cached;
  }

  const rootScope = createScope(null);
  const state: AnalyzerState = {
    ancestors: [],
    code,
    namespaces: [],
    requireSources: new Map(),
    result: {
      deadExports: [],
      exports: {},
      imports: [],
      isEsModule,
      reexports: [],
    },
  };

  precollectRequireSources(program, state);
  visit(program, { parent: null, scope: rootScope }, state, 'all');
  addUnusedNamespaceSideEffects(state);

  return cacheOxcCollection(program, code, isEsModule, state.result);
}

export function collectOxcProcessorImportsFromProgram(
  program: Program,
  code: string
): OxcCollectedImport[] {
  const cached = getCachedOxcProcessorImports(program, code);
  if (cached) {
    return cached;
  }

  const rootScope = createScope(null);
  const state: AnalyzerState = {
    ancestors: [],
    code,
    namespaces: [],
    requireSources: new Map(),
    result: {
      deadExports: [],
      exports: {},
      imports: [],
      isEsModule: true,
      reexports: [],
    },
  };

  precollectRequireSources(program, state);
  visit(program, { parent: null, scope: rootScope }, state, 'importsOnly');

  return cacheOxcProcessorImports(program, code, state.result.imports);
}

export function collectOxcExportsAndImports(
  code: string,
  filename: string
): OxcCollectedState {
  const parsed = parseOxcCached(filename, code, 'unambiguous');

  return collectOxcExportsAndImportsFromProgram(
    parsed.program,
    code,
    parsed.module.hasModuleSyntax
  );
}
