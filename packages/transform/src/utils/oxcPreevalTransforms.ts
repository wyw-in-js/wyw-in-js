/* eslint-disable no-restricted-syntax,no-continue */

import type {
  CallExpression,
  Expression,
  ImportExpression,
  Node,
  Program,
} from 'oxc-parser';

import type { CodeRemoverOptions } from '@wyw-in-js/shared';

import { collectOxcExportsAndImports } from './collectOxcExportsAndImports';
import { EventEmitter } from './EventEmitter';
import { getOxcNodeChildren } from './oxc/ast';
import {
  isControlStatement,
  removeEmptyControlStatements,
  removeOwner,
  type ControlStatement,
} from './oxcDangerousCodeOwners';
import { parseOxcProgramCached } from './parseOxc';

type AnyNode = Node & Record<string, unknown>;

export type Replacement = {
  end: number;
  start: number;
  value: string;
};

export type DangerousCodeReplacement = Replacement & {
  kind?: 'component';
};

type Scope = {
  bindings: Map<string, Expression | null>;
  key: string;
  names: Set<string>;
  parent: Scope | null;
};

type ImportBinding = {
  imported: string | 'default' | '*';
  local: string;
  source: string;
};

type OxcFunctionLikeNode = Node & {
  async: boolean;
  body: Node;
  id?: { name: string } | null;
  type:
    | 'ArrowFunctionExpression'
    | 'FunctionDeclaration'
    | 'FunctionExpression';
};

const ssrCheckFields = new Set([
  'document',
  'location',
  'navigator',
  'sessionStorage',
  'localStorage',
  'window',
]);

const forbiddenGlobals = new Set([
  ...ssrCheckFields,
  '$RefreshReg$',
  '$RefreshSig$',
  'XMLHttpRequest',
  'clearImmediate',
  'clearInterval',
  'clearTimeout',
  'fetch',
  'navigator',
  'setImmediate',
  'setInterval',
  'setTimeout',
]);

