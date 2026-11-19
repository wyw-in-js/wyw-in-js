/**
 * Worker-thread entry of the transform pool. Each scope gets an isolated
 * TransformCacheCollection (and therefore its own eval broker); module
 * resolution and warnings are proxied to the thread that owns the bundler.
 * An engine scope is the engine half of a host session, run by the same code
 * as on the calling thread.
 */
import { parentPort, workerData } from 'node:worker_threads';

import type { PartialOptions } from '../transform/helpers/loadWywOptions';
import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { createEngineScope } from '../hostSession/engineScope';
import type { EngineScopeState } from '../hostSession/engineScope';
import type { EngineHost } from '../hostSession/types';
import { transform } from '../transform';
import { setParseCacheLimit } from '../utils/parseOxc';
import type {
  EngineScopeData,
  MainToWorkerMessage,
  TransformWorkerData,
  TransformWorkerScopeConfig,
  WorkerToMainMessage,
} from './protocol';
import { deserializeError, serializeError } from './protocol';

type FacadeScope = {
  cache: TransformCacheCollection;
  config: TransformWorkerScopeConfig;
  kind: 'facade';
  // One object per scope: option normalization is memoized by identity.
  pluginOptions: PartialOptions;
};

/** The process scope of an eval runner that engine scopes share by name. */
type SharedRunner = {
  name: string;
  process: object;
};

type EngineWorkerScope = {
  engine: EngineScopeState;
  kind: 'engine';
  runner: SharedRunner | null;
};

type WorkerScope = EngineWorkerScope | FacadeScope;

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: string | null) => void;
};

const port = parentPort;
if (!port) {
  throw new Error('[wyw-in-js] transform worker must run in a worker thread');
}

const { parseCacheEntries } = (workerData ??
  {}) as Partial<TransformWorkerData>;
if (parseCacheEntries) {
  setParseCacheLimit(parseCacheEntries);
}

const scopes = new Map<number, WorkerScope>();
const pendingRequests = new Map<number, PendingRequest>();
let lastRequestId = 0;

const post = (message: WorkerToMainMessage) => port.postMessage(message);

const requestResolve = (
  message: (requestId: number) => WorkerToMainMessage
): Promise<string | null> =>
  new Promise<string | null>((resolve, reject) => {
    lastRequestId += 1;
    const requestId = lastRequestId;
    pendingRequests.set(requestId, { reject, resolve });
    post(message(requestId));
  });

const createScope = (config: TransformWorkerScopeConfig): FacadeScope => {
  const { contextGlobals } = config;
  const pluginOptions: PartialOptions = contextGlobals
    ? {
        ...config.pluginOptions,
        overrideContext: (context) => ({ ...context, ...contextGlobals }),
      }
    : config.pluginOptions;

  return {
    cache: new TransformCacheCollection(),
    config,
    kind: 'facade',
    pluginOptions,
  };
};

// Engine scopes with one runner name share its process: the first open scope
// with that name holds it.
const findSharedRunner = (name: string): SharedRunner | null => {
  let found: SharedRunner | null = null;
  scopes.forEach((scope) => {
    if (!found && scope.kind === 'engine' && scope.runner?.name === name) {
      found = scope.runner;
    }
  });
  return found;
};

const createEngineWorkerScope = (
  scopeId: number,
  key: string,
  data: EngineScopeData
): EngineWorkerScope => {
  const runner =
    data.runner === null
      ? null
      : findSharedRunner(data.runner) ?? { name: data.runner, process: {} };
  // A scope with a load capability stays on the calling thread.
  const host: EngineHost = {
    load: async () => undefined,
    optionSources: (sources) =>
      post({ scopeId, sources: [...sources], type: 'engineOptionSources' }),
    resolve: (callId, request) =>
      requestResolve((requestId) => ({
        callId,
        request,
        requestId,
        scopeId,
        type: 'engineResolve',
      })),
    warn: (callId, message) =>
      post({ callId, message, scopeId, type: 'engineWarning' }),
  };

  return {
    engine: createEngineScope({
      host,
      key,
      runner: runner?.process ?? null,
      scope: data,
    }),
    kind: 'engine',
    runner,
  };
};

const disposeRunners = (scope: WorkerScope) => {
  if (scope.kind === 'facade') {
    disposeEvalBroker(scope.cache);
    return;
  }

  scope.engine.disposeOwnRunner();
  if (scope.runner) disposeEvalBroker(scope.runner.process);
};

