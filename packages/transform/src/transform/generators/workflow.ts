import { AbortError, isAborted } from '../actions/AbortError';
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

  const assertPublication = (expected: unknown) => {
    this.cacheEpoch.owner.assertEpoch(this.cacheEpoch);
    entrypoint.assertCurrentCacheEpoch();
    entrypoint.assertNotSuperseded();
    if (cache.get('entrypoints', entrypoint.name) !== expected) {
      throw new AbortError('superseded');
    }
  };

  if (entrypoint.ignored) {
    const expectedPublished = cache.get('entrypoints', entrypoint.name);
    const code = entrypoint.loadedAndParsed.code ?? '';
    assertPublication(expectedPublished);
    return {
      code,
      sourceMap: options.inputSourceMap,
    };
  }

  const expectedBeforeProcess = cache.get('entrypoints', entrypoint.name);
  try {
    yield* this.getNext('processEntrypoint', entrypoint, undefined, null);
    assertPublication(expectedBeforeProcess);
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

  const expectedAfterProcess = expectedBeforeProcess;
  const originalCode = entrypoint.loadedAndParsed.code ?? '';
  assertPublication(expectedAfterProcess);

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
  const expectedBeforeMetadata = expectedAfterProcess;
  const hasWywMetadata = entrypoint.hasWywMetadata();
  assertPublication(expectedBeforeMetadata);
  if (!hasWywMetadata) {
    if (isLoadedEntrypointWithoutArtifacts(entrypoint)) {
      // A root bundler pass for a plain dependency must not pin eval/cache state.
      // If another WyW file needs this module, it will be prepared on demand.
      recordPipelineDisposableRoot(entrypoint.name, 'preeval');
      if (
        !cache.invalidatePublished(
          this.cacheEpoch,
          'entrypoints',
          entrypoint.name,
          expectedBeforeMetadata
        )
      ) {
        entrypoint.assertNotSuperseded();
        throw new AbortError('superseded');
      }
    }

    return {
      code: originalCode,
      sourceMap: options.inputSourceMap,
    };
  }

  // *** 2nd stage ***

  try {
    const expectedBeforeEval = expectedAfterProcess;
    const evalStageResult = yield* this.getNext(
      'evalFile',
      entrypoint,
      undefined,
      null
    );
    const evalAction = entrypoint.createAction(
      'evalFile',
      undefined,
      null,
      this.actionContext,
      this.services
    );
    const recordedEvalPublication = evalAction.takeCachePublication();
    const expectedAfterEval =
      recordedEvalPublication !== null
        ? recordedEvalPublication.publication
        : expectedBeforeEval;
    assertPublication(expectedAfterEval);

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

    const expectedBeforeCollect = expectedAfterEval;
    const collectStageResult = yield* this.getNext(
      'collect',
      entrypoint,
      {
        prevalPayload,
      },
      null
    );
    assertPublication(expectedBeforeCollect);

    const expectedAfterCollect = expectedBeforeCollect;
    const collectMetadata = collectStageResult.metadata;
    assertPublication(expectedAfterCollect);
    if (!collectMetadata) {
      recordPipelineLateNoMetadata(entrypoint.name, entrypoint.only, 'collect');
      const code = collectStageResult.code!;
      const sourceMap = collectStageResult.map;
      assertPublication(expectedAfterCollect);
      if (isLoadedEntrypointWithoutArtifacts(entrypoint)) {
        recordPipelineDisposableRoot(entrypoint.name, 'collect');
        if (
          !cache.invalidatePublished(
            this.cacheEpoch,
            'entrypoints',
            entrypoint.name,
            expectedAfterCollect
          )
        ) {
          entrypoint.assertNotSuperseded();
          throw new AbortError('superseded');
        }
      }

      return {
        code,
        sourceMap,
      };
    }

    const diagnostics = collectTransformDiagnostics(
      entrypoint.name,
      collectMetadata.processors
    );

    // *** 4th stage

    const extractStageResult = yield* this.getNext(
      'extract',
      entrypoint,
      {
        processors: collectMetadata.processors,
      },
      null
    );
    assertPublication(expectedAfterCollect);

    const metadata = options.pluginOptions.outputMetadata
      ? toTransformResultMetadata(
          {
            ...collectMetadata,
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
        ...collectMetadata.replacements,
      ],
      sourceMap: collectStageResult.map,
    };
  } catch (error) {
    return yield* restartOnSupersede.call(this, error);
  }
}
