import type { CallExpression, Expression, Node, Program } from 'oxc-parser';

import {
  visitOxcLexicalScopes,
  type OxcLexicalScopeBoundary,
} from './oxc/lexicalScopes';
import { collectOxcPatternIdentifierNames } from './oxc/patterns';
import { isOxcFunctionLike } from './oxc/runtimeSemantics';
import { getMemberPropertyName, unwrapExpression } from './oxcPreevalSyntax';

/**
 * A `const` binding whose initializer can be folded. `init` is evaluated in
 * `scope`, the lexical scope of the declaration, never in the scope of the
 * reference.
 */
type ConstantBinding = {
  declaredAt: number;
  init: Expression;
  scope: LexicalScope;
};

type LexicalScope = {
  // `null` marks a name declared in this scope whose value is not a foldable
  // constant: `let`/`var`, params, functions, classes, imports, duplicates.
  // It still shadows every outer binding with the same name.
  bindings: Map<string, ConstantBinding | null>;
  functionBoundary: boolean;
  parent: LexicalScope | null;
};

const createScope = (
  parent: LexicalScope | null,
  boundary: OxcLexicalScopeBoundary
): LexicalScope => ({
  bindings: new Map(),
  functionBoundary: boundary.functionBoundary,
  parent,
});

const nearestFunctionScope = (scope: LexicalScope): LexicalScope => {
  let current = scope;
  while (!current.functionBoundary && current.parent) {
    current = current.parent;
  }
  return current;
};

const declareName = (
  scope: LexicalScope,
  name: string,
  binding: ConstantBinding | null
): void => {
  // A second declaration of the same name in one scope (`var` redeclaration,
  // TS namespace merging) makes the value ambiguous.
  scope.bindings.set(name, scope.bindings.has(name) ? null : binding);
};

const declarePattern = (
  scope: LexicalScope,
  pattern: Node | null | undefined
): void => {
  collectOxcPatternIdentifierNames(pattern).forEach((name) =>
    declareName(scope, name, null)
  );
};

const declareVariables = (
  node: Extract<Node, { type: 'VariableDeclaration' }>,
  scope: LexicalScope,
  runtime: boolean
): void => {
  if (node.kind === 'var') {
    node.declarations.forEach((declarator) =>
      declarePattern(nearestFunctionScope(scope), declarator.id)
    );
    return;
  }

  const foldable = runtime && node.kind === 'const' && !node.declare;
  node.declarations.forEach((declarator) => {
    if (foldable && declarator.id.type === 'Identifier' && declarator.init) {
      declareName(scope, declarator.id.name, {
        declaredAt: declarator.end,
        init: declarator.init,
        scope,
      });
      return;
    }

    declarePattern(scope, declarator.id);
  });
};

const declareNode = (
  node: Node,
  scope: LexicalScope,
  runtime: boolean
): void => {
  if (isOxcFunctionLike(node)) {
    // Function-like nodes open their own parameter scope: the expression name
    // and params live there, a declaration name belongs to the parent scope.
    if (node.type === 'FunctionDeclaration' && node.id && scope.parent) {
      declareName(scope.parent, node.id.name, null);
      // Sloppy-mode block functions are also var-scoped (Annex B).
      if (!scope.parent.functionBoundary) {
        declareName(nearestFunctionScope(scope.parent), node.id.name, null);
      }
    } else if (node.type === 'FunctionExpression' && node.id) {
      declareName(scope, node.id.name, null);
    }

    node.params.forEach((param) => declarePattern(scope, param));
    return;
  }

  switch (node.type) {
    case 'VariableDeclaration':
      declareVariables(node, scope, runtime);
      return;
    case 'CatchClause':
      declarePattern(scope, node.param);
      return;
    case 'ClassDeclaration':
    case 'ClassExpression':
    case 'TSEnumDeclaration':
    case 'TSImportEqualsDeclaration':
    case 'TSModuleDeclaration':
      if (node.id?.type === 'Identifier') {
        declareName(scope, node.id.name, null);
      }
      return;
    case 'ImportDeclaration':
      node.specifiers.forEach((specifier) =>
        declareName(scope, specifier.local.name, null)
      );
      break;
    default:
      break;
  }
};

