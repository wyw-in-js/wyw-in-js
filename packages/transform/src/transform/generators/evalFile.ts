import evaluate, { type IEvaluateResult } from '../../evaluators';
import { AbortError } from '../actions/AbortError';
import { isUnprocessedEntrypointError } from '../actions/UnprocessedEntrypointError';
import { createPrevalPayload } from '../prevalPayload';
import type { AsyncScenarioForAction, IEvalAction } from '../types';

/**
 * Executes the code prepared in previous steps within the current `Entrypoint`.
 * Returns all exports that were requested in `only`.
 */
// eslint-disable-next-line require-yield
export async function* evalFile(
  this: IEvalAction
): AsyncScenarioForAction<IEvalAction> {
  const { entrypoint } = this;
  const { log } = entrypoint;
  const preevalResult = entrypoint.getPreevalResult();
  const filename =
    entrypoint.loadedAndParsed.evaluator === 'ignored'
      ? entrypoint.name
      : entrypoint.loadedAndParsed.evalConfig.filename ?? entrypoint.name;
  const strategy =
    this.services.options.pluginOptions.eval?.strategy ?? 'hybrid';

  if (preevalResult && (preevalResult.dependencyNames?.length ?? 0) === 0) {
    const expectedPublication = this.services.cache.get(
      'entrypoints',
      entrypoint.name
    );
    if (expectedPublication !== entrypoint) {
      throw new AbortError('superseded');
    }
    const prevalPayload = createPrevalPayload({
      emitWarning: this.services.emitWarning,
      evalDependencies: preevalResult.executeSideEffectDependencies,
      filename,
      strategy,
      staticDependencies: preevalResult.staticDependencies,
      staticNullWYWMetaExtendsHelpers:
        preevalResult.staticNullWYWMetaExtendsHelpers,
      staticValues: preevalResult.staticValueCache,
    });
    log(`<< skipped evaluate __wywPreval %O`, prevalPayload.values);
    this.recordCachePublication(expectedPublication);

    return prevalPayload;
  }

  log(`>> evaluate __wywPreval`);

  let evaluated: IEvaluateResult | undefined;

  while (evaluated === undefined) {
    try {
      // eslint-disable-next-line no-await-in-loop
      evaluated = await this.services.eventEmitter.perf(
        'transform:evalFile',
        () => evaluate(this.services, entrypoint)
      );
    } catch (e) {
      if (isUnprocessedEntrypointError(e)) {
        entrypoint.log(
          'Evaluation has been aborted because one if the required files is not processed. Schedule reprocessing and repeat evaluation.'
        );
        yield ['processEntrypoint', e.entrypoint, undefined];
      } else {
        throw e;
      }
    }
  }

  if (!evaluated.values) {
    this.recordCachePublication(evaluated.publication);
    return null;
  }

  const prevalPayload = createPrevalPayload({
    emitWarning: this.services.emitWarning,
    evalDependencies: [
      ...evaluated.dependencies,
      ...(preevalResult?.executeSideEffectDependencies ?? []),
    ],
    evalValues: evaluated.values,
    filename,
    strategy,
    staticDependencies: preevalResult?.staticDependencies,
    staticNullWYWMetaExtendsHelpers:
      preevalResult?.staticNullWYWMetaExtendsHelpers,
    staticValues: preevalResult?.staticValueCache,
  });

  log(`<< evaluated __wywPreval %O`, prevalPayload.values);
  this.recordCachePublication(evaluated.publication);

  return prevalPayload;
}
