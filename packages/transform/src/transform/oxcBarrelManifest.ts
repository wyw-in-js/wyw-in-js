/* eslint-disable no-continue, @typescript-eslint/no-use-before-define */
import type {
  BindingPattern,
  ExportAllDeclaration,
  ExportNamedDeclaration,
  ExportSpecifier,
  ImportDeclaration,
  ModuleExportName,
  Node,
  Program,
  Statement,
  VariableDeclaration,
} from 'oxc-parser';

import { recordPipelineUncachedParse } from '../debug/pipelineTelemetry';
import { parseOxcSync } from '../utils/parseOxc';

import type {
  BarrelManifestCacheEntry,
  RawBarrelManifest,
  RawBarrelReexport,
} from './barrelManifest.types';

type LocalImportBinding =
  | {
      imported: string;
      kind: 'named';
      source: string;
    }
  | {
      kind: 'namespace';
      source: string;
    };

type AnyNode = Node & Record<string, unknown>;

const nameFromModuleExport = (node: ModuleExportName): string =>
  node.type === 'Literal' ? String(node.value) : node.name;

const isTypeOnlyImport = (statement: ImportDeclaration): boolean => {
  if (statement.importKind === 'type') {
    return true;
  }

  if (statement.specifiers.length === 0) {
    return false;
  }

  return statement.specifiers.every(
    (specifier) =>
      specifier.type === 'ImportSpecifier' && specifier.importKind === 'type'
  );
};

const isTypeOnlyExport = (
  statement: ExportAllDeclaration | ExportNamedDeclaration | ExportSpecifier
): boolean => 'exportKind' in statement && statement.exportKind === 'type';

const isTypeOnlyStatement = (statement: Statement): boolean => {
  switch (statement.type) {
    case 'EmptyStatement':
    case 'TSDeclareFunction':
    case 'TSInterfaceDeclaration':
    case 'TSTypeAliasDeclaration':
      return true;
    default:
      return false;
  }
};

const getChildren = (node: Node): { key: string; node: Node }[] => {
  const result: { key: string; node: Node }[] = [];
  const record = node as AnyNode;

  Object.keys(record).forEach((key) => {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'range') {
      return;
    }

    const value = record[key];
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach((item) => {
          if (item && typeof item === 'object' && 'type' in item) {
            result.push({ key, node: item as Node });
          }
        });
        return;
      }

      if ('type' in value) {
        result.push({ key, node: value as Node });
      }
    }
  });

  return result;
};

const collectBindingNames = (
  pattern: BindingPattern | Node | null | undefined
): string[] => {
  if (!pattern) {
    return [];
  }

  if (pattern.type === 'Identifier') {
    return [pattern.name];
  }

  if (pattern.type === 'RestElement') {
    return collectBindingNames(pattern.argument);
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
    return pattern.elements.flatMap((element) => collectBindingNames(element));
  }

  return [];
};

const getLocalDeclarationNames = (
  declaration: ExportNamedDeclaration['declaration']
): string[] | null => {
  if (!declaration) {
    return [];
  }

  if (declaration.type === 'VariableDeclaration') {
    return (declaration as VariableDeclaration).declarations.flatMap(
      (declarator) => collectBindingNames(declarator.id)
    );
  }

  if (
    (declaration.type === 'FunctionDeclaration' ||
      declaration.type === 'ClassDeclaration') &&
    declaration.id
  ) {
    return [declaration.id.name];
  }

  if (
    declaration.type === 'TSEnumDeclaration' ||
    declaration.type === 'TSModuleDeclaration'
  ) {
    return null;
  }

  return [];
};

const collectImportBinding = (
  statement: ImportDeclaration,
  imports: Map<string, LocalImportBinding>
): boolean => {
  if (statement.importKind === 'type') {
    return true;
  }

  if (statement.specifiers.length === 0) {
    return false;
  }

  let sawValueImport = false;
  for (const specifier of statement.specifiers) {
    if (
      specifier.type === 'ImportSpecifier' &&
      specifier.importKind === 'type'
    ) {
      continue;
    }

    sawValueImport = true;

    if (specifier.type === 'ImportSpecifier') {
      imports.set(specifier.local.name, {
        imported: nameFromModuleExport(specifier.imported),
        kind: 'named',
        source: statement.source.value,
      });
      continue;
    }

    if (specifier.type === 'ImportDefaultSpecifier') {
      imports.set(specifier.local.name, {
        imported: 'default',
        kind: 'named',
        source: statement.source.value,
      });
      continue;
    }

    imports.set(specifier.local.name, {
      kind: 'namespace',
      source: statement.source.value,
    });
  }

  return sawValueImport || isTypeOnlyImport(statement);
};

