// Structural shapes so the same predicate serves Oxc programs and the
// Babel-shaped ASTs that custom evaluators hand back.
type ImportSpecifierLike = {
  importKind?: string | null;
  type: string;
};

type ImportDeclarationLike = {
  importKind?: string | null;
  specifiers: readonly ImportSpecifierLike[];
};

/**
 * Whether the specifier binds only a type: either the whole declaration is
 * `import type …`, or the specifier itself is `import { type A }`.
 */
export const isTypeOnlyImportSpecifier = (
  declaration: Pick<ImportDeclarationLike, 'importKind'>,
  specifier: ImportSpecifierLike
): boolean =>
  declaration.importKind === 'type' ||
  (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type');

/**
 * Whether TypeScript erases the whole import declaration, so it neither
 * binds a runtime value nor runs the imported module.
 *
 * `import './polyfill'` and `import {} from './polyfill'` have no specifiers
 * but still run the module, so an empty specifier list is a side-effect import
 * rather than a type-only one.
 */
export const isTypeOnlyImport = (declaration: ImportDeclarationLike): boolean =>
  declaration.importKind === 'type' ||
  (declaration.specifiers.length > 0 &&
    declaration.specifiers.every((specifier) =>
      isTypeOnlyImportSpecifier(declaration, specifier)
    ));