const disposeScope = (scopeId: number) => {
  const scope = scopes.get(scopeId);
  if (!scope) return;
  scopes.delete(scopeId);
  if (scope.kind === 'facade') {
    disposeEvalBroker(scope.cache);
    return;
  }

  scope.engine.close();
  // The shared runner stops with the last open scope that has its name.
  if (scope.runner && findSharedRunner(scope.runner.name) === null) {
    disposeEvalBroker(scope.runner.process);
  }
};

const runEngineTransform = async (
  message: Extract<MainToWorkerMessage, { type: 'engineTransform' }>
): Promise<void> => {
  const { callId, file, jobId, scopeId } = message;
  const scope = scopes.get(scopeId);
  if (scope?.kind !== 'engine') {
    post({
      error: serializeError(new Error(`Unknown engine scope ${scopeId}`)),
      jobId,
      type: 'done',
    });
    return;
  }

  try {
    const { optionSources, result, salt } = await scope.engine.transform(
      callId,
      file
    );
    post({
      engine: { optionSources: [...optionSources], salt },
      jobId,
      result,
      type: 'done',
    });
  } catch (error) {
    post({ error: serializeError(error), jobId, type: 'done' });
  }
};

const runTransform = async (
  message: Extract<MainToWorkerMessage, { type: 'transform' }>
): Promise<void> => {
  const { code, filename, inputSourceMap, jobId, outputFilename, scopeId } =
    message;
  const scope = scopes.get(scopeId);
  if (scope?.kind !== 'facade') {
    post({
      error: serializeError(new Error(`Unknown transform scope ${scopeId}`)),
      jobId,
      type: 'done',
    });
    return;
  }

  const asyncResolve = (what: string, importer: string, stack: string[]) =>
    requestResolve((requestId) => ({
      importer,
      jobId,
      requestId,
      scopeId,
      stack,
      type: 'resolve',
      what,
    }));

  try {
    const result = await transform(
      {
        asyncResolveKey: scope.config.asyncResolveKey,
        cache: scope.cache,
        emitWarning: (warning) =>
          post({ jobId, message: warning, type: 'warning' }),
        options: {
          filename,
          inputSourceMap,
          keepComments: scope.config.keepComments,
          outputFilename,
          pluginOptions: scope.pluginOptions,
          prefixer: scope.config.prefixer,
          preprocessor: scope.config.preprocessor,
          root: scope.config.root,
        },
      },
      code,
      asyncResolve
    );

    post({ jobId, result, type: 'done' });
  } catch (error) {
    post({ error: serializeError(error), jobId, type: 'done' });
  }
};

port.on('message', (message: MainToWorkerMessage) => {
  switch (message.type) {
    case 'scope':
      scopes.set(message.scopeId, createScope(message.config));
      break;
    case 'engineScope':
      scopes.set(
        message.scopeId,
        createEngineWorkerScope(message.scopeId, message.key, message.scope)
      );
      break;
    case 'transform':
      runTransform(message).catch(() => undefined);
      break;
    case 'engineTransform':
      runEngineTransform(message).catch(() => undefined);
      break;
    case 'resolved': {
      const request = pendingRequests.get(message.requestId);
      if (!request) break;
      pendingRequests.delete(message.requestId);
      if (message.error) request.reject(deserializeError(message.error));
      else request.resolve(message.result ?? null);
      break;
    }
    case 'invalidate': {
      const scope = scopes.get(message.scopeId);
      if (scope?.kind === 'facade')
        scope.cache.invalidateForFile(message.filename);
      break;
    }
    case 'engineInvalidate': {
      const scope = scopes.get(message.scopeId);
      if (scope?.kind === 'engine') {
        scope.engine.invalidate(message.files, message.extent);
      }
      break;
    }
    case 'clear': {
      const scope = scopes.get(message.scopeId);
      if (scope?.kind === 'facade') scope.cache.clear('all');
      break;
    }
    case 'disposeEvalBroker': {
      const scope = scopes.get(message.scopeId);
      if (scope) disposeRunners(scope);
      break;
    }
    case 'disposeScope':
      disposeScope(message.scopeId);
      break;
    case 'shutdown':
      // Stopping the eval runners releases the last handles of this thread,
      // so it exits once the port is closed.
      [...scopes.keys()].forEach(disposeScope);
      port.close();
      break;
    default:
      break;
  }
});

post({ type: 'ready' });
