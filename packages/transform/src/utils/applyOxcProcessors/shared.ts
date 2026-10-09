import type { SourceLocation } from '@wyw-in-js/processor-utils';
import type { Program } from 'oxc-parser';

import { printOxcAstServiceImport, type AddedImport } from '../oxcAstService';
import { createOxcFileEdits } from '../oxc/fileEdits';
import { parseOxcProgram } from '../oxc/parse';
import {
  createOxcSourceLocation,
  type OxcLocationLookup,
} from '../oxc/sourceLocations';

export const GENERATED_HELPER_NAME_RE = /^_exp\d*$/;
export const WYW_META_EXTENDS_HELPER_RE =
  /(?:\bextends|["']extends["'])\s*:\s*(_exp\d*)\s*\(\s*\)/g;
export const JS_IDENTIFIER_RE = /[$A-Z_a-z][$\w]*/g;

export const parseOxc = (code: string, filename: string): Program => {
  return parseOxcProgram(code, filename, 'module');
};

export const insertAddedImports = (
  code: string,
  filename: string,
  addedImports: AddedImport[]
): string => {
  if (addedImports.length === 0) {
    return code;
  }

  const program = parseOxc(code, filename);
  const uniqueImports = [
    ...new Map(
      addedImports.map((item) => [
        `${item.source}\0${item.imported}\0${item.local}`,
        item,
      ])
    ).values(),
  ];
  const importBlock = uniqueImports.map(printOxcAstServiceImport).join('\n');

  return createOxcFileEdits(code, program)
    .insert('after-imports', importBlock, { ownLine: true })
    .apply();
};

export const getSourceLocation = (
  start: number,
  end: number,
  loc: OxcLocationLookup,
  filename?: string | null
): SourceLocation => createOxcSourceLocation(start, end, loc, filename);
