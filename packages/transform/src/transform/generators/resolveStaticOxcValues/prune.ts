/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { ImportDeclaration, Node, Program } from 'oxc-parser';

import { getOxcNodeChildren } from '../../../utils/oxc/ast';
import { applyOxcEdits, type OxcEdit } from '../../../utils/oxc/fileEdits';
import { parseProgram } from './environment';
import { collectImportBindings, unwrapExpression } from './staticExpression';
import {
  findWYWMetaExtendsExpression,
  staticWYWMetaExtendsReplacementCode,
} from './processorStaticModel';
import type { Range } from './types';

export const isIdentifierBindingPosition = (
  node: Node,
  parent: Node | null
): boolean => {
  if (node.type !== 'Identifier' || !parent) {
    return false;
  }

  if (
    (parent.type === 'VariableDeclarator' && parent.id === node) ||
    (parent.type === 'FunctionDeclaration' && parent.id === node) ||
    (parent.type === 'FunctionExpression' && parent.id === node) ||
    (parent.type === 'ClassDeclaration' && parent.id === node) ||
    (parent.type === 'ClassExpression' && parent.id === node)
  ) {
    return true;
  }

  if (
    (parent.type === 'ArrowFunctionExpression' ||
      parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression') &&
    parent.params.some((param) => param === node)
  ) {
    return true;
  }

  return (
    (parent.type === 'ImportSpecifier' && parent.local === node) ||
    (parent.type === 'ImportDefaultSpecifier' && parent.local === node) ||
    (parent.type === 'ImportNamespaceSpecifier' && parent.local === node)
  );
};

export const isPropertyKeyOnlyIdentifier = (
  node: Node,
  parent: Node | null
): boolean =>
  node.type === 'Identifier' &&
  !!parent &&
  ((parent.type === 'MemberExpression' &&
    parent.property === node &&
    !parent.computed) ||
    (parent.type === 'Property' &&
      parent.key === node &&
      !parent.computed &&
      !parent.shorthand));

export const collectUsedIdentifierNames = (program: Program): Set<string> => {
  const used = new Set<string>();

  const walk = (node: Node, parent: Node | null): void => {
    if (node.type === 'ImportDeclaration') {
      return;
    }

    if (
      node.type === 'Identifier' &&
      !isIdentifierBindingPosition(node, parent) &&
      !isPropertyKeyOnlyIdentifier(node, parent)
    ) {
      used.add(node.name);
    }

    getOxcNodeChildren(node).forEach((child) => walk(child, node));
  };

  walk(program, null);
  return used;
};

export const removableStaticHelperNames = (
  program: Program,
  staticValueNames: Set<string>
): Set<string> => {
  const used = collectUsedIdentifierNames(program);
  const result = new Set<string>();

  program.body.forEach((statement) => {
    if (statement.type !== 'VariableDeclaration') {
      return;
    }

    statement.declarations.forEach((declarator) => {
      if (
        declarator.id.type === 'Identifier' &&
        staticValueNames.has(declarator.id.name) &&
        !used.has(declarator.id.name)
      ) {
        result.add(declarator.id.name);
      }
    });
  });

  return result;
};

export const collectImportLocalReferences = (
  node: Node,
  importLocals: Set<string>,
  result: Set<string>
): void => {
  const walk = (item: Node, parent: Node | null): void => {
    if (
      item.type === 'Identifier' &&
      importLocals.has(item.name) &&
      !isIdentifierBindingPosition(item, parent) &&
      !isPropertyKeyOnlyIdentifier(item, parent)
    ) {
      result.add(item.name);
    }

    getOxcNodeChildren(item).forEach((child) => walk(child, item));
  };

  walk(node, null);
};
export const removeStaticHelperDeclarations = (
  code: string,
  filename: string,
  staticValueNames: Set<string>
): { code: string; removed: Set<string>; removedImportLocals: Set<string> } => {
  if (staticValueNames.size === 0) {
    return { code, removed: new Set(), removedImportLocals: new Set() };
  }

  const program = parseProgram(code, filename);
  const removableNames = removableStaticHelperNames(program, staticValueNames);
  const importLocals = new Set<string>();
  collectImportBindings(program).forEach((_, local) => importLocals.add(local));
  const removedImportLocals = new Set<string>();
  const ranges: Range[] = [];
  const replacements: OxcEdit[] = [];

  program.body.forEach((statement) => {
    if (
      statement.type !== 'VariableDeclaration' ||
      statement.declarations.length === 0
    ) {
      return;
    }

    const removableIndexes = statement.declarations.flatMap(
      (declarator, index) =>
        declarator.id.type === 'Identifier' &&
        removableNames.has(declarator.id.name)
          ? [index]
          : []
    );
    if (removableIndexes.length === 0) {
      return;
    }

    removableIndexes.forEach((index) => {
      collectImportLocalReferences(
        statement.declarations[index],
        importLocals,
        removedImportLocals
      );
    });

    if (removableIndexes.length === statement.declarations.length) {
      ranges.push({
        end: statement.end,
        start: statement.start,
      });
      return;
    }

    const keptDeclarations = statement.declarations
      .filter((_, index) => !removableIndexes.includes(index))
      .map((declarator) => code.slice(declarator.start, declarator.end));
    replacements.push({
      end: statement.end,
      start: statement.start,
      value: `${statement.kind} ${keptDeclarations.join(', ')};`,
    });
  });

  return {
    code: applyOxcEdits(code, [
      ...ranges.map((range) => ({ ...range, value: '' })),
      ...replacements,
    ]),
    removed: removableNames,
    removedImportLocals,
  };
};

export const importSpecifierLocalName = (
  specifier: ImportDeclaration['specifiers'][number]
): string | null => specifier.local?.name ?? null;

export const removeUnusedStaticImports = (
  code: string,
  filename: string,
  staticImportLocals: Set<string>,
  sideEffectImportLocals: Set<string>,
  sideEffectImportOrderLocals: Set<string> = sideEffectImportLocals
): string => {
  if (staticImportLocals.size === 0) {
    return code;
  }

  const program = parseProgram(code, filename);
  const used = collectUsedIdentifierNames(program);
  const ranges: Range[] = [];
  const replacements: OxcEdit[] = [];
  const importSourceByLocal = new Map<string, string>();
  const removedSideEffectImportRanges: Range[] = [];
  const keptImportRangesBySource = new Map<string, Range>();

  program.body.forEach((statement) => {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.specifiers.length === 0
    ) {
      return;
    }

    const source = code.slice(statement.source.start, statement.source.end);
    const orderedLocalNames = statement.specifiers.flatMap((specifier) => {
      const localName = importSpecifierLocalName(specifier);
      return localName && sideEffectImportOrderLocals.has(localName)
        ? [localName]
        : [];
    });
    const sideEffectLocalNames = statement.specifiers.flatMap((specifier) => {
      const localName = importSpecifierLocalName(specifier);
      return localName && sideEffectImportLocals.has(localName)
        ? [localName]
        : [];
    });
    [...orderedLocalNames, ...sideEffectLocalNames].forEach((localName) => {
      importSourceByLocal.set(localName, source);
    });

    const removable = statement.specifiers.flatMap((specifier, index) => {
      const localName = importSpecifierLocalName(specifier);
      return localName &&
        staticImportLocals.has(localName) &&
        !used.has(localName)
        ? [{ index, localName }]
        : [];
    });

    if (removable.length === 0) {
      if (
        orderedLocalNames.length > 0 &&
        !keptImportRangesBySource.has(source)
      ) {
        keptImportRangesBySource.set(source, {
          end: statement.end,
          start: statement.start,
        });
      }
      return;
    }

    if (removable.length === statement.specifiers.length) {
      if (
        removable.some((item) => sideEffectImportLocals.has(item.localName))
      ) {
        removedSideEffectImportRanges.push({
          end: statement.end,
          start: statement.start,
        });
        return;
      }

      ranges.push({
        end: statement.end,
        start: statement.start,
      });
      return;
    }

    if (orderedLocalNames.length > 0 && !keptImportRangesBySource.has(source)) {
      keptImportRangesBySource.set(source, {
        end: statement.end,
        start: statement.start,
      });
    }
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

      replacements.push({
        end: position,
        start: position,
        value: `${pendingImports.join('\n')}\n`,
      });
      pendingImports.length = 0;
    };

    [...sideEffectImportOrderLocals].forEach((local) => {
      const source = importSourceByLocal.get(local);
      if (!source) {
        return;
      }

      const keptRange = keptImportRangesBySource.get(source);
      if (keptRange) {
        flushBefore(keptRange.start);
        insertionAfterLastKept = keptRange.end;
        if (sideEffectImportLocals.has(local)) {
          seenSources.add(source);
        }
        return;
      }

      if (!sideEffectImportLocals.has(local) || seenSources.has(source)) {
        return;
      }

      seenSources.add(source);
      pendingImports.push(`import ${source};`);
    });

    if (pendingImports.length > 0) {
      if (insertionAfterLastKept !== null) {
        replacements.push({
          end: insertionAfterLastKept,
          start: insertionAfterLastKept,
          value: `\n${pendingImports.join('\n')}`,
        });
      } else if (firstRemoved) {
        usedFirstRemovedRange = true;
        replacements.push({
          end: firstRemoved.end,
          start: firstRemoved.start,
          value: pendingImports.join('\n'),
        });
      }
    }

    ranges.push(...(usedFirstRemovedRange ? restRemoved : removedRanges));
  }

  if (ranges.length > 1) {
    ranges.sort((a, b) => a.start - b.start);
  }

  return applyOxcEdits(code, [
    ...ranges.map((range) => ({ ...range, value: '' })),
    ...replacements,
  ]);
};