const alwaysForbiddenIdentifiers = new Set(['$RefreshReg$', '$RefreshSig$']);
const promiseCallbackMethods = new Set(['then', 'catch', 'finally']);
const jsxRuntimeSources = new Set([
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
]);
const defaultPlaceholder = '...';
const defaultReactComponentTypes = [
  'ExoticComponent',
  'FC',
  'ForwardRefExoticComponent',
  'FunctionComponent',
  'LazyExoticComponent',
  'MemoExoticComponent',
  'NamedExoticComponent',
];
const defaultReactHocs = ['forwardRef', 'memo'];
const generatedProcessorHelperNameRe = /^_exp\d*$/;
const requireCallRe = /\brequire\s*\(/;
const windowTokenRe = /\bwindow\b/;
const importMetaEnvRe = /\bimport\s*\.\s*meta\s*\.\s*env\b/;

const createScope = (parent: Scope | null, key: string): Scope => ({
  bindings: new Map(),
  key,
  names: new Set(),
  parent,
});

const createsScope = (node: Node): boolean =>
  node.type === 'Program' ||
  node.type === 'BlockStatement' ||
  node.type === 'FunctionDeclaration' ||
  node.type === 'FunctionExpression' ||
  node.type === 'ArrowFunctionExpression';

const hasBinding = (scope: Scope, name: string): boolean => {
  let current: Scope | null = scope;
  while (current) {
    if (current.names.has(name)) {
      return true;
    }

    current = current.parent;
  }

  return false;
};

const getBindingKey = (scope: Scope, name: string): string | null => {
  let current: Scope | null = scope;
  while (current) {
    if (current.names.has(name)) {
      return `${current.key}\0${name}`;
    }

    current = current.parent;
  }

  return null;
};

const getStaticBinding = (
  scope: Scope,
  name: string
): Expression | null | undefined => {
  let current: Scope | null = scope;
  while (current) {
    if (current.bindings.has(name)) {
      return current.bindings.get(name);
    }

    current = current.parent;
  }

  return undefined;
};

const isFileLikeRequireSpecifier = (value: string): boolean =>
  value.startsWith('.') || value.startsWith('/') || value.startsWith('file:');

const isNode = (value: unknown): value is Node =>
  !!value &&
  typeof value === 'object' &&
  'type' in value &&
  typeof (value as { type?: unknown }).type === 'string';

// Reuses the per-node.type visitor-key cache in utils/oxc/ast.ts. This file's
// getChildren shape historically diverged from the canonical one (a smaller
// metadata-key skip set), but the produced children list is identical in
// practice because oxc-parser nodes don't carry the extra metadata fields.
const getChildren = getOxcNodeChildren;

const parseOxc = (code: string, filename: string): Program => {
  return parseOxcProgramCached(filename, code, 'unambiguous');
};

const unwrapExpression = (node: Expression): Expression => {
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

const getMemberPropertyName = (node: Node): string | null => {
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

const isStringLikeExpression = (node: Expression): boolean => {
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

const dynamicImportArgumentCode = (code: string, node: Expression): string => {
  if (node.type === 'TemplateLiteral') {
    return templateLiteralToConcat(code, node);
  }

  return code.slice(node.start, node.end);
};

const evaluateStaticValue = (
  node: Expression,
  scope: Scope,
  seen = new Set<string>()
): unknown | undefined => {
  const expression = unwrapExpression(node);

  if (expression.type === 'Literal') {
    return expression.value;
  }

  if (expression.type === 'TemplateLiteral') {
    let result = '';

    for (let idx = 0; idx < expression.quasis.length; idx += 1) {
      result += expression.quasis[idx]?.value.cooked ?? '';

      const nextExpression = expression.expressions[idx];
      if (!nextExpression) {
        continue;
      }

      const value = evaluateStaticValue(nextExpression, scope, seen);
      if (
        value === undefined ||
        (typeof value !== 'string' && typeof value !== 'number')
      ) {
        return undefined;
      }

      result += String(value);
    }

    return result;
  }

  if (expression.type === 'Identifier') {
    if (seen.has(expression.name)) {
      return undefined;
    }

    const binding = getStaticBinding(scope, expression.name);
    if (!binding) {
      return undefined;
    }

    return evaluateStaticValue(
      binding,
      scope,
      new Set([...seen, expression.name])
    );
  }

  if (expression.type === 'BinaryExpression' && expression.operator === '+') {
    const left = evaluateStaticValue(expression.left, scope, seen);
    const right = evaluateStaticValue(expression.right, scope, seen);

    if (left === undefined || right === undefined) {
      return undefined;
    }

    if (typeof left === 'number' && typeof right === 'number') {
      return left + right;
    }

    if (
      (typeof left === 'string' || typeof left === 'number') &&
      (typeof right === 'string' || typeof right === 'number')
    ) {
      return `${left}${right}`;
    }
  }

  if (
    expression.type === 'CallExpression' &&
    expression.callee.type === 'MemberExpression'
  ) {
    const objectValue = evaluateStaticValue(
      expression.callee.object,
      scope,
      seen
    );
    const propertyName = getMemberPropertyName(expression.callee);
    if (!propertyName) {
      return undefined;
    }

    if (typeof objectValue === 'string') {
      if (propertyName === 'toLowerCase' && expression.arguments.length === 0) {
        return objectValue.toLowerCase();
      }

      if (propertyName === 'toUpperCase' && expression.arguments.length === 0) {
        return objectValue.toUpperCase();
      }

      if (propertyName === 'trim' && expression.arguments.length === 0) {
        return objectValue.trim();
      }

      if (propertyName === 'concat') {
        const args = expression.arguments.map((argument) =>
          argument.type === 'SpreadElement'
            ? undefined
            : evaluateStaticValue(argument, scope, seen)
        );
        if (
          args.some((value) => value === undefined) ||
          args.some(
            (value) => typeof value !== 'string' && typeof value !== 'number'
          )
        ) {
          return undefined;
        }

        return objectValue.concat(...args.map((value) => String(value)));
      }
    }
  }

  return undefined;
};

const isLiteralRequireArg = (node: Expression): boolean => {
  const expression = unwrapExpression(node);

  if (expression.type === 'Literal' && typeof expression.value === 'string') {
    return true;
  }

  if (
    expression.type === 'TemplateLiteral' &&
    expression.expressions.length === 0
  ) {
    return true;
  }

  return false;
};

export const applyReplacements = (
  code: string,
  replacements: Replacement[]
): string => {
  let result = code;
  replacements
    .sort((a, b) => b.start - a.start)
    .forEach((replacement) => {
      result =
        result.slice(0, replacement.start) +
        replacement.value +
        result.slice(replacement.end);
    });

  return result;
};

const isIdentifierNamed = (value: unknown, name: string): boolean =>
  isNode(value) && value.type === 'Identifier' && value.name === name;

const isImportMeta = (node: unknown): boolean => {
  if (!isNode(node) || node.type !== 'MetaProperty') {
    return false;
  }

  const metaProperty = node as AnyNode;
  return (
    isIdentifierNamed(metaProperty.meta, 'import') &&
    isIdentifierNamed(metaProperty.property, 'meta')
  );
};

const isImportMetaEnv = (node: Node): boolean => {
  if (node.type !== 'MemberExpression') {
    return false;
  }

  if (node.computed || !isIdentifierNamed(node.property, 'env')) {
    return false;
  }

  return isImportMeta(node.object);
};

const collectBindingNames = (node: Node): string[] => {
  if (node.type === 'Identifier') {
    return [node.name];
  }

  if (node.type === 'RestElement') {
    return collectBindingNames(node.argument);
  }

  if (node.type === 'AssignmentPattern') {
    return collectBindingNames(node.left);
  }

  if (node.type === 'ObjectPattern') {
    return node.properties.flatMap((property) =>
      property.type === 'RestElement'
        ? collectBindingNames(property.argument)
        : collectBindingNames(property.value)
    );
  }

  if (node.type === 'ArrayPattern') {
    return node.elements.flatMap((element) =>
      element ? collectBindingNames(element) : []
    );
  }

  if (node.type === 'TSParameterProperty') {
    return collectBindingNames(node.parameter);
  }

  return [];
};

const predeclareScopeNames = (node: Node, scope: Scope): void => {
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    if (node.type !== 'ArrowFunctionExpression' && node.id) {
      scope.names.add(node.id.name);
    }

    node.params.forEach((param) => {
      collectBindingNames(param).forEach((name) => {
        scope.names.add(name);
      });
    });
  }

  const visitScopeDescendants = (child: Node): void => {
    switch (child.type) {
      case 'VariableDeclarator': {
        const names = collectBindingNames(child.id);
        for (let i = 0; i < names.length; i += 1) {
          scope.names.add(names[i]);
        }
        break;
      }
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
        if (child.id) {
          scope.names.add(child.id.name);
        }
        break;
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
      case 'ImportSpecifier':
        scope.names.add(child.local.name);
        break;
      default:
        break;
    }

    if (createsScope(child)) {
      return;
    }

    const children = getChildren(child);
    for (let i = 0; i < children.length; i += 1) {
      visitScopeDescendants(children[i]);
    }
  };

  const rootChildren = getChildren(node);
  for (let i = 0; i < rootChildren.length; i += 1) {
    visitScopeDescendants(rootChildren[i]);
  }
};

const declareBindings = (node: Node, scope: Scope): void => {
  // Called for every visited AST node, so the dispatch is hot. A switch lets
  // V8 generate a jump table on node.type; the previous chained `if`s walked
  // each branch's string-compare for every non-matching node.
  switch (node.type) {
    case 'VariableDeclarator': {
      const names = collectBindingNames(node.id);
      for (let i = 0; i < names.length; i += 1) {
        const name = names[i];
        scope.names.add(name);
        scope.bindings.set(name, null);
      }
      if (node.id.type === 'Identifier' && node.init) {
        scope.bindings.set(node.id.name, node.init);
      }
      return;
    }
    case 'ClassDeclaration': {
      if (node.id) {
        scope.names.add(node.id.name);
        scope.bindings.set(node.id.name, null);
      }
      return;
    }
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ImportSpecifier': {
      scope.names.add(node.local.name);
      scope.bindings.set(node.local.name, null);
      return;
    }
    case 'FunctionDeclaration': {
      if (node.id) {
        scope.names.add(node.id.name);
        scope.bindings.set(node.id.name, null);
      }
      // Fall through to declare params.
    }
    // eslint-disable-next-line no-fallthrough
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      const { params } = node;
      for (let i = 0; i < params.length; i += 1) {
        const names = collectBindingNames(params[i]);
        for (let j = 0; j < names.length; j += 1) {
          const name = names[j];
          scope.names.add(name);
          scope.bindings.set(name, null);
        }
      }
      break;
    }
    default:
      break;
  }
};

const visit = (
  node: Node,
  scope: Scope,
  enter: (
    node: Node,
    scope: Scope,
    parent: Node | null,
    ancestors: Node[]
  ) => void,
  parent: Node | null = null,
  ancestors: Node[] = []
): void => {
  let currentScope = scope;
  if (createsScope(node)) {
    currentScope = createScope(scope, `${node.type}:${node.start}:${node.end}`);
    predeclareScopeNames(node, currentScope);
  }

  declareBindings(node, currentScope);
  enter(node, currentScope, parent, ancestors);

  // Push onto a shared ancestors stack instead of allocating `[...ancestors,
  // node]` per child step (O(n × depth) extra allocation on deep ASTs).
  // Every consumer of `ancestors` in this file reads it synchronously inside
  // the enter callback; future callers that need to retain the reference
  // must .slice() it themselves.
  ancestors.push(node);
  const children = getChildren(node);
  for (let i = 0; i < children.length; i += 1) {
    visit(children[i], currentScope, enter, node, ancestors);
  }
  ancestors.pop();
};

export const replaceImportMetaEnvWithOxc = (
  code: string,
  filename: string
): string => {
  if (!importMetaEnvRe.test(code)) {
    return code;
  }

  const replacements: Replacement[] = [];

  visit(parseOxc(code, filename), createScope(null, 'root'), (node) => {
    if (!isImportMetaEnv(node)) {
      return;
    }

    replacements.push({
      end: node.end,
      start: node.start,
      value: '__wyw_import_meta_env',
    });
  });

  return applyReplacements(code, replacements);
};

type CombinedSyntaxRewriteOptions = {
  addRequireFallback: boolean;
  eventEmitter?: EventEmitter;
  rewriteDynamicImports: boolean;
};

type RequireFallbackCandidate = {
  call: CallExpression;
  scope: Scope;
};

function collectDynamicImportAndRequireFallbackReplacements(
  code: string,
  filename: string,
  options: CombinedSyntaxRewriteOptions
): Replacement[] {
  const eventEmitter = options.eventEmitter ?? EventEmitter.dummy;
  const dynamicImportCandidates: ImportExpression[] = [];
  const requireFallbackCandidates: RequireFallbackCandidate[] = [];

  eventEmitter.perf(
    'transform:preeval:dynamicImportRequireFallback:scan',
    () => {
      visit(
        parseOxc(code, filename),
        createScope(null, 'root'),
        (node, scope) => {
          if (
            options.rewriteDynamicImports &&
            node.type === 'ImportExpression'
          ) {
            dynamicImportCandidates.push(node as ImportExpression);
          }

          if (!options.addRequireFallback || node.type !== 'CallExpression') {
            return;
          }

          const call = node as CallExpression;
          if (
            call.callee.type !== 'Identifier' ||
            call.callee.name !== 'require' ||
            hasBinding(scope, 'require') ||
            call.arguments.length !== 1
          ) {
            return;
          }

          const [firstArg] = call.arguments;
          if (
            !firstArg ||
            firstArg.type === 'SpreadElement' ||
            isLiteralRequireArg(firstArg)
          ) {
            return;
          }

          requireFallbackCandidates.push({
            call,
            scope,
          });
        }
      );
    }
  );

  const replacements: Replacement[] = [];

  eventEmitter.perf('transform:preeval:dynamicImport', () => {
    dynamicImportCandidates.forEach((importExpression) => {
      const argument = importExpression.source;
      const nextArgument = isStringLikeExpression(argument)
        ? unwrapExpression(argument)
        : argument;

      replacements.push({
        end: importExpression.end,
        start: importExpression.start,
        value: `__wyw_dynamic_import(${dynamicImportArgumentCode(
          code,
          nextArgument
        )})`,
      });
    });
  });

  eventEmitter.perf('transform:preeval:requireFallback', () => {
    requireFallbackCandidates.forEach(({ call, scope }) => {
      const [firstArg] = call.arguments;
      if (!firstArg || firstArg.type === 'SpreadElement') {
        return;
      }

      const staticValue = evaluateStaticValue(firstArg, scope);
      if (
        typeof staticValue === 'string' &&
        isFileLikeRequireSpecifier(staticValue)
      ) {
        replacements.push({
          end: firstArg.end,
          start: firstArg.start,
          value: JSON.stringify(staticValue),
        });
        return;
      }

      replacements.push({
        end: firstArg.end,
        start: firstArg.end,
        value: ', true',
      });
    });
  });

  return replacements;
}

export const rewriteDynamicImportsWithOxc = (
  code: string,
  filename: string
): string => {
  const replacements = collectDynamicImportAndRequireFallbackReplacements(
    code,
    filename,
    {
      addRequireFallback: false,
      rewriteDynamicImports: true,
    }
  );

  return applyReplacements(code, replacements);
};

export const addRequireFallbackWithOxc = (
  code: string,
  filename: string
): string => {
  const replacements = collectDynamicImportAndRequireFallbackReplacements(
    code,
    filename,
    {
      addRequireFallback: true,
      rewriteDynamicImports: false,
    }
  );

  return applyReplacements(code, replacements);
};

export const rewriteDynamicImportsAndAddRequireFallbackWithOxc = (
  code: string,
  filename: string,
  options: CombinedSyntaxRewriteOptions
): string => {
  const replacements = collectDynamicImportAndRequireFallbackReplacements(
    code,
    filename,
    options
  );

  return applyReplacements(code, replacements);
};

const isBindingPosition = (node: Node, parent: Node | null): boolean => {
  if (!parent) {
    return false;
  }

  if (parent.type === 'VariableDeclarator' && parent.id === node) {
    return true;
  }

  if (
    (parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ClassDeclaration' ||
      parent.type === 'ClassExpression') &&
    parent.id === node
  ) {
    return true;
  }

  if (
    parent.type === 'ImportSpecifier' &&
    (parent.local === node || parent.imported === node)
  ) {
    return true;
  }

  if (
    (parent.type === 'ImportDefaultSpecifier' ||
      parent.type === 'ImportNamespaceSpecifier') &&
    parent.local === node
  ) {
    return true;
  }

  if (
    parent.type === 'ExportSpecifier' &&
    (parent.local === node || parent.exported === node)
  ) {
    return true;
  }

  return false;
};

const isPropertyOnlyIdentifier = (node: Node, parent: Node | null): boolean => {
  if (!parent) {
    return false;
  }

  if (
    parent.type === 'MemberExpression' &&
    !parent.computed &&
    parent.property === node
  ) {
    return true;
  }

  if (
    (parent.type === 'Property' ||
      parent.type === 'MethodDefinition' ||
      parent.type === 'PropertyDefinition') &&
    !parent.computed &&
    parent.key === node
  ) {
    return true;
  }

  return false;
};

const isTypeContext = (ancestors: Node[]): boolean =>
  ancestors.some(
    (ancestor) =>
      ancestor.type.startsWith('TS') || ancestor.type.startsWith('JSDoc')
  );

const isInsideTypeof = (ancestors: Node[]): boolean =>
  ancestors.some(
    (ancestor) =>
      ancestor.type === 'UnaryExpression' && ancestor.operator === 'typeof'
  );

const isInsideImportDeclaration = (ancestors: Node[]): boolean =>
  ancestors.some((ancestor) => ancestor.type === 'ImportDeclaration');

function findLastAncestor<T extends Node>(
  ancestors: Node[],
  predicate: (ancestor: Node) => ancestor is T
): T | null;
function findLastAncestor(
  ancestors: Node[],
  predicate: (ancestor: Node) => boolean
): Node | null;
function findLastAncestor(
  ancestors: Node[],
  predicate: (ancestor: Node) => boolean
): Node | null {
  for (let idx = ancestors.length - 1; idx >= 0; idx -= 1) {
    const ancestor = ancestors[idx];
    if (predicate(ancestor)) {
      return ancestor;
    }
  }

  return null;
}

type ExportedBindingProtection = {
  start: number;
  end: number;
  value: string;
};

const collectExportedLocalNames = (program: Program): Set<string> => {
  const names = new Set<string>();
  for (const stmt of program.body) {
    if (
      stmt.type === 'ExportDefaultDeclaration' &&
      stmt.declaration.type === 'Identifier'
    ) {
      names.add(stmt.declaration.name);
      continue;
    }

    if (
      stmt.type !== 'ExportNamedDeclaration' ||
      stmt.declaration ||
      stmt.source
    ) {
      continue;
    }
    for (const spec of stmt.specifiers) {
      if (spec.type === 'ExportSpecifier' && spec.local.type === 'Identifier') {
        names.add(spec.local.name);
      }
    }
  }
  return names;
};

// When an offending identifier sits inside the value of a top-level export,
// removing the surrounding declaration would strip the export binding too.
// ESM linker then fails on consumers' `import { name } from '...'` because the
// named export no longer exists. To keep the binding alive, replace just the
// value (declarator init or default-export expression) with `undefined`.
const findExportedBindingProtection = (
  node: Node,
  ancestors: Node[],
  exportedLocalNames: Set<string>
): ExportedBindingProtection | null => {
  for (let idx = ancestors.length - 1; idx >= 0; idx -= 1) {
    const ancestor = ancestors[idx];

    if (ancestor.type === 'ExportDefaultDeclaration') {
      const decl = ancestor.declaration;
      if (decl && decl !== node && 'start' in decl && 'end' in decl) {
        return { start: decl.start, end: decl.end, value: 'undefined' };
      }
      return null;
    }

    if (ancestor.type !== 'VariableDeclarator') {
      continue;
    }

    if (ancestor.id.type !== 'Identifier' || !ancestor.init) {
      return null;
    }

    const varDecl = ancestors[idx - 1];
    const wrapper = ancestors[idx - 2] ?? null;

    if (varDecl?.type !== 'VariableDeclaration') {
      return null;
    }

    const isDirectExport =
      wrapper?.type === 'ExportNamedDeclaration' &&
      wrapper.declaration === varDecl;
    const isTopLevelDeclaration =
      wrapper === null || wrapper?.type === 'Program';
    const isDetachedExport =
      isTopLevelDeclaration && exportedLocalNames.has(ancestor.id.name);

    if (!isDirectExport && !isDetachedExport) {
      return null;
    }

    return {
      start: ancestor.init.start,
      end: ancestor.init.end,
      value: 'undefined',
    };
  }

  return null;
};

const findPromiseCallbackOwner = (ancestors: Node[]): Node | null => {
  for (let idx = ancestors.length - 1; idx >= 0; idx -= 1) {
    const ancestor = ancestors[idx];
    if (
      ancestor.type === 'NewExpression' &&
      ancestor.callee.type === 'Identifier' &&
      ancestor.callee.name === 'Promise'
    ) {
      return ancestor;
    }

    if (
      ancestor.type === 'CallExpression' &&
      ancestor.callee.type === 'MemberExpression' &&
      promiseCallbackMethods.has(getMemberPropertyName(ancestor.callee) ?? '')
    ) {
      return ancestor;
    }
  }

  return null;
};

const containsForbiddenIdentifier = (
  node: Node,
  isIgnoredNode: (node: Node) => boolean
): boolean => {
  if (isIgnoredNode(node)) {
    return false;
  }

  if (node.type === 'Identifier' && alwaysForbiddenIdentifiers.has(node.name)) {
    return true;
  }

  return getChildren(node).some((child) =>
    containsForbiddenIdentifier(child, isIgnoredNode)
  );
};

const collectWindowScopedNames = (
  program: Program,
  isIgnoredNode: (node: Node) => boolean
): Set<string> => {
  const windowScopedNames = new Set<string>();

  visit(program, createScope(null, 'root'), (node, scope) => {
    if (
      isIgnoredNode(node) ||
      node.type !== 'MemberExpression' ||
      node.object.type !== 'Identifier' ||
      node.object.name !== 'window' ||
      hasBinding(scope, 'window')
    ) {
      return;
    }

    const propertyName = getMemberPropertyName(node);
    if (propertyName) {
      windowScopedNames.add(propertyName);
    }
  });

  return windowScopedNames;
};

const containsForbiddenReference = (
  node: Node,
  scope: Scope,
  windowScopedNames: Set<string>,
  derivedForbiddenBindings: Set<string>,
  isIgnoredNode: (node: Node) => boolean
): boolean => {
  let found = false;

  visit(node, scope, (child, childScope, parent, ancestors) => {
    if (
      found ||
      isIgnoredNode(child) ||
      child.type !== 'Identifier' ||
      isTypeContext(ancestors) ||
      isInsideTypeof(ancestors) ||
      isPropertyOnlyIdentifier(child, parent) ||
      isBindingPosition(child, parent)
    ) {
      return;
    }

    const bindingKey = getBindingKey(childScope, child.name);
    if (
      alwaysForbiddenIdentifiers.has(child.name) ||
      (forbiddenGlobals.has(child.name) &&
        !hasBinding(childScope, child.name)) ||
      (windowScopedNames.has(child.name) &&
        !hasBinding(childScope, child.name)) ||
      (bindingKey !== null && derivedForbiddenBindings.has(bindingKey))
    ) {
      found = true;
    }
  });

  return found;
};

const nameFromModuleExport = (node: Node): string | null => {
  if (node.type === 'Identifier') {
    return node.name;
  }

  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }

  return null;
};

