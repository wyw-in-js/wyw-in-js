import type { Entrypoint } from '../transform/Entrypoint';
import type { IEvaluatedEntrypoint } from '../transform/EvaluatedEntrypoint';
import { mergeOnly } from '../transform/Entrypoint.helpers';
import { AbortError } from '../transform/actions/AbortError';

import { collectKnownExportNames, isEvalOnlyKey } from './brokerCache';
import type { EntrypointPublication, EpochServices } from './brokerSession';
import { deserializeValue, type SerializedValue } from './serialize';

type PublishModuleExportsOptions = {
  assertCurrent: () => void;
  expectedEntrypoints: ReadonlyMap<
    string,
    Entrypoint | IEvaluatedEntrypoint | undefined
  >;
  modules: Record<string, Record<string, SerializedValue>>;
  rootEntrypoint: Entrypoint;
  services: EpochServices;
};

export const publishModuleExports = ({
  assertCurrent,
  expectedEntrypoints,
  modules,
  rootEntrypoint,
  services,
}: PublishModuleExportsOptions): EntrypointPublication => {
  const staged = Object.entries(modules).flatMap(([id, serializedExports]) => {
    if (!serializedExports || Object.keys(serializedExports).length === 0) {
      return [];
    }

    assertCurrent();
    const expected = expectedEntrypoints.get(id);
    const cached = services.cache.get('entrypoints', id);
    if (cached !== expected) {
      throw new AbortError('superseded');
    }
    if (!cached || cached.ignored) {
      return [];
    }

    const existingEvaluatedOnly = cached.evaluatedOnly ?? [];
    const target =
      cached.evaluated || !('createEvaluated' in cached)
        ? cached
        : cached.createEvaluated(services);
    const deserializedExports = Object.entries(serializedExports).map(
      ([key, serialized]) => [key, deserializeValue(serialized)] as const
    );

    const expectedKnownExports = services.cache.get('exports', id);
    const knownExports = collectKnownExportNames(services, id, target, false);
    const serializedKeys = Object.keys(serializedExports);
    const coversAllKnownExports =
      Array.isArray(knownExports) &&
      knownExports.filter((key) => !isEvalOnlyKey(key)).length > 0 &&
      knownExports
        .filter((key) => !isEvalOnlyKey(key))
        .every((key) => serializedKeys.includes(key));
    const merged = mergeOnly(
      existingEvaluatedOnly,
      coversAllKnownExports ? ['*'] : serializedKeys
    );

    return [
      {
        deserializedExports,
        expected,
        expectedKnownExports,
        id,
        knownExportsToPublish:
          expectedKnownExports === undefined ? knownExports : undefined,
        merged,
        target,
      },
    ];
  });

  // Constructors and export discovery above can emit public callbacks. Do
  // not publish any part of the evaluated graph until every target still
  // matches the snapshot captured before EVAL.
  assertCurrent();
  staged.forEach(({ expected, expectedKnownExports, id }) => {
    if (services.cache.get('entrypoints', id) !== expected) {
      throw new AbortError('superseded');
    }
    if (services.cache.get('exports', id) !== expectedKnownExports) {
      throw new AbortError('superseded');
    }
  });

  const published: typeof staged = [];
  const publishedKnownExports: typeof staged = [];
  try {
    staged.forEach((item) => {
      const { expected, id, target } = item;
      if (
        !services.cache.replacePublished(
          services.cacheEpoch,
          'entrypoints',
          id,
          expected,
          target
        )
      ) {
        throw new AbortError('superseded');
      }
      published.push(item);
    });
    staged.forEach((item) => {
      const { expectedKnownExports, id, knownExportsToPublish } = item;
      if (
        knownExportsToPublish !== undefined &&
        !services.cache.replacePublished(
          services.cacheEpoch,
          'exports',
          id,
          expectedKnownExports,
          knownExportsToPublish
        )
      ) {
        throw new AbortError('superseded');
      }
      if (knownExportsToPublish !== undefined) {
        publishedKnownExports.push(item);
      }
    });
  } catch (error) {
    publishedKnownExports
      .reverse()
      .forEach(({ expectedKnownExports, id, knownExportsToPublish }) => {
        services.cache.replacePublished(
          services.cacheEpoch,
          'exports',
          id,
          knownExportsToPublish,
          expectedKnownExports
        );
      });
    published.reverse().forEach(({ expected, id, target }) => {
      services.cache.replacePublished(
        services.cacheEpoch,
        'entrypoints',
        id,
        target,
        expected
      );
    });
    throw error;
  }

  const mutationEpoch = services.cacheEpoch;
  try {
    staged.forEach(({ deserializedExports, merged, target }) => {
      const exportsProxy = target.exports;
      deserializedExports.forEach(([key, value]) => {
        exportsProxy[key] = value;
      });
      if (target.evaluatedOnly) {
        target.evaluatedOnly.splice(0, target.evaluatedOnly.length, ...merged);
      }
    });
    assertCurrent();
  } catch (error) {
    // Export setters and evaluatedOnly can be user-controlled structural
    // entrypoint state. Once the first live mutation starts, rollback cannot
    // prove that no alias observed a partial update, so retire the epoch.
    const cause = error instanceof Error ? error : new Error(String(error));
    const recovery = services.cache.startEvaluationSideEffectRecovery(
      cause,
      mutationEpoch,
      services.cacheRecoveryOwner
    );
    recovery.complete();
    throw recovery.abortError;
  }

  return staged.find(({ id }) => id === rootEntrypoint.name)?.target;
};