const getNamedReexport = (
  specifier: ExportSpecifier,
  source: string
): RawBarrelReexport => ({
  exported: nameFromModuleExport(specifier.exported),
  imported: nameFromModuleExport(specifier.local),
  kind: 'named',
  source,
});

const collectExportNamedDeclaration = (
  statement: ExportNamedDeclaration,
  reexports: RawBarrelReexport[],
  explicitExports: Set<string>
): boolean => {
  if (!statement.source) {
    return isTypeOnlyExport(statement);
  }

  if (isTypeOnlyExport(statement)) {
    return true;
  }

  const source = statement.source.value;
  for (const specifier of statement.specifiers) {
    if (specifier.type !== 'ExportSpecifier') {
      return false;
    }

    if (specifier.exportKind === 'type') {
      continue;
    }

    explicitExports.add(nameFromModuleExport(specifier.exported));
    reexports.push(getNamedReexport(specifier, source));
  }

  return statement.specifiers.length > 0;
};

const collectLocalExportNamedDeclaration = (
  statement: ExportNamedDeclaration,
  importedBindings: Map<string, LocalImportBinding>,
  passthroughCandidates: Map<string, string[]>,
  explicitExports: Set<string>
): { complete: boolean; ok: boolean } => {
  let complete = true;

  if (isTypeOnlyExport(statement)) {
    return {
      complete: true,
      ok: true,
    };
  }

  if (statement.declaration) {
    const names = getLocalDeclarationNames(statement.declaration);
    if (names === null) {
      return {
        complete: false,
        ok: false,
      };
    }

    names.forEach((name) => explicitExports.add(name));

    return {
      complete: names.length === 0,
      ok: true,
    };
  }

  for (const specifier of statement.specifiers) {
    if (specifier.type !== 'ExportSpecifier') {
      return {
        complete: false,
        ok: false,
      };
    }

    if (specifier.exportKind === 'type') {
      continue;
    }

    const exported = nameFromModuleExport(specifier.exported);
    explicitExports.add(exported);

    if (specifier.local.type !== 'Identifier') {
      complete = false;
      continue;
    }

    if (!importedBindings.has(specifier.local.name)) {
      complete = false;
      continue;
    }

    if (!passthroughCandidates.has(specifier.local.name)) {
      passthroughCandidates.set(specifier.local.name, []);
    }
    passthroughCandidates.get(specifier.local.name)!.push(exported);
  }

  return {
    complete: complete && statement.specifiers.length > 0,
    ok: true,
  };
};

const isBindingIdentifier = (
  node: Node,
  parent: Node | null,
  key: string
): boolean => {
  if (!parent) {
    return false;
  }

  if (
    (parent.type === 'ImportSpecifier' ||
      parent.type === 'ImportDefaultSpecifier' ||
      parent.type === 'ImportNamespaceSpecifier') &&
    key === 'local'
  ) {
    return true;
  }

  if (parent.type === 'VariableDeclarator' && key === 'id') {
    return true;
  }

  if (
    (parent.type === 'FunctionDeclaration' ||
      parent.type === 'ClassDeclaration') &&
    key === 'id'
  ) {
    return true;
  }

  return false;
};

const countBindingReferences = (
  node: Node,
  names: Set<string>,
  counts: Map<string, number>,
  parent: Node | null = null,
  key = ''
): void => {
  if (node.type === 'ImportDeclaration' || node.type.startsWith('TS')) {
    return;
  }

  if (
    node.type === 'Identifier' &&
    names.has(node.name) &&
    !isBindingIdentifier(node, parent, key) &&
    !(parent?.type === 'ExportSpecifier' && key === 'exported') &&
    !(parent?.type === 'Property' && parent.key === node && !parent.computed)
  ) {
    counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
  }

  getChildren(node).forEach((child) =>
    countBindingReferences(child.node, names, counts, node, child.key)
  );
};

