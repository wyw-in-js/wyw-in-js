import { Transformer } from '@parcel/plugin';
import * as SourceMapModule from '@parcel/source-map';
import type SourceMapInstance from '@parcel/source-map';

import { asyncResolveFallback } from '@wyw-in-js/shared';
import {
  disposeEvalBroker,
  transform,
  TransformCacheCollection,
} from '@wyw-in-js/transform';

// Parcel exposes no transformer-dispose hook. Reuse one child runner while
// source transforms overlap or arrive in a burst, then release it after idle.
// Scoped sessions detach each asset's services between jobs.
const EVAL_BROKER_IDLE_DISPOSE_MS = 1_000;
const evalBrokerScope = {};
let evalBrokerIdleTimer: ReturnType<typeof setTimeout> | undefined;
let activeSourceTransforms = 0;
type SourceMapCtor = new (projectRoot: string) => SourceMapInstance;

const sourceMapDefault = SourceMapModule as unknown as {
  default?: { default?: typeof SourceMapModule } | typeof SourceMapModule;
};

const SourceMapValue =
  sourceMapDefault.default?.default ??
  sourceMapDefault.default ??
  SourceMapModule;
const SourceMap = SourceMapValue as unknown as SourceMapCtor;

export default new Transformer({
  async transform({ asset, logger, options, resolve }) {
    if (!asset.isSource) {
      return [asset];
    }

    if (evalBrokerIdleTimer) {
      clearTimeout(evalBrokerIdleTimer);
      evalBrokerIdleTimer = undefined;
    }
    activeSourceTransforms += 1;
    try {
      // Parcel creates `resolve` for an individual asset and does not expose a
      // resolver-configuration revision for watch rebuilds. Keep the cache
      // local and let the shared broker derive an isolated semantic session
      // from this callback rather than claiming equivalence across assets.
      const cache = new TransformCacheCollection();
      const originalCode = await asset.getCode();
      const originalMap = await asset.getMap();
      const originalVlqMap = originalMap?.toVLQ();
      const inputSourceMap = originalVlqMap
        ? {
            ...originalVlqMap,
            version: originalVlqMap.version ?? 3,
            sources: [...originalVlqMap.sources],
            names: [...originalVlqMap.names],
            sourcesContent: undefined,
            file: originalVlqMap.file ?? asset.filePath,
          }
        : undefined;

      const result = await transform(
        {
          cache,
          evalBrokerScope,
          emitWarning: (message: string) => {
            logger.warn({ message, origin: '@wyw-in-js/parcel-transformer' });
          },
          options: {
            filename: asset.filePath,
            inputSourceMap,
            root: options.projectRoot,
          },
        },
        originalCode,
        async (what: string, importer: string, stack: string[]) => {
          try {
            return await resolve(importer, what, { specifierType: 'esm' });
          } catch (error) {
            try {
              return await asyncResolveFallback(what, importer, stack);
            } catch {
              throw error;
            }
          }
        }
      );

      if (result.dependencies) {
        for (const dependency of result.dependencies) {
          asset.invalidateOnFileChange(dependency);
        }
      }

      asset.setCode(result.code);

      if (result.sourceMap) {
        const map = new SourceMap(options.projectRoot);
        map.addVLQMap(result.sourceMap);
        asset.setMap(map);
      } else {
        asset.setMap(null);
      }

      if (!result.cssText) {
        return [asset];
      }

      const cssKey = `${asset.id}::wyw-in-js.css`;

      asset.addDependency({
        specifier: cssKey,
        specifierType: 'esm',
      });

      return [
        asset,
        {
          type: 'css',
          content: `${result.cssText}\n`,
          env: asset.env,
          sideEffects: true,
          uniqueKey: cssKey,
        },
      ];
    } finally {
      activeSourceTransforms -= 1;
      if (activeSourceTransforms === 0) {
        evalBrokerIdleTimer = setTimeout(() => {
          evalBrokerIdleTimer = undefined;
          if (activeSourceTransforms === 0) {
            disposeEvalBroker(evalBrokerScope);
          }
        }, EVAL_BROKER_IDLE_DISPOSE_MS);
        evalBrokerIdleTimer.unref();
      }
    }
  },
});