const collectImportBindings = (
  code: string,
  filename: string,
  program: Program
): ImportBinding[] => {
  const bindings = new Map<string, ImportBinding>();
  const addBinding = (binding: ImportBinding): void => {
    bindings.set(
      `${binding.local}\0${binding.source}\0${binding.imported}`,
      binding
    );
  };

  program.body.forEach((statement) => {
    if (statement.type !== 'ImportDeclaration') {
      return;
    }

    const source = statement.source.value;
    statement.specifiers.forEach((specifier) => {
      if (specifier.type === 'ImportDefaultSpecifier') {
        addBinding({
          imported: 'default',
          local: specifier.local.name,
          source,
        });
        return;
      }

      if (specifier.type === 'ImportNamespaceSpecifier') {
        addBinding({
          imported: '*',
          local: specifier.local.name,
          source,
        });
        return;
      }

      const imported = nameFromModuleExport(specifier.imported);
      if (!imported) {
        return;
      }

      addBinding({
        imported,
        local: specifier.local.name,
        source,
      });
    });
  });

  if (!requireCallRe.test(code)) {
    return [...bindings.values()];
  }

  collectOxcExportsAndImports(code, filename).imports.forEach((item) => {
    if (item.imported === 'side-effect') {
      return;
    }

    addBinding({
      imported: item.imported,
      local: item.local.code,
      source: item.source,
    });

    if (item.local.name && item.local.name !== item.local.code) {
      addBinding({
        imported: item.imported,
        local: item.local.name,
        source: item.source,
      });
    }
  });

  return [...bindings.values()];
};

