/* eslint-disable no-continue */
import { collectOxcExportsAndImports } from '../../utils/collectOxcExportsAndImports';
import { oxcShaker } from '../../shaker';
import type { Entrypoint } from '../Entrypoint';
import type { IEntrypointDependency } from '../Entrypoint.types';
import type {
  IGetExportsAction,
  Services,
  SyncScenarioForAction,
} from '../types';

type WildcardReexport = {
  source: string;
};

export function findExportsInImports(
  entrypoint: Entrypoint,
  imports: IEntrypointDependency[],
  services?: Services
): { entrypoint: Entrypoint; import: string }[] {
  const results: {
    entrypoint: Entrypoint;
    import: string;
  }[] = [];

  for (const imp of imports) {
    const { resolved } = imp;
    if (!resolved) {
      throw new Error(`Could not resolve import ${imp.source}`);
    }

    const newEntrypoint = entrypoint.createChild(
      resolved,
      [],
      undefined,
      services
    );

    if (newEntrypoint === 'loop') {
      continue;
    }

    results.push({
      entrypoint: newEntrypoint,
      import: imp.source,
    });
  }

  return results;
}

export function* getExports(
  this: IGetExportsAction
): SyncScenarioForAction<IGetExportsAction> {
  const {
    entrypoint,
    services: { cache },
  } = this;
  const { loadedAndParsed } = entrypoint;

  entrypoint.log('get exports from %s', entrypoint.name);
  entrypoint.assertNotSuperseded();

  if (cache.has('exports', entrypoint.name)) {
    return cache.get('exports', entrypoint.name)!;
  }

  let withWildcardReexport: WildcardReexport[] = [];
  const result: string[] = [];

  if (loadedAndParsed.evaluator !== oxcShaker) {
    throw new Error(
      `[wyw-in-js] ${entrypoint.name} matched a legacy evaluator. The Oxc runtime path supports only the default Oxc evaluator.`
    );
  }

  const { exports, reexports } = collectOxcExportsAndImports(
    loadedAndParsed.code,
    loadedAndParsed.evalConfig.filename ?? entrypoint.name
  );
  Object.keys(exports).forEach((token) => {
    result.push(token);
  });

  reexports.forEach((reexport) => {
    if (reexport.exported !== '*') {
      result.push(reexport.exported);
    }
  });

  withWildcardReexport = reexports.filter(
    (reexport) => reexport.exported === '*'
  );

  if (withWildcardReexport.length) {
    const resolvedImports = yield* this.getNext('resolveImports', entrypoint, {
      imports: new Map(withWildcardReexport.map((item) => [item.source, []])),
    });
    const dependencyFilenames = resolvedImports.flatMap((dependency) =>
      dependency.resolved ? [dependency.resolved] : []
    );

    const importedEntrypoints = findExportsInImports(
      entrypoint,
      resolvedImports,
      this.services
    );

    for (const importedEntrypoint of importedEntrypoints) {
      const childExports = yield* this.getNext(
        'getExports',
        importedEntrypoint.entrypoint,
        undefined
      );

      result.push(...childExports);
    }

    entrypoint.assertNotSuperseded();
    cache.publish(this.cacheEpoch, 'exports', entrypoint.name, result);
    cache.publishCacheDependencies(
      this.cacheEpoch,
      'exports',
      entrypoint.name,
      dependencyFilenames
    );

    entrypoint.log('exports: %o', result);

    return result;
  }

  entrypoint.log('exports: %o', result);
  entrypoint.assertNotSuperseded();
  cache.publish(this.cacheEpoch, 'exports', entrypoint.name, result);

  return result;
}
