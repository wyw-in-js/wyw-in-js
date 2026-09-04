import { isAborted } from '../actions/AbortError';
import type { IWorkflowAction, SyncScenarioForAction } from '../types';
import { collectTransformDiagnostics } from '../../utils/TransformDiagnostics';
import { toTransformResultMetadata } from '../../utils/TransformMetadata';
import {
  recordPipelineDisposableRoot,
  recordPipelineLateNoMetadata,
} from '../../debug/pipelineTelemetry';

const isLoadedEntrypointWithoutArtifacts = (
  entrypoint: IWorkflowAction['entrypoint']
) =>
  entrypoint.initialCode !== undefined &&
  entrypoint.only.includes('__wywPreval');

const collectDependencyResolutions = (
  entrypoint: IWorkflowAction['entrypoint'],
  dependencies: readonly string[]
) =>
  dependencies.flatMap((source) => {
    const resolved = entrypoint.dependencies.get(source)?.resolved;
    return resolved ? [{ resolved, source }] : [];
  });

/**
 * The entry point for file processing. Sequentially calls `processEntrypoint`,
 * `evalFile`, `collect`, and `extract`. Returns the result of transforming
 * the source code as well as all artifacts obtained from code execution.
 */
export function* workflow(
  this: IWorkflowAction
): SyncScenarioForAction<IWorkflowAction> {
  const { cache, options } = this.services;
  const { entrypoint } = this;

  if (entrypoint.ignored) {
    return {
      code: entrypoint.loadedAndParsed.code ?? '',
      sourceMap: options.inputSourceMap,
    };
  }

  try {
    yield* this.getNext('processEntrypoint', entrypoint, undefined, null);
    entrypoint.assertNotSuperseded();
  } catch (e) {
    if (isAborted(e) && entrypoint.supersededWith) {
      entrypoint.log('workflow aborted, schedule the next attempt');
      return yield* this.getNext(
        'workflow',
        entrypoint.supersededWith,
        undefined,
        null
      );
    }

    throw e;
  }

  const originalCode = entrypoint.loadedAndParsed.code ?? '';

  function* restartOnSupersede(
    this: IWorkflowAction,
    error: unknown
  ): SyncScenarioForAction<IWorkflowAction> {
    if (isAborted(error) && entrypoint.supersededWith) {
      entrypoint.log('workflow aborted, schedule the next attempt');
      return yield* this.getNext(
        'workflow',
        entrypoint.supersededWith,
        undefined,
        null
      );
    }

    throw error;
  }

  // File is ignored or does not contain any tags. Return original code.
  if (!entrypoint.hasWywMetadata()) {
    if (isLoadedEntrypointWithoutArtifacts(entrypoint)) {
      // A root bundler pass for a plain dependency must not pin eval/cache state.
      // If another WyW file needs this module, it will be prepared on demand.
      recordPipelineDisposableRoot(entrypoint.name, 'preeval');
      cache.removePublished(
        entrypoint.cacheEpoch,
        'entrypoints',
        entrypoint.name
      );
    }

    return {
      code: originalCode,
      sourceMap: options.inputSourceMap,
    };
  }

  // *** 2nd stage ***

  try {
    const evalStageResult = yield* this.getNext(
      'evalFile',
      entrypoint,
      undefined,
      null
    );
    entrypoint.assertNotSuperseded();

    if (evalStageResult === null) {
      return {
        code: originalCode,
        sourceMap: options.inputSourceMap,
      };
    }

    const prevalPayload = evalStageResult;
    const { dependencies } = prevalPayload;
    const dependencyResolutions = collectDependencyResolutions(
      entrypoint,
      dependencies
    );

    // *** 3rd stage ***

    const collectStageResult = yield* this.getNext(
      'collect',
      entrypoint,
      {
        prevalPayload,
      },
      null
    );
    entrypoint.assertNotSuperseded();

    if (!collectStageResult.metadata) {
      recordPipelineLateNoMetadata(entrypoint.name, entrypoint.only, 'collect');
      if (isLoadedEntrypointWithoutArtifacts(entrypoint)) {
        recordPipelineDisposableRoot(entrypoint.name, 'collect');
        cache.removePublished(
          entrypoint.cacheEpoch,
          'entrypoints',
          entrypoint.name
        );
      }

      return {
        code: collectStageResult.code!,
        sourceMap: collectStageResult.map,
      };
    }

    const diagnostics = collectTransformDiagnostics(
      entrypoint.name,
      collectStageResult.metadata.processors
    );

    // *** 4th stage

    const extractStageResult = yield* this.getNext(
      'extract',
      entrypoint,
      {
        processors: collectStageResult.metadata.processors,
      },
      null
    );
    entrypoint.assertNotSuperseded();

    const metadata = options.pluginOptions.outputMetadata
      ? toTransformResultMetadata(
          {
            ...collectStageResult.metadata,
            rules: extractStageResult.rules,
          },
          dependencies
        )
      : null;

    return {
      ...extractStageResult,
      code: collectStageResult.code ?? '',
      dependencies,
      ...(dependencyResolutions.length > 0 ? { dependencyResolutions } : {}),
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
      ...(metadata ? { metadata } : {}),
      replacements: [
        ...extractStageResult.replacements,
        ...collectStageResult.metadata.replacements,
      ],
      sourceMap: collectStageResult.map,
    };
  } catch (error) {
    return yield* restartOnSupersede.call(this, error);
  }
}