const resolveConstant = (
  name: string,
  position: number,
  scope: LexicalScope
): ConstantBinding | null => {
  let current: LexicalScope | null = scope;
  let deferred = false;
  while (current) {
    if (current.bindings.has(name)) {
      const binding = current.bindings.get(name) ?? null;
      // Without a function boundary between the reference and the
      // declaration, a read before the declarator runs hits the TDZ.
      return binding && (deferred || position >= binding.declaredAt)
        ? binding
        : null;
    }

    deferred = deferred || current.functionBoundary;
    current = current.parent;
  }

  return null;
};

const isConcatenable = (value: unknown): value is string | number =>
  typeof value === 'string' || typeof value === 'number';

const evaluateStaticValue = (
  node: Expression,
  scope: LexicalScope,
  seen: Set<ConstantBinding>
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
      if (nextExpression) {
        const value = evaluateStaticValue(nextExpression, scope, seen);
        if (!isConcatenable(value)) {
          return undefined;
        }

        result += String(value);
      }
    }

    return result;
  }

  if (expression.type === 'Identifier') {
    const binding = resolveConstant(expression.name, expression.start, scope);
    if (!binding || seen.has(binding)) {
      return undefined;
    }

    seen.add(binding);
    const value = evaluateStaticValue(binding.init, binding.scope, seen);
    seen.delete(binding);
    return value;
  }

  if (expression.type === 'BinaryExpression' && expression.operator === '+') {
    const left = evaluateStaticValue(expression.left, scope, seen);
    const right = evaluateStaticValue(expression.right, scope, seen);

    if (typeof left === 'number' && typeof right === 'number') {
      return left + right;
    }

    if (isConcatenable(left) && isConcatenable(right)) {
      return `${left}${right}`;
    }

    return undefined;
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
    if (typeof objectValue !== 'string' || !propertyName) {
      return undefined;
    }

    if (expression.arguments.length === 0) {
      if (propertyName === 'toLowerCase') {
        return objectValue.toLowerCase();
      }

      if (propertyName === 'toUpperCase') {
        return objectValue.toUpperCase();
      }

      if (propertyName === 'trim') {
        return objectValue.trim();
      }
    }

    if (propertyName === 'concat') {
      const args = expression.arguments.map((argument) =>
        argument.type === 'SpreadElement'
          ? undefined
          : evaluateStaticValue(argument, scope, seen)
      );
      if (!args.every(isConcatenable)) {
        return undefined;
      }

      return objectValue.concat(...args.map((value) => String(value)));
    }
  }

  return undefined;
};

/**
 * Statically evaluates the first argument of each `require(...)` call.
 *
 * Identifiers fold only through `const` bindings, resolved lexically from the
 * call site and evaluated in the scope of their declaration. Any shadowing
 * declaration that is not a foldable `const` makes the specifier unknown, so
 * a call is absent from the result instead of folding to a wrong constant.
 */
export const evaluateOxcRequireSpecifiers = (
  program: Program,
  calls: readonly CallExpression[]
): Map<CallExpression, string> => {
  const pending = new Set<Node>(calls);
  const callScopes = new Map<CallExpression, LexicalScope>();

  visitOxcLexicalScopes<LexicalScope>(
    program,
    null,
    createScope,
    (node, scope, _parent, _ancestors, runtime) => {
      declareNode(node, scope, runtime);
      if (pending.has(node)) {
        callScopes.set(node as CallExpression, scope);
      }
    }
  );

  const specifiers = new Map<CallExpression, string>();
  callScopes.forEach((scope, call) => {
    const [firstArg] = call.arguments;
    if (!firstArg || firstArg.type === 'SpreadElement') {
      return;
    }

    const value = evaluateStaticValue(firstArg, scope, new Set());
    if (typeof value === 'string') {
      specifiers.set(call, value);
    }
  });

  return specifiers;
};
