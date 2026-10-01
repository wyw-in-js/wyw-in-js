/* eslint-disable no-continue, no-plusplus, no-nested-ternary, @typescript-eslint/no-use-before-define */
import { oxcShaker } from '../shaker';
import { analyzeOxcBarrelFile } from '../transform/oxcBarrelManifest';
import type { Services } from '../transform/types';

import { isEvalOnlyKey } from './brokerCache';
import type { PreparedModule } from './prepareModuleOnDemand';

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/u;

type DirectBarrelBinding =
  | {
      kind: 'named';
      imported: string;
      source: string;
    }
  | {
      kind: 'namespace';
      source: string;
    };

type ModuleNameNode =
  | { type: 'Identifier'; name: string }
  | { type: 'StringLiteral'; value: string };

type ModuleSpecifierNode = {
  exportKind?: string | null;
  exported: ModuleNameNode;
  imported: ModuleNameNode;
  importKind?: string | null;
  local: ModuleNameNode & { name: string };
  type: string;
};

type ModuleStatement = {
  declaration: { name: string; type: string };
  exportKind?: string | null;
  importKind?: string | null;
  source: { value: string };
  specifiers: ModuleSpecifierNode[];
  type: string;
};

type ParsedModuleAst = {
  program: {
    body: ModuleStatement[];
  };
};

const isTypeOnlyImport = (statement: ModuleStatement): boolean => {
  if (statement.type !== 'ImportDeclaration') {
    return false;
  }

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

const isTypeOnlyExport = (statement: ModuleStatement): boolean =>
  statement.exportKind === 'type';

const getModuleExportName = (node: ModuleNameNode): string =>
  node.type === 'Identifier' ? node.name : node.value;

const getImportSpecifierName = (specifier: ModuleSpecifierNode): string =>
  getModuleExportName(specifier.imported);

export const buildDirectBarrelProxy = (
  services: Services,
  id: string,
  only: string[]
): PreparedModule | null => {
  const requested = only.filter((key) => !isEvalOnlyKey(key));
  if (requested.length === 0 || requested.includes('*')) {
    return null;
  }

  const loadedAndParsed = services.loadAndParseFn(
    services,
    id,
    undefined,
    services.log
  );

  if (
    loadedAndParsed.evaluator === 'ignored' ||
    loadedAndParsed.ast === undefined
  ) {
    return null;
  }

  if (loadedAndParsed.evaluator === oxcShaker) {
    return buildDirectOxcBarrelProxy(id, loadedAndParsed.code, only);
  }

  const importedBindings = new Map<string, DirectBarrelBinding>();
  const exportedBindings = new Map<string, DirectBarrelBinding>();
  const ast = loadedAndParsed.ast as unknown as ParsedModuleAst;

  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration') {
      if (isTypeOnlyImport(statement)) {
        continue;
      }

      if (statement.specifiers.length === 0) {
        return null;
      }

      for (const specifier of statement.specifiers) {
        if (
          specifier.type === 'ImportSpecifier' &&
          specifier.importKind === 'type'
        ) {
          continue;
        }

        if (specifier.type === 'ImportSpecifier') {
          importedBindings.set(specifier.local.name, {
            kind: 'named',
            imported: getImportSpecifierName(specifier),
            source: statement.source.value,
          });
          continue;
        }

        if (specifier.type === 'ImportDefaultSpecifier') {
          importedBindings.set(specifier.local.name, {
            kind: 'named',
            imported: 'default',
            source: statement.source.value,
          });
          continue;
        }

        importedBindings.set(specifier.local.name, {
          kind: 'namespace',
          source: statement.source.value,
        });
      }

      continue;
    }

    if (statement.type === 'ExportNamedDeclaration') {
      if (isTypeOnlyExport(statement)) {
        continue;
      }

      if (statement.source) {
        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ExportSpecifier') {
            if (specifier.exportKind === 'type') {
              continue;
            }

            exportedBindings.set(getModuleExportName(specifier.exported), {
              kind: 'named',
              imported: getModuleExportName(specifier.local),
              source: statement.source.value,
            });
            continue;
          }

          if (specifier.type === 'ExportDefaultSpecifier') {
            exportedBindings.set(getModuleExportName(specifier.exported), {
              kind: 'named',
              imported: 'default',
              source: statement.source.value,
            });
            continue;
          }

          if (specifier.type === 'ExportNamespaceSpecifier') {
            exportedBindings.set(getModuleExportName(specifier.exported), {
              kind: 'namespace',
              source: statement.source.value,
            });
            continue;
          }

          return null;
        }

        continue;
      }

      if (statement.declaration) {
        return null;
      }

      for (const specifier of statement.specifiers) {
        if (
          specifier.type !== 'ExportSpecifier' ||
          specifier.exportKind === 'type'
        ) {
          return null;
        }

        if (specifier.local.type !== 'Identifier') {
          return null;
        }

        const binding = importedBindings.get(specifier.local.name);
        if (!binding) {
          return null;
        }

        exportedBindings.set(getModuleExportName(specifier.exported), binding);
      }

      continue;
    }

    if (statement.type === 'ExportDefaultDeclaration') {
      if (statement.declaration.type !== 'Identifier') {
        return null;
      }

      const binding = importedBindings.get(statement.declaration.name);
      if (!binding || binding.kind !== 'named') {
        return null;
      }

      exportedBindings.set('default', binding);
      continue;
    }

    if (
      statement.type === 'EmptyStatement' ||
      statement.type === 'TSDeclareFunction' ||
      statement.type === 'TSInterfaceDeclaration' ||
      statement.type === 'TSTypeAliasDeclaration'
    ) {
      continue;
    }

    return null;
  }

  const imports = new Map<string, string[]>();
  const lines: string[] = [];
  let namespaceIdx = 0;

  const addImport = (source: string, imported: string) => {
    if (!imports.has(source)) {
      imports.set(source, []);
    }

    const bucket = imports.get(source)!;
    if (!bucket.includes(imported)) {
      bucket.push(imported);
    }
  };

  for (const exported of requested) {
    const binding = exportedBindings.get(exported);
    if (!binding) {
      return null;
    }

    if (binding.kind === 'namespace') {
      if (exported === 'default' || !IDENTIFIER_RE.test(exported)) {
        return null;
      }

      const local = `__wyw_ns_${namespaceIdx++}`;
      lines.push(
        `import * as ${local} from ${JSON.stringify(binding.source)};`
      );
      lines.push(`export { ${local} as ${exported} };`);
      addImport(binding.source, '*');
      continue;
    }

    if (
      binding.imported !== 'default' &&
      !IDENTIFIER_RE.test(binding.imported)
    ) {
      return null;
    }

    if (exported !== 'default' && !IDENTIFIER_RE.test(exported)) {
      return null;
    }

    const imported =
      binding.imported === 'default' ? 'default' : binding.imported;
    const exportClause =
      exported === 'default'
        ? `${imported} as default`
        : imported === exported
        ? imported
        : `${imported} as ${exported}`;

    lines.push(
      `export { ${exportClause} } from ${JSON.stringify(binding.source)};`
    );
    addImport(binding.source, binding.imported);
  }

  if (lines.length === 0) {
    return null;
  }

  return {
    code: `${lines.join('\n')}\n`,
    imports,
    only,
  };
};