const getImportBinding = (
  imports: ImportBinding[],
  local: string
): ImportBinding | undefined => imports.find((item) => item.local === local);

function unwrapSequenceCallee(node: Expression): Expression {
  if (
    node.type === 'SequenceExpression' &&
    node.expressions.length === 2 &&
    node.expressions[0]?.type === 'Literal' &&
    node.expressions[0].value === 0
  ) {
    return node.expressions[1] as Expression;
  }

  return node;
}

const getExpressionImportKey = (node: Expression): string | null => {
  const expression = unwrapSequenceCallee(node);

  if (expression.type === 'Identifier') {
    return expression.name;
  }

  if (expression.type !== 'MemberExpression') {
    return null;
  }

  if (expression.object.type !== 'Identifier') {
    return null;
  }

  const propertyName = getMemberPropertyName(expression);
  return propertyName ? `${expression.object.name}.${propertyName}` : null;
};

const isHookOrCreateElement = (name: string): boolean =>
  name === 'createElement' || /use[A-Z]/.test(name);

const getInnermostCallee = (call: CallExpression): Expression => {
  let callee = unwrapSequenceCallee(call.callee);
  while (callee.type === 'CallExpression') {
    callee = unwrapSequenceCallee(callee.callee);
  }

  return callee;
};

const getImportForExpression = (
  node: Expression,
  imports: ImportBinding[]
): [source: string, imported: string] | undefined => {
  const expression = unwrapSequenceCallee(node);
  const directMatchKey = getExpressionImportKey(expression);
  if (directMatchKey) {
    const directMatch = getImportBinding(imports, directMatchKey);
    if (directMatch) {
      return [directMatch.source, directMatch.imported];
    }
  }

  if (expression.type === 'Identifier') {
    const matched = getImportBinding(imports, expression.name);
    return matched ? [matched.source, matched.imported] : undefined;
  }

  if (expression.type !== 'MemberExpression') {
    return undefined;
  }

  if (expression.object.type !== 'Identifier') {
    return undefined;
  }

  const propertyName = getMemberPropertyName(expression);
  if (!propertyName) {
    return undefined;
  }

  const objectImport = getImportBinding(imports, expression.object.name);
  if (!objectImport) {
    return undefined;
  }

  if (
    objectImport.imported === 'default' ||
    objectImport.imported === '*' ||
    objectImport.source === 'react'
  ) {
    return [objectImport.source, propertyName];
  }

  return undefined;
};