export const replaceStaticWYWMetaExtendsHelpers = (
  code: string,
  filename: string,
  helperValues: Map<string, unknown>
): string => {
  if (helperValues.size === 0) {
    return code;
  }

  const program = parseProgram(code, filename);
  const replacements: OxcEdit[] = [];

  const visit = (node: Node): void => {
    if (node.type === 'ObjectExpression') {
      const extendsExpression = findWYWMetaExtendsExpression(node);
      if (extendsExpression) {
        const unwrapped = unwrapExpression(extendsExpression);
        if (
          unwrapped.type === 'CallExpression' &&
          unwrapped.callee.type === 'Identifier' &&
          unwrapped.arguments.length === 0 &&
          helperValues.has(unwrapped.callee.name)
        ) {
          const replacement = staticWYWMetaExtendsReplacementCode(
            helperValues.get(unwrapped.callee.name)
          );
          if (replacement) {
            replacements.push({
              end: extendsExpression.end,
              start: extendsExpression.start,
              value: replacement,
            });
          }
        }
      }
    }

    getOxcNodeChildren(node).forEach(visit);
  };

  visit(program);
  return applyOxcEdits(code, replacements);
};

export const pruneStaticPreevalCode = (
  code: string,
  filename: string,
  staticValueNames: Set<string>,
  staticImportLocals: Set<string>,
  staticExtendsHelperValues: Map<string, unknown>,
  sideEffectImportLocals: Set<string>
): string => {
  const codeWithMetadataPruned = replaceStaticWYWMetaExtendsHelpers(
    code,
    filename,
    staticExtendsHelperValues
  );
  const helpersRemoved = removeStaticHelperDeclarations(
    codeWithMetadataPruned,
    filename,
    staticValueNames
  );
  if (helpersRemoved.removed.size === 0) {
    return codeWithMetadataPruned;
  }

  const importLocalsToPrune = new Set([
    ...staticImportLocals,
    ...helpersRemoved.removedImportLocals,
  ]);

  return removeUnusedStaticImports(
    helpersRemoved.code,
    filename,
    importLocalsToPrune,
    sideEffectImportLocals,
    new Set([...staticImportLocals, ...sideEffectImportLocals])
  );
};
