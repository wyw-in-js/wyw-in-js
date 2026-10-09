/* eslint-disable no-continue,no-await-in-loop,require-yield */
import {
  createNativeResolverAdapter,
  getCustomResolverAdapter,
  resolveWithPolicy,
} from '../../resolve/resolvePolicy';
import { getEvalOptions } from '../../utils/evalOptions';
import { getFileIdx } from '../../utils/getFileIdx';
import { applyImportOverride } from '../../utils/importOverrides';
import type { Entrypoint } from '../Entrypoint';
import { getStack, isSuperSet, mergeOnly } from '../Entrypoint.helpers';
import type { IEntrypointDependency } from '../Entrypoint.types';
import type {
  AsyncScenarioForAction,
  IResolveImportsAction,
  Services,
  SyncScenarioForAction,
} from '../types';
import { isCacheRecoveryControlError } from '../actions/isCacheRecoveryControlError';

type AsyncResolve = (
  what: string,
  importer: string,
  stack: string[]
) => Promise<string | null>;

const resolveWithConfiguredEvalResolver = async (
  services: Services,
  source: string,
  importer: string,
  stack: string[],
  resolve: AsyncResolve
): Promise<string | null> => {
  const evalOptions = getEvalOptions(services);
  const outcome = await resolveWithPolicy(
    { importer, kind: 'import', specifier: source, stack },
    { mode: evalOptions.resolver, phase: 'prepare' },
    {
      bundler: (request) =>
        resolve(request.specifier, request.importer, request.stack),
      custom: getCustomResolverAdapter(evalOptions),
      native: createNativeResolverAdapter(() => services.options.pluginOptions),
    }
  );

  // An external import is not part of the dependency graph.
  return outcome.kind === 'file' || outcome.kind === 'virtual'
    ? outcome.id
    : null;
};

function applyImportOverrides(
  services: Services,
  entrypoint: Entrypoint,
  resolvedImports: IEntrypointDependency[]
): IEntrypointDependency[] {
  const overrides = services.options.pluginOptions.importOverrides;
  if (!overrides || Object.keys(overrides).length === 0) {
    return resolvedImports;
  }

  const { root } = services.options;
  const importer = entrypoint.name;
  const stack = getStack(entrypoint);

  return resolvedImports.map((dependency) => {
    const overridden = applyImportOverride({
      getStack: () => stack,
      importOverrides: overrides,
      importer,
      only: dependency.only,
      resolved: dependency.resolved,
      root,
      source: dependency.source,
    });
    if (!overridden) {
      return dependency;
    }

    return {
      ...dependency,
      only: overridden.only,
      resolved: overridden.resolved,
    };
  });
}

function emitDependency(
  emitter: Services['eventEmitter'],
  entrypoint: IResolveImportsAction['entrypoint'],
  imports: IEntrypointDependency[],
  phase?: IResolveImportsAction['data']['phase']
) {
  emitter.single({
    type: 'dependency',
    file: entrypoint.name,
    only: entrypoint.only,
    phase,
    imports: imports.map(({ resolved, only }) => ({
      from: resolved,
      what: only,
    })),
    fileIdx: getFileIdx(entrypoint.name),
  });
}

function filterUnresolved(
  entrypoint: Entrypoint,
  resolvedImports: IEntrypointDependency[]
): IEntrypointDependency[] {
  return resolvedImports.filter((i): i is IEntrypointDependency => {
    if (i.resolved === null) {
      entrypoint.log(
        `[resolve] ✅ %s in %s is ignored`,
        i.source,
        entrypoint.name
      );
      return false;
    }

    return true;
  });
}

async function loadDependencyCodes(
  services: Services,
  entrypoint: Entrypoint,
  dependencies: IEntrypointDependency[]
): Promise<IEntrypointDependency[]> {
  if (!services.loadDependencyCode) {
    return dependencies;
  }

  const { loadDependencyCode } = services;

  return Promise.all(
    dependencies.map(async (dependency) => {
      if (!dependency.resolved) {
        return dependency;
      }

      try {
        const loadedCode = await loadDependencyCode(
          dependency.resolved,
          entrypoint.name,
          dependency.source
        );

        return loadedCode === undefined
          ? dependency
          : {
              ...dependency,
              loadedCode,
            };
      } catch (err) {
        if (isCacheRecoveryControlError(err)) {
          throw err;
        }

        entrypoint.log(
          '[load] ❌ cannot load %s in %s: %O',
          dependency.source,
          entrypoint.name,
          err
        );
        return dependency;
      }
    })
  );
}

function getPreResolvedImports(
  preResolved: IResolveImportsAction['data']['preResolved']
): Map<string, IEntrypointDependency> {
  return new Map(
    (preResolved ?? []).map((dependency) => [dependency.source, dependency])
  );
}

/**
 * Synchronously resolves specified imports with a provided resolver.
 */