const isReactRuntimeCall = (
  call: CallExpression,
  imports: ImportBinding[]
): boolean => {
  const callee = unwrapSequenceCallee(call.callee);
  const matched = getImportForExpression(callee, imports);
  if (!matched) {
    return false;
  }

  const [source, imported] = matched;
  if (jsxRuntimeSources.has(source)) {
    return true;
  }

  return source === 'react' && isHookOrCreateElement(imported);
};

const isHocCall = (
  call: CallExpression,
  hocs: Record<string, string[]>,
  imports: ImportBinding[]
): boolean => {
  const matched = getImportForExpression(getInnermostCallee(call), imports);
  return !!matched && hocs[matched[0]]?.includes(matched[1]);
};

const isInsideHocCall = (
  ancestors: Node[],
  hocs: Record<string, string[]>,
  imports: ImportBinding[]
): boolean =>
  ancestors.some(
    (ancestor): ancestor is CallExpression =>
      ancestor.type === 'CallExpression' && isHocCall(ancestor, hocs, imports)
  );

const getComponentTypes = (
  options?: CodeRemoverOptions
): Record<string, string[]> => {
  const componentTypes = {
    ...(options?.componentTypes ?? { react: [defaultPlaceholder] }),
  };
  const reactTypes = componentTypes.react;

  if (Array.isArray(reactTypes) && reactTypes.includes(defaultPlaceholder)) {
    const idx = reactTypes.indexOf(defaultPlaceholder);
    componentTypes.react = [...reactTypes];
    componentTypes.react.splice(idx, 1, ...defaultReactComponentTypes);
  }

  return componentTypes;
};

