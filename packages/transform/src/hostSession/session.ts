/**
 * The host half of a session: it stays on the thread of the bundler, keeps
 * the contexts of the calls, answers the requests of its engine with the
 * callbacks of the bundler, projects results and remembers what each root
 * depended on.
 */
import path from 'path';

import { stripQueryAndHash, toNativeResolverAlias } from '@wyw-in-js/shared';

import { searchPlaces } from '../transform/helpers/loadWywOptions';

import { createJsEngine } from './jsEngine';
import { namesOf, projectResult, toMatchFiles } from './output';
import type {
  CreateHostSession,
  EngineHost,
  EngineScope,
  HostFile,
  HostOutput,
  HostSession,
  HostSessionClosedError as HostSessionClosedErrorShape,
  HostSessionInput,
  HostWarning,
} from './types';

/**
 * A call of a closed host session.
 *
 * @experimental Intended for wyw-in-js integrations; may change in a minor
 * release.
 */
export class HostSessionClosedError
  extends Error
  implements HostSessionClosedErrorShape
{
  public readonly code = 'WYW_HOST_SESSION_CLOSED';

  public constructor() {
    super('[wyw-in-js] The host session is closed');
    this.name = 'HostSessionClosedError';
  }
}

type PendingCall<TContext> = {
  context: TContext;
  filename: string;
  warnings: HostWarning[];
};

const PACKAGE_JSON = 'package.json';

const toPosix = (file: string) => file.split(path.sep).join('/');

const isConfigSearchPlace = (file: string): boolean => {
  const posix = toPosix(file);
  return searchPlaces.some((place) => posix.endsWith(`/${place}`));
};

const defaultOnWarning = (warning: HostWarning) => {
  // eslint-disable-next-line no-console
  console.warn(warning.message);
};

/**
 * Opens a long-lived session: one per compiler, plugin instance or bundler
 * environment. It loads the options and computes the evaluation cache key
 * once, owns the transform cache and the eval runner, and projects every
 * result into one normalized output.
 *
 * @experimental Intended for wyw-in-js integrations; may change in a minor
 * release.
 */
export const createHostSession: CreateHostSession = <TContext>(
  input: HostSessionInput<TContext>
): HostSession<TContext> => {
  const { bundler } = input;
  const engine = input.engine ?? createJsEngine();
  const ownsEngine = input.engine === undefined;
  const onWarning = input.onWarning ?? defaultOnWarning;
  const calls = new Map<number, PendingCall<TContext>>();
  const running = new Set<Promise<unknown>>();
  // By the filename of the root as the bundler gave it, with its query.
  const roots = new Map<string, ReadonlySet<string>>();
  // Every config file the options of the session were read from. It only
  // grows: an engine reports the files of each generation it builds, and a
  // result the files of the generation it ran on, which may be an older one.
  const optionSources = new Set<string>();
  const addOptionSources = (sources: readonly string[]) =>
    sources.forEach((source) => optionSources.add(source));
  let lastCallId = 0;
  // Only the context of the last settled call is kept, until `close()`.
  let lastSettled: { context: TContext } | null = null;
  let closing: Promise<void> | null = null;

  /**
   * The context of a call. Work that outlived its call gets the context of
   * the newest call in flight, or of the last settled one.
   */
  const contextOf = (callId: number | null): TContext => {
    const call = callId === null ? undefined : calls.get(callId);
    if (call) return call.context;
    let newest: PendingCall<TContext> | undefined;
    calls.forEach((pending) => {
      newest = pending;
    });
    return (newest ?? lastSettled)?.context as TContext;
  };

  const host: EngineHost = {
    load: async (callId, request) =>
      bundler.load ? bundler.load(request, contextOf(callId)) : undefined,
    optionSources: addOptionSources,
    resolve: async (callId, request) =>
      bundler.resolve(request, contextOf(callId)),
    warn: (callId, message) => {
      const call = callId === null ? undefined : calls.get(callId);
      const warning: HostWarning = {
        filename: call?.filename ?? null,
        message,
        severity: 'warning',
        source: 'pipeline',
      };
      if (call) call.warnings.push(warning);
      else onWarning(warning);
    },
  };

  const scope: EngineScope = {
    alias:
      bundler.alias === undefined ? null : toNativeResolverAlias(bundler.alias),
    conditions: bundler.conditions ?? null,
    eventEmitter: input.eventEmitter ?? null,
    extensions: bundler.extensions ?? null,
    globals: bundler.globals ?? null,
    load: bundler.load !== undefined,
    options: input.options ?? {},
    root: bundler.root ?? process.cwd(),
    runner: input.runner ?? null,
  };
  const engineSession = engine.open(scope, host);

  const isGlobalInput = (file: string): boolean =>
    namesOf(file).some(
      (name) =>
        path.basename(name) === PACKAGE_JSON ||
        optionSources.has(name) ||
        isConfigSearchPlace(name)
    );

  const run = async (
    callId: number,
    call: PendingCall<TContext>,
    file: HostFile
  ): Promise<HostOutput> => {
    try {
      const { optionSources: sources, result } = await engineSession.transform(
        callId,
        file
      );
      addOptionSources(sources);
      const output = await projectResult({
        file,
        resolve: async (specifier) =>
          bundler.resolve(
            { importer: file.filename, specifier, stack: [file.filename] },
            call.context
          ),
        result,
        warnings: call.warnings,
      });
      roots.set(
        file.filename,
        toMatchFiles(file.filename, output.dependencies)
      );
      return output;
    } finally {
      calls.delete(callId);
      lastSettled = { context: call.context };
    }
  };

  return {
    close() {
      closing ??= (async () => {
        await Promise.all(running);
        await engineSession.close();
        if (ownsEngine) {
          await engine.release();
        }
        lastSettled = null;
        roots.clear();
      })();
      return closing;
    },

    invalidate(files) {
      const changed = [...new Set(files)];
      if (closing || changed.length === 0) return [];

      const global = changed.some(isGlobalInput);
      engineSession.invalidate(changed, global ? 'all' : 'files');
      if (global) return [...roots.keys()];

      const matched = new Set(changed.map((file) => stripQueryAndHash(file)));
      const affected: string[] = [];
      roots.forEach((dependsOn, root) => {
        if ([...matched].some((file) => dependsOn.has(file))) {
          affected.push(root);
        }
      });
      return affected;
    },

    transform(file, context) {
      if (closing) {
        return Promise.reject(new HostSessionClosedError());
      }

      lastCallId += 1;
      const callId = lastCallId;
      const call: PendingCall<TContext> = {
        context,
        filename: file.filename,
        warnings: [],
      };
      calls.set(callId, call);
      const output = run(callId, call, file);
      const settled = output.then(
        () => undefined,
        () => undefined
      );
      running.add(settled);
      settled.then(() => running.delete(settled));
      return output;
    },
  };
};