export function* syncResolveImports(
  this: IResolveImportsAction,
  resolve: (what: string, importer: string, stack: string[]) => string
): SyncScenarioForAction<IResolveImportsAction> {
  const {
    data: { imports },
    entrypoint,
    services: { eventEmitter },
  } = this;
  const listOfImports = Array.from(imports?.entries() ?? []);
  const preResolvedImports = getPreResolvedImports(this.data.preResolved);
  const { log } = entrypoint;

  if (listOfImports.length === 0) {
    emitDependency(eventEmitter, entrypoint, [], this.data.phase);

    log('%s has no imports', entrypoint.name);
    return [];
  }

  const resolvedImports = listOfImports.map(([source, only]) => {
    const preResolved = preResolvedImports.get(source);
    if (preResolved) {
      const mergedOnly = mergeOnly(preResolved.only, only);
      log(
        '[sync-resolve] ♻️ %s -> %s (only: %o)',
        source,
        preResolved.resolved,
        mergedOnly
      );
      return {
        ...preResolved,
        only: mergedOnly,
      };
    }

    let resolved: string | null = null;
    try {
      resolved = resolve(source, entrypoint.name, getStack(entrypoint));
      log('[sync-resolve] ✅ %s -> %s (only: %o)', source, resolved, only);
    } catch (err) {
      if (isCacheRecoveryControlError(err)) {
        throw err;
      }

      log('[sync-resolve] ❌ cannot resolve %s: %O', source, err);
    }

    return {
      source,
      only,
      resolved,
    };
  });

  const overriddenImports = applyImportOverrides(
    this.services,
    entrypoint,
    resolvedImports
  );
  const filteredImports = filterUnresolved(entrypoint, overriddenImports);
  emitDependency(eventEmitter, entrypoint, filteredImports, this.data.phase);

  return filteredImports;
}

/**
 * Asynchronously resolves specified imports with a provided resolver.
 */
export async function* asyncResolveImports(
  this: IResolveImportsAction,
  resolve: AsyncResolve
): AsyncScenarioForAction<IResolveImportsAction> {
  const {
    data: { imports },
    entrypoint,
    services: { eventEmitter },
  } = this;
  const listOfImports = Array.from(imports?.entries() ?? []);
  const preResolvedImports = getPreResolvedImports(this.data.preResolved);
  const { log } = entrypoint;

  if (listOfImports.length === 0) {
    emitDependency(eventEmitter, entrypoint, [], this.data.phase);

    log('%s has no imports', entrypoint.name);
    return [];
  }

  log('resolving %d imports', listOfImports.length);

  const getResolveTask = async (
    source: string,
    only: string[]
  ): Promise<IEntrypointDependency> => {
    let resolved: string | null = null;
    try {
      resolved = await resolveWithConfiguredEvalResolver(
        this.services,
        source,
        entrypoint.name,
        getStack(entrypoint),
        resolve
      );
    } catch (err) {
      if (isCacheRecoveryControlError(err)) {
        throw err;
      }

      log(
        '[async-resolve] ❌ cannot resolve %s in %s: %O',
        source,
        entrypoint.name,
        err
      );
    }

    if (resolved !== null) {
      log(
        '[async-resolve] ✅ %s (%o) in %s -> %s',
        source,
        only,
        entrypoint.name,
        resolved
      );
    }

    return {
      source,
      only,
      resolved,
    };
  };

  const resolvedImports = await Promise.all<IEntrypointDependency>(
    listOfImports.map(([source, importsOnly]) => {
      const preResolved = preResolvedImports.get(source);
      if (preResolved) {
        const mergedOnly = mergeOnly(preResolved.only, importsOnly);
        log(
          '[async-resolve] ♻️ %s (%o) in %s -> %s',
          source,
          mergedOnly,
          entrypoint.name,
          preResolved.resolved
        );
        return {
          ...preResolved,
          only: mergedOnly,
        };
      }

      const cached = entrypoint.getDependency(source);
      if (cached) {
        return {
          source,
          only: mergeOnly(cached.only, importsOnly),
          resolved: cached.resolved,
        };
      }

      const task = entrypoint.getResolveTask(source);
      if (task) {
        // If we have cached task, we need to merge only…
        const newTask = task.then((res) => {
          if (isSuperSet(res.only, importsOnly)) {
            return res;
          }

          // Is this branch even possible?
          const merged = mergeOnly(res.only, importsOnly);

          log('merging imports %o and %o: %o', importsOnly, res.only, merged);

          return { ...res, only: merged };
        });

        // … and update the cache
        entrypoint.addResolveTask(source, newTask);
        return entrypoint.getResolveTask(source)!;
      }

      const resolveTask = getResolveTask(source, importsOnly);

      entrypoint.addResolveTask(source, resolveTask);
      return entrypoint.getResolveTask(source)!;
    })
  );
  entrypoint.assertNotSuperseded();

  log('resolved %d imports', resolvedImports.length);

  const overriddenImports = applyImportOverrides(
    this.services,
    entrypoint,
    resolvedImports
  );
  const filteredImports = filterUnresolved(entrypoint, overriddenImports);
  const loadedImports = await loadDependencyCodes(
    this.services,
    entrypoint,
    filteredImports
  );
  entrypoint.assertNotSuperseded();
  emitDependency(eventEmitter, entrypoint, loadedImports, this.data.phase);
  return loadedImports;
}