const getHocs = (options?: CodeRemoverOptions): Record<string, string[]> => {
  const hocs = {
    ...(options?.hocs ?? {}),
  };
  const reactHocs = new Set([...defaultReactHocs, ...(hocs.react ?? [])]);

  hocs.react = [...reactHocs];
  return hocs;
};

const getTypeImport = (
  node: Node,
  imports: ImportBinding[]
): [source: string, imported: string] | undefined => {
  if (node.type === 'Identifier') {
    const matched = getImportBinding(imports, node.name);
    return matched ? [matched.source, matched.imported] : undefined;
  }

  if (node.type !== 'TSQualifiedName') {
    return undefined;
  }

  if (node.left.type !== 'Identifier') {
    return undefined;
  }

  const matched = getImportBinding(imports, node.left.name);
  return matched ? [matched.source, node.right.name] : undefined;
};

const isComponentTypeMatch = (
  id: Node,
  componentTypes: Record<string, string[]>,
  imports: ImportBinding[]
): boolean => {
  if (id.type !== 'Identifier') {
    return false;
  }

  const annotation = id.typeAnnotation;
  if (
    !annotation ||
    annotation.type !== 'TSTypeAnnotation' ||
    annotation.typeAnnotation.type !== 'TSTypeReference'
  ) {
    return false;
  }

  const matched = getTypeImport(annotation.typeAnnotation.typeName, imports);
  return !!matched && componentTypes[matched[0]]?.includes(matched[1]);
};

const getClassName = (node: Node): string | null =>
  node.type === 'ClassDeclaration' && node.id ? node.id.name : null;

const isFunctionLikeNode = (node: Node): node is OxcFunctionLikeNode =>
  node.type === 'FunctionDeclaration' ||
  node.type === 'FunctionExpression' ||
  node.type === 'ArrowFunctionExpression';

