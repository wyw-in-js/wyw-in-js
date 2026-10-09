/* eslint-disable no-continue, no-plusplus, no-nested-ternary */
import { oxcShaker } from '../shaker';
import { analyzeOxcBarrelFile } from '../transform/oxcBarrelManifest';
import type { Services } from '../transform/types';

import { isEvalOnlyKey } from './brokerCache';
import type { PreparedModule } from './prepareModuleOnDemand';

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/u;

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
    loadedAndParsed.evaluator !== oxcShaker
  ) {
    return null;
  }

  const analyzed = analyzeOxcBarrelFile(loadedAndParsed.code, id);
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
