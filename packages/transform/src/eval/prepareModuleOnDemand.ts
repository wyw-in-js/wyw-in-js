import { oxcShaker } from '../shaker';
import type { Services } from '../transform/types';
import { Entrypoint } from '../transform/Entrypoint';
import { isSuperSet } from '../transform/Entrypoint.helpers';
import { collectOxcImportMap } from '../utils/oxcImportMap';
import { prepareCodeForEvalRuntime } from '../transform/generators/transform';
import type { EvalPreparationToken } from '../debug/evalTelemetry.types';
import { AbortError } from '../transform/actions/AbortError';

export const PREPARED_MODULE_PUBLICATION = Symbol('preparedModulePublication');

export type PreparedModule = {
  code: string;
  imports: Map<string, string[]> | null;
  only: string[];
};

type PreparedModuleWithPublication = PreparedModule & {
  [PREPARED_MODULE_PUBLICATION]: unknown;
};

export function prepareModuleOnDemand(
  services: Services,
  id: string,
  only: string[],
  telemetry?: EvalPreparationToken,
  graphTraversalToken?: object,
  activeEntrypoint?: Entrypoint
): PreparedModuleWithPublication {
  const entrypoint =
    activeEntrypoint?.name === id && isSuperSet(activeEntrypoint.only, only)
      ? activeEntrypoint
      : Entrypoint.createRoot(services, id, only, undefined, {
          mergeCachedOnly: !only.includes('__wywPreval'),
          graphTraversalToken,
        });
  const expectedPublication = services.cache.get('entrypoints', id);
  const finish = (prepared: PreparedModule): PreparedModuleWithPublication => {
    entrypoint.assertCurrentCacheEpoch();
    entrypoint.assertNotSuperseded();
    if (services.cache.get('entrypoints', id) !== expectedPublication) {
      throw new AbortError('superseded');
    }

    Object.defineProperty(prepared, PREPARED_MODULE_PUBLICATION, {
      value: expectedPublication,
    });
    return prepared as PreparedModuleWithPublication;
  };

  if (entrypoint.ignored) {
    const code = entrypoint.loadedAndParsed.code ?? '';
    // An ignored module is shipped verbatim, not shaken — its import and
    // re-export statements are still real dependency edges the runner's
    // linker will resolve, so the broker needs them for the same
    // `only`-merging reasons as a normal module (see collectOxcImportMap).
    // "Ignored" also covers genuinely non-JS content (CSS, assets) that
    // oxc's parser can't handle — a parse failure here must leave `imports`
    // at its previous, safe default rather than throwing.
    let imports: ReturnType<typeof collectOxcImportMap> | null = null;
    if (code) {
      try {
        imports = collectOxcImportMap(code, id);
      } catch {
        imports = null;
      }
    }

    return finish({
      code,
      imports,
      only: entrypoint.only,
    });
  }

  const ast =
    entrypoint.loadedAndParsed.evaluator === oxcShaker
      ? null
      : (entrypoint.loadedAndParsed.ast as Parameters<
          typeof prepareCodeForEvalRuntime
        >[2]);
  const [code, imports] = prepareCodeForEvalRuntime(
    services,
    entrypoint,
    ast,
    telemetry
  );

  return finish({
    code,
    imports,
    only: entrypoint.only,
  });
}