const isImmediatelyInvokedFunction = (
  fnNode: Node,
  ancestors: Node[],
  fnIndex: number
): boolean => {
  // Walk past any ParenthesizedExpression / SequenceExpression wrappers that
  // sit between the function and its enclosing CallExpression. oxc-parser
  // preserves ParenthesizedExpression nodes, so `(() => {...})()` shows up
  // as CallExpression -> ParenthesizedExpression -> ArrowFunctionExpression.
  let child: Node = fnNode;
  for (let idx = fnIndex - 1; idx >= 0; idx -= 1) {
    const ancestor = ancestors[idx];
    if (
      ancestor.type === 'ParenthesizedExpression' &&
      'expression' in ancestor &&
      ancestor.expression === child
    ) {
      child = ancestor;
      continue;
    }
    if (
      ancestor.type === 'SequenceExpression' &&
      Array.isArray(ancestor.expressions) &&
      ancestor.expressions[ancestor.expressions.length - 1] === child
    ) {
      child = ancestor;
      continue;
    }
    return ancestor.type === 'CallExpression' && ancestor.callee === child;
  }
  return false;
};

// A reference is "deferred" when it lives inside a function body that is
// not immediately invoked. Module preeval reads exports without calling
// them, so deferred references never run and must not be sanitized — that
// would silently drop the binding (or remove the entire export) and break
// importers that expect the function to be callable.
const isInDeferredFunctionScope = (ancestors: Node[]): boolean => {
  for (let idx = ancestors.length - 1; idx >= 0; idx -= 1) {
    const ancestor = ancestors[idx];
    if (!isFunctionLikeNode(ancestor)) {
      continue;
    }
    if (!isImmediatelyInvokedFunction(ancestor, ancestors, idx)) {
      return true;
    }
  }
  return false;
};

const findFunctionReplacement = (
  ancestors: Node[]
): DangerousCodeReplacement | null => {
  const renderMethod = findLastAncestor(
    ancestors,
    (ancestor) =>
      ancestor.type === 'MethodDefinition' &&
      ancestor.key.type === 'Identifier' &&
      ancestor.key.name === 'render'
  );

  if (renderMethod) {
    const classDecl = findLastAncestor(
      ancestors,
      (ancestor) => ancestor.type === 'ClassDeclaration'
    );
    const className = classDecl ? getClassName(classDecl) : null;
    if (classDecl && className) {
      return {
        start: classDecl.start,
        end: classDecl.end,
        kind: 'component',
        value: `function ${className}() { return null; }`,
      };
    }
  }

  const functionNode = findLastAncestor(ancestors, isFunctionLikeNode);

  if (!functionNode) {
    return null;
  }

  if (functionNode.type === 'ArrowFunctionExpression') {
    return {
      start: functionNode.start,
      end: functionNode.end,
      kind: 'component',
      value: `${functionNode.async ? 'async ' : ''}() => { return null; }`,
    };
  }

  if (functionNode.type === 'FunctionDeclaration') {
    return {
      start: functionNode.start,
      end: functionNode.end,
      kind: 'component',
      value: `${functionNode.async ? 'async ' : ''}function ${
        functionNode.id?.name ?? ''
      }() { return null; }`,
    };
  }

  return {
    start: functionNode.body.start,
    end: functionNode.body.end,
    kind: 'component',
    value: '{ return null; }',
  };
};

const normalizeReplacements = (
  replacements: DangerousCodeReplacement[]
): DangerousCodeReplacement[] => {
  const sorted = [...replacements].sort((a, b) =>
    a.start === b.start ? b.end - a.end : a.start - b.start
  );
  const result: DangerousCodeReplacement[] = [];

  sorted.forEach((replacement) => {
    const last = result[result.length - 1];
    if (
      last &&
      replacement.start >= last.start &&
      replacement.end <= last.end
    ) {
      return;
    }

    result.push(replacement);
  });

  return result;
};