const buildDirectOxcBarrelProxy = (
  id: string,
  code: string,
  only: string[]
): PreparedModule | null => {
  const requested = only.filter((key) => !isEvalOnlyKey(key));
  const analyzed = analyzeOxcBarrelFile(code, id);
  if (!('reexports' in analyzed)) {
    return null;
  }

  const imports = new Map<string, string[]>();
  const lines: string[] = [];
  let namespaceIdx = 0;

  const addImport = (source: string, imported: string) => {
    if (!imports.has(source)) {
      imports.set(source, []);
    }

    const bucket = imports.get(source)!;
    if (!bucket.includes(imported)) {
      bucket.push(imported);
    }
  };

  for (const exported of requested) {
    const binding = analyzed.reexports.find(
      (reexport) => reexport.exported === exported
    );
    if (!binding) {
      return null;
    }

    if (binding.kind === 'namespace') {
      if (exported === 'default' || !IDENTIFIER_RE.test(exported)) {
        return null;
      }

      const local = `__wyw_ns_${namespaceIdx++}`;
      lines.push(
        `import * as ${local} from ${JSON.stringify(binding.source)};`
      );
      lines.push(`export { ${local} as ${exported} };`);
      addImport(binding.source, '*');
      continue;
    }

    if (
      binding.imported !== 'default' &&
      !IDENTIFIER_RE.test(binding.imported)
    ) {
      return null;
    }

    if (exported !== 'default' && !IDENTIFIER_RE.test(exported)) {
      return null;
    }

    const imported =
      binding.imported === 'default' ? 'default' : binding.imported;
    const exportClause =
      exported === 'default'
        ? `${imported} as default`
        : imported === exported
        ? imported
        : `${imported} as ${exported}`;

    lines.push(
      `export { ${exportClause} } from ${JSON.stringify(binding.source)};`
    );
    addImport(binding.source, binding.imported);
  }

  if (lines.length === 0) {
    return null;
  }

  return {
    code: `${lines.join('\n')}\n`,
    imports,
    only,
  };
};
