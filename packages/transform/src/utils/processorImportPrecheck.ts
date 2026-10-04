import { extname } from 'path';

import type { StrictOptions } from '@wyw-in-js/shared';

import { getProcessorForImport } from '../processors/processorLookup';
import { oxcShaker } from '../shaker';
import { getMatchedRule } from '../transform/Entrypoint.helpers';
import { parseOxc } from './applyOxcProcessors/shared';
import { collectOxcProcessorImportsFromProgram } from './collectOxcExportsAndImports';
import { stripQueryAndHash } from './parseRequest';

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
    return collectOxcProcessorImportsFromProgram(program, code).some((item) => {
      const localName = item.local.name ?? item.local.code;
      if (item.imported === 'side-effect' || !localName) {
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
