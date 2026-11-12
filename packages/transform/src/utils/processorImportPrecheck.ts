import { extname } from 'path';

import type { ImportDeclaration, Program } from 'oxc-parser';

import type { StrictOptions } from '@wyw-in-js/shared';

import { getProcessorForImport } from '../processors/processorLookup';
import { oxcShaker } from '../shaker';
import { getMatchedRule } from '../transform/Entrypoint.helpers';
import { parseOxc } from './applyOxcProcessors/shared';
import {
  collectOxcProcessorImportsFromProgram,
  type OxcCollectedImport,
} from './collectOxcExportsAndImports';
import {
  isTypeOnlyImport,
  isTypeOnlyImportSpecifier,
} from './oxc/typeOnlyImport';
import { stripQueryAndHash } from './parseRequest';

type PrecheckImport = Pick<OxcCollectedImport, 'imported' | 'source'> & {
  localName: string | undefined;
};

const importedName = (
  specifier: ImportDeclaration['specifiers'][number]
): string => {
  if (specifier.type !== 'ImportSpecifier') {
    return 'default';
  }

  return specifier.imported.type === 'Literal'
    ? specifier.imported.value
    : specifier.imported.name;
};

const REQUIRE_WORD = /\brequire\b/;
const IMPORT_WORD = /\bimport\b/g;

/**
 * The imports of the top-level import declarations, when they are provably
 * everything the imports-only walk of `collectOxcProcessorImportsFromProgram`
 * would find; `null` otherwise. That walk takes imports from import
 * declarations at any depth, from `require` calls and from the uses of a
 * namespace binding, so the list is complete when:
 * - the text has no word `require` and no `\u` escape: the walk recognizes a
 *   `require` call by its decoded identifier, and an unescaped identifier is a
 *   whole word in the text;
 * - no top-level declaration imports a namespace (`import * as ns`);
 * - the text has as many words `import` as there are top-level import
 *   declarations: each declaration at any depth starts with its own keyword,
 *   and an escaped keyword is a parse error, so no declaration is nested.
 *
 * Any other `import` (`import()`, `import.meta`, a comment) only sends the
 * module to the walk. The list follows `collectFromImportDeclaration`, in the
 * same order, so processor lookups see the same questions. Nothing is written
 * to the collection cache: the later stages need the full walk.
 */
const collectTopLevelProcessorImports = (
  program: Program,
  code: string
): PrecheckImport[] | null => {
  if (REQUIRE_WORD.test(code) || code.includes('\\u')) {
    return null;
  }

  const declarations = program.body.filter(
    (node): node is ImportDeclaration => node.type === 'ImportDeclaration'
  );
  if (
    declarations.some((node) =>
      node.specifiers.some(
        (specifier) => specifier.type === 'ImportNamespaceSpecifier'
      )
    ) ||
    (code.match(IMPORT_WORD)?.length ?? 0) !== declarations.length
  ) {
    return null;
  }

  return declarations.flatMap((node): PrecheckImport[] => {
    if (isTypeOnlyImport(node)) {
      return [];
    }

    const source = node.source.value;
    if (node.specifiers.length === 0) {
      return [{ imported: 'side-effect', localName: undefined, source }];
    }

    return node.specifiers
      .filter((specifier) => !isTypeOnlyImportSpecifier(node, specifier))
      .map((specifier) => ({
        imported: importedName(specifier),
        localName: specifier.local.name,
        source,
      }));
  });
};

const walkProcessorImports = (
  program: Program,
  code: string
): PrecheckImport[] =>
  collectOxcProcessorImportsFromProgram(program, code).map((item) => ({
    imported: item.imported,
    localName: item.local.name ?? item.local.code,
    source: item.source,
  }));

const mayContainProcessorUsages = (
  code: string,
  filename: string,
  options: Pick<StrictOptions, 'tagResolver'>
): boolean => {
  if (code.includes('__wywPreval')) {
    return true;
  }

  try {
    const program = parseOxc(code, filename);
    const imports =
      collectTopLevelProcessorImports(program, code) ??
      walkProcessorImports(program, code);
    return imports.some((item) => {
      if (item.imported === 'side-effect' || !item.localName) {
        return false;
      }

      const [processor] = getProcessorForImport(
        { imported: item.imported, source: item.source },
        filename,
        options
      );
      return processor !== null;
    });
  } catch {
    // Parse and lookup failures surface through the regular pipeline.
    return true;
  }
};

/**
 * A root that would be processed by the Oxc shaker, imports nothing mapped to
 * a processor and has no explicit `__wywPreval` export cannot produce
 * artifacts. Ignored files keep their regular (cheaper) handling. The parse is
 * shared with the preeval stage through the parse cache.
 */
export const isRootWithoutProcessors = (
  code: string,
  name: string,
  options: Pick<StrictOptions, 'extensions' | 'rules' | 'tagResolver'>
): boolean => {
  const filename = stripQueryAndHash(name);
  if (!options.extensions.includes(extname(filename))) {
    return false;
  }

  if (getMatchedRule(options.rules, filename, code).action !== oxcShaker) {
    return false;
  }

  return !mayContainProcessorUsages(code, filename, options);
};
