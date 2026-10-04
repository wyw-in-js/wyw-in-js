/**
 * Worker-thread entry of the transform pool. Each scope gets an isolated
 * TransformCacheCollection (and therefore its own eval broker); module
 * resolution and warnings are proxied to the thread that owns the bundler.
 */
import { parentPort } from 'node:worker_threads';

import type { PartialOptions } from '../transform/helpers/loadWywOptions';
import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';
import type {
  MainToWorkerMessage,
  TransformWorkerScopeConfig,
  WorkerToMainMessage,
} from './protocol';
import { deserializeError, serializeError } from './protocol';

type WorkerScope = {
  cache: TransformCacheCollection;
  config: TransformWorkerScopeConfig;
  // One object per scope: option normalization is memoized by identity.
  pluginOptions: PartialOptions;
};

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: string | null) => void;
};

const port = parentPort;
if (!port) {
  throw new Error('[wyw-in-js] transform worker must run in a worker thread');
}

const scopes = new Map<number, WorkerScope>();
const pendingRequests = new Map<number, PendingRequest>();
let lastRequestId = 0;

const post = (message: WorkerToMainMessage) => port.postMessage(message);

const createScope = (config: TransformWorkerScopeConfig): WorkerScope => {
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
    pluginOptions,
  };
};

const runTransform = async (
  message: Extract<MainToWorkerMessage, { type: 'transform' }>
): Promise<void> => {
  const { code, filename, inputSourceMap, jobId, outputFilename, scopeId } =
    message;
  const scope = scopes.get(scopeId);
  if (!scope) {
    post({
      error: serializeError(new Error(`Unknown transform scope ${scopeId}`)),
      jobId,
      type: 'done',
    });
    return;
  }

  const asyncResolve = (what: string, importer: string, stack: string[]) =>
    new Promise<string | null>((resolve, reject) => {
      lastRequestId += 1;
      const requestId = lastRequestId;
      pendingRequests.set(requestId, { reject, resolve });
      post({
        importer,
        jobId,
        requestId,
        scopeId,
        stack,
        type: 'resolve',
        what,
      });
    });

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
    case 'transform':
      runTransform(message).catch(() => undefined);
      break;
    case 'resolved': {
      const request = pendingRequests.get(message.requestId);
      if (!request) break;
      pendingRequests.delete(message.requestId);
      if (message.error) request.reject(deserializeError(message.error));
      else request.resolve(message.result ?? null);
      break;
    }
    case 'invalidate':
      scopes.get(message.scopeId)?.cache.invalidateForFile(message.filename);
      break;
    case 'clear':
      scopes.get(message.scopeId)?.cache.clear('all');
      break;
    case 'disposeEvalBroker': {
      const scope = scopes.get(message.scopeId);
      if (scope) disposeEvalBroker(scope.cache);
      break;
    }
    case 'disposeScope': {
      const scope = scopes.get(message.scopeId);
      if (scope) {
        disposeEvalBroker(scope.cache);
        scopes.delete(message.scopeId);
      }
      break;
    }
    case 'shutdown':
      // Stopping the eval runners releases the last handles of this thread,
      // so it exits once the port is closed.
      scopes.forEach((scope) => disposeEvalBroker(scope.cache));
      scopes.clear();
      port.close();
      break;
    default:
      break;
  }
});

post({ type: 'ready' });