export const collectDangerousCodeReplacementsWithOxc = (
  code: string,
  filename: string,
  options?: CodeRemoverOptions,
  planningOptions?: {
    ignoredSpans?: Array<{ end: number; start: number }>;
    preserveImportMetaEnv?: boolean;
  }
): DangerousCodeReplacement[] => {
  const replacements: DangerousCodeReplacement[] = [];
  const controlStatements: ControlStatement[] = [];
  const ignoredSpans = [...(planningOptions?.ignoredSpans ?? [])]
    .sort((a, b) => a.start - b.start)
    .reduce<Array<{ end: number; start: number }>>((result, span) => {
      const last = result[result.length - 1];
      if (last && span.start <= last.end) {
        last.end = Math.max(last.end, span.end);
      } else {
        result.push({ ...span });
      }

      return result;
    }, []);
  const isIgnoredNode = (node: Node): boolean => {
    let low = 0;
    let high = ignoredSpans.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const span = ignoredSpans[middle]!;
      if (node.start < span.start) {
        high = middle - 1;
      } else if (node.start >= span.end) {
        low = middle + 1;
      } else {
        return node.end <= span.end;
      }
    }

    return false;
  };
  const derivedForbiddenBindings = new Set<string>();
  const program = parseOxc(code, filename);
  const imports = collectImportBindings(code, filename, program);
  const componentTypes = getComponentTypes(options);
  const hocs = getHocs(options);
  const hasHocs = Object.keys(hocs).length > 0;
  const windowScopedNames = windowTokenRe.test(code)
    ? collectWindowScopedNames(program, isIgnoredNode)
    : new Set<string>();
  const exportedLocalNames = collectExportedLocalNames(program);

  const derivedBindingDiscovery = { found: true };
  while (derivedBindingDiscovery.found) {
    derivedBindingDiscovery.found = false;

    visit(program, createScope(null, 'root'), (node, scope) => {
      if (
        node.type !== 'VariableDeclarator' ||
        node.id.type !== 'Identifier' ||
        !node.init
      ) {
        return;
      }

      const bindingKey = getBindingKey(scope, node.id.name);
      if (!bindingKey || derivedForbiddenBindings.has(bindingKey)) {
        return;
      }

      if (
        containsForbiddenIdentifier(node.init, isIgnoredNode) ||
        containsForbiddenReference(
          node.init,
          scope,
          windowScopedNames,
          derivedForbiddenBindings,
          isIgnoredNode
        )
      ) {
        derivedForbiddenBindings.add(bindingKey);
        derivedBindingDiscovery.found = true;
      }
    });
  }

  visit(
    program,
    createScope(null, 'root'),
    (node, scope, parent, ancestors) => {
      if (isIgnoredNode(node)) {
        return;
      }

      if (isControlStatement(node)) {
        controlStatements.push({ node, parent });
      }

      if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
        replacements.push(
          findFunctionReplacement(ancestors) ?? {
            start: node.start,
            end: node.end,
            kind: 'component',
            value: 'null',
          }
        );
        return;
      }

      if (node.type === 'CallExpression') {
        if (isReactRuntimeCall(node, imports)) {
          const replacement = findFunctionReplacement(ancestors);
          if (replacement) {
            replacements.push(replacement);
          }

          return;
        }

        if (hasHocs && isHocCall(node, hocs, imports)) {
          replacements.push({
            start: node.start,
            end: node.end,
            kind: 'component',
            value: '() => null',
          });
          return;
        }
      }

      if (
        node.type === 'VariableDeclarator' &&
        node.id.type === 'Identifier' &&
        node.init &&
        isComponentTypeMatch(node.id, componentTypes, imports)
      ) {
        replacements.push({
          start: node.init.start,
          end: node.init.end,
          kind: 'component',
          value: '() => null',
        });
        return;
      }

      if (
        node.type === 'UnaryExpression' &&
        node.operator === 'typeof' &&
        node.argument.type === 'Identifier' &&
        ssrCheckFields.has(node.argument.name) &&
        !hasBinding(scope, node.argument.name)
      ) {
        replacements.push({
          start: node.start,
          end: node.end,
          value: '"undefined"',
        });
        return;
      }

      if (node.type === 'MetaProperty') {
        if (
          planningOptions?.preserveImportMetaEnv &&
          ancestors.some((ancestor) => isImportMetaEnv(ancestor))
        ) {
          return;
        }

        replacements.push(removeOwner(node, ancestors));
        return;
      }

      if (
        node.type !== 'Identifier' ||
        isTypeContext(ancestors) ||
        isInsideTypeof(ancestors) ||
        isInsideImportDeclaration(ancestors)
      ) {
        return;
      }

      if (isPropertyOnlyIdentifier(node, parent)) {
        return;
      }

      const isAlwaysForbidden = alwaysForbiddenIdentifiers.has(node.name);
      const bindingKey = getBindingKey(scope, node.name);
      const isDerivedForbidden =
        bindingKey !== null && derivedForbiddenBindings.has(bindingKey);
      const isWindowScoped =
        windowScopedNames.has(node.name) && !hasBinding(scope, node.name);
      const isForbiddenGlobal =
        forbiddenGlobals.has(node.name) && !hasBinding(scope, node.name);

      if (
        !isAlwaysForbidden &&
        !isDerivedForbidden &&
        !isWindowScoped &&
        !isForbiddenGlobal
      ) {
        return;
      }

      if (!isAlwaysForbidden && isInDeferredFunctionScope(ancestors)) {
        return;
      }

      if (hasHocs && isInsideHocCall(ancestors, hocs, imports)) {
        return;
      }

      if (isBindingPosition(node, parent) && !isAlwaysForbidden) {
        return;
      }

      if (
        parent?.type === 'ExportDefaultDeclaration' &&
        parent.declaration === node
      ) {
        return;
      }

      if (
        generatedProcessorHelperNameRe.test(node.name) &&
        hasBinding(scope, node.name)
      ) {
        return;
      }

      const generatedHelperDeclarator = findLastAncestor(
        ancestors,
        (ancestor) =>
          ancestor.type === 'VariableDeclarator' &&
          ancestor.id.type === 'Identifier' &&
          generatedProcessorHelperNameRe.test(ancestor.id.name)
      );
      if (generatedHelperDeclarator) {
        return;
      }

      if (
        parent?.type === 'Property' &&
        parent.value === node &&
        hasBinding(scope, node.name)
      ) {
        return;
      }

      if (parent?.type === 'Property' && parent.value === node) {
        replacements.push({
          start: node.start,
          end: node.end,
          value: parent.shorthand ? `${node.name}: undefined` : 'undefined',
        });
        return;
      }

      const grandparent = ancestors[ancestors.length - 2] ?? null;
      if (
        parent?.type === 'MemberExpression' &&
        parent.object === node &&
        grandparent?.type === 'SpreadElement' &&
        grandparent.argument === parent
      ) {
        replacements.push({
          start: grandparent.start,
          end: grandparent.end,
          value: '...{}',
        });
        return;
      }

      const exportProtection = findExportedBindingProtection(
        node,
        ancestors,
        exportedLocalNames
      );
      if (exportProtection) {
        replacements.push(exportProtection);
        return;
      }

      const promiseOwner = findPromiseCallbackOwner(ancestors);
      replacements.push(removeOwner(promiseOwner ?? node, ancestors));
    }
  );

  return normalizeReplacements(
    removeEmptyControlStatements(
      normalizeReplacements(replacements),
      controlStatements
    )
  );
};
