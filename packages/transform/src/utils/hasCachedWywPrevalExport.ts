import fs from 'node:fs';

import type { Services } from '../transform/types';

import { collectOxcExportsAndImports } from './collectOxcExportsAndImports';
import { stripQueryAndHash } from './parseRequest';

type CachedEntrypointLike = {
  evaluated?: boolean;
  ignored?: boolean;
  initialCode?: string;
  loadedAndParsed?: { code?: string; evalConfig?: { filename?: string } };
};

export const hasCachedWywPrevalExport = (
  services: Services,
  resolved: string,
  cached: CachedEntrypointLike | undefined
): boolean => {
  const cacheEpoch = services.cacheEpoch ?? services.cache.getCurrentEpoch();
  services.cache.assertEpoch(cacheEpoch);
  const knownExports = services.cache.get('exports', resolved) as
    | string[]
    | undefined;
  if (knownExports) {
    return knownExports.includes('__wywPreval') || knownExports.includes('*');
  }

  const filename = stripQueryAndHash(resolved);
  const code =
    cached?.initialCode ??
    cached?.loadedAndParsed?.code ??
    fs.readFileSync(filename, 'utf-8');

  let analyzed: ReturnType<typeof collectOxcExportsAndImports>;
  try {
    analyzed = collectOxcExportsAndImports(code, filename);
  } catch {
    return true;
  }

  if (analyzed.reexports.some((reexport) => reexport.exported === '*')) {
    return true;
  }

  const exportNames = Array.from(
    new Set([
      ...Object.keys(analyzed.exports),
      ...analyzed.reexports
        .filter((reexport) => reexport.exported !== '*')
        .map((reexport) => reexport.exported),
    ])
  );
  services.cache.publish(cacheEpoch, 'exports', resolved, exportNames);
  return exportNames.includes('__wywPreval');
};

export type { CachedEntrypointLike };