const collectPassthroughReexports = (
  program: Program,
  importedBindings: Map<string, LocalImportBinding>,
  passthroughCandidates: Map<string, string[]>,
  reexports: RawBarrelReexport[]
): { complete: boolean; ok: boolean } => {
  let complete = true;
  const candidateNames = new Set(passthroughCandidates.keys());
  const bindingReferenceCounts = new Map<string, number>();

  countBindingReferences(program, candidateNames, bindingReferenceCounts);

  for (const [localName, exportedNames] of passthroughCandidates) {
    if ((bindingReferenceCounts.get(localName) ?? 0) !== exportedNames.length) {
      complete = false;
      continue;
    }

    const imported = importedBindings.get(localName)!;
    for (const exported of exportedNames) {
      if (imported.kind === 'namespace') {
        reexports.push({
          exported,
          kind: 'namespace',
          source: imported.source,
        });
        continue;
      }

      reexports.push({
        exported,
        imported: imported.imported,
        kind: 'named',
        source: imported.source,
      });
    }
  }

  return {
    complete,
    ok: true,
  };
};

const parseProgram = (code: string, filename: string): Program => {
  const astType =
    filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'ts' : 'js';
  let parsed: ReturnType<typeof parseOxcSync>;
  try {
    parsed = parseOxcSync(filename, code, {
      astType,
      range: true,
      sourceType: 'module',
    });
  } catch (error) {
    recordPipelineUncachedParse(filename, code, 'module', astType, true);
    throw error;
  }
  const fatalError = parsed.errors.find((error) => error.severity === 'Error');
  if (fatalError) {
    recordPipelineUncachedParse(filename, code, 'module', astType, true);
    throw new Error(fatalError.message);
  }
  recordPipelineUncachedParse(filename, code, 'module', astType, false);

  return parsed.program as Program;
};

const analyzeBarrelProgram = (program: Program): RawBarrelManifest | null => {
  const reexports: RawBarrelReexport[] = [];
  const explicitExports = new Set<string>();
  const exportAll: string[] = [];
  const importedBindings = new Map<string, LocalImportBinding>();
  const passthroughCandidates = new Map<string, string[]>();
  let complete = true;

  for (const statement of program.body as Statement[]) {
    if (statement.type === 'ImportDeclaration') {
      if (!collectImportBinding(statement, importedBindings)) {
        return null;
      }
      continue;
    }

    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.source) {
        if (
          !collectExportNamedDeclaration(statement, reexports, explicitExports)
        ) {
          return null;
        }
        continue;
      }

      const localResult = collectLocalExportNamedDeclaration(
        statement,
        importedBindings,
        passthroughCandidates,
        explicitExports
      );
      if (!localResult.ok) {
        return null;
      }
      complete = complete && localResult.complete;
      continue;
    }

    if (statement.type === 'ExportAllDeclaration') {
      if (isTypeOnlyExport(statement)) {
        continue;
      }

      if (statement.exported) {
        explicitExports.add(nameFromModuleExport(statement.exported));
        reexports.push({
          exported: nameFromModuleExport(statement.exported),
          kind: 'namespace',
          source: statement.source.value,
        });
        continue;
      }

      exportAll.push(statement.source.value);
      continue;
    }

    if (statement.type === 'ExportDefaultDeclaration') {
      return null;
    }

    if (!isTypeOnlyStatement(statement)) {
      return null;
    }
  }

  const passthroughResult = collectPassthroughReexports(
    program,
    importedBindings,
    passthroughCandidates,
    reexports
  );
  if (!passthroughResult.ok) {
    return null;
  }
  complete = complete && passthroughResult.complete;

  if (reexports.length === 0 && exportAll.length === 0) {
    return null;
  }

  return {
    complete,
    explicitExports: [...explicitExports],
    exportAll,
    kind: 'barrel',
    reexports,
  };
};

export function analyzeOxcBarrelFile(
  code: string,
  filename: string
): BarrelManifestCacheEntry | RawBarrelManifest {
  const result = analyzeBarrelProgram(parseProgram(code, filename));

  if (!result) {
    return {
      kind: 'ineligible',
      reason: 'impure',
    };
  }

  return result;
}
