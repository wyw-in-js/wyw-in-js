/**
 * Runs freshness scenarios against the current engine: the public
 * `transform()` entry point with a shared `TransformCacheCollection`.
 *
 * Recomputation is observed through the public `EventEmitter` hooks:
 * `setTransformResult` marks a freshly prepared module, an `eval-file` debug
 * line with shipped code marks a module executed by the eval runner.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TransformCacheCollection } from '../../../cache';
import { disposeEvalBroker } from '../../../eval/broker';
import { transform } from '../../../transform';
import type { Result } from '../../../types';

import { RecordingEmitter, type RecordingSink } from './recordingEmitter';
import type {
  FreshnessScenario,
  Hold,
  SessionSpec,
  SourceMode,
  Step,
  StepObservation,
  TransformCall,
} from './types';
import { isObservingStep } from './types';

const processorFile = path.resolve(
  __dirname,
  '..',
  '..',
  '__fixtures__',
  'test-css-processor.js'
);

const extensions = ['.ts', '.tsx', '.js', '.jsx'];
const STEP_TIMEOUT_MS = 20_000;

type Outcome = { css: string[] } | { error: string };

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

const createDeferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const withTimeout = async <T>(
  promise: Promise<T>,
  message: string
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), STEP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const splitRequest = (request: string): [string, string] => {
  const index = request.search(/[?#]/);
  return index === -1
    ? [request, '']
    : [request.slice(0, index), request.slice(index)];
};

const resolveWithExtensions = (candidate: string): string | null => {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  for (const extension of extensions) {
    const withExtension = `${candidate}${extension}`;
    if (fs.existsSync(withExtension) && fs.statSync(withExtension).isFile()) {
      return withExtension;
    }
  }

  return null;
};

/** Rule bodies of the extracted CSS; class names depend on slugs. */
const toCssBodies = (cssText: string | undefined): string[] =>
  [...(cssText ?? '').matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]);

const labelOf = (call: TransformCall): string => call.id ?? call.file;

const createPluginOptions = (spec: SessionSpec): Record<string, unknown> => ({
  configFile: false,
  babelOptions: { babelrc: false, configFile: false },
  tagResolver: (source: string, tag: string) =>
    source === 'test-css-processor' && tag === 'css' ? processorFile : null,
  ...spec.pluginOptions,
});

const applySourceMode = (
  mode: SourceMode,
  diskCode: string
): string | undefined => {
  if (mode === 'none') return undefined;
  if (mode === 'loaded') return diskCode.replace(/-disk\b/g, '-loaded');
  return diskCode;
};

interface PendingHold {
  gate: Deferred;
  hold: Hold;
  isReached: boolean;
  reached: Deferred;
}

class ScenarioWorld {
  private readonly cache = new TransformCacheCollection();

  private readonly root: string;

  private clock = Math.floor(Date.now() / 1000) - 100_000;

  private readonly background = new Map<string, Promise<Outcome>>();

  private readonly brokerScopes = new Map<string, object>();

  private readonly holds = new Map<string, PendingHold>();

  private readonly entrypointFiles = new Map<number, string>();

  private evaluated = new Set<string>();

  private prepared = new Set<string>();

  private readonly sessions = new Map<
    string,
    {
      asyncResolve: (what: string, importer: string) => Promise<string>;
      pluginOptions: Record<string, unknown>;
    }
  >();

  private resetVersion = 0;

  private lifecycleVersion = 0;

  private keySalt: string | null = null;

  private readonly sink: RecordingSink = {
    created: (seqId, filename) => {
      this.entrypointFiles.set(seqId, filename);
    },
    evaluated: (filename) => {
      this.evaluated.add(this.rel(filename));
    },
    prepared: (seqId) => {
      const filename = this.entrypointFiles.get(seqId);
      if (filename) this.prepared.add(this.rel(filename));
    },
  };

  constructor(private readonly scenario: FreshnessScenario) {
    this.root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `wyw-freshness-${scenario.id}-`))
    );
    Object.entries(scenario.files).forEach(([file, content]) => {
      this.writeFile(file, content, this.clock);
    });
    this.markObservationStart();
  }

  public async dispose(): Promise<void> {
    this.holds.forEach(({ gate }) => gate.resolve());
    await withTimeout(
      Promise.allSettled(this.background.values()),
      `background transforms did not settle in ${this.scenario.id}`
    ).catch(() => undefined);
    this.brokerScopes.forEach((scope) => disposeEvalBroker(scope));
    disposeEvalBroker(this.cache);
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  public async run(step: Step): Promise<StepObservation | null> {
    switch (step.do) {
      case 'write':
        this.clock += 10;
        Object.entries(step.files).forEach(([file, content]) => {
          const previous =
            step.mtime === 'preserve'
              ? fs.statSync(this.abs(file)).mtime
              : undefined;
          this.writeFile(file, content, previous ?? this.clock);
        });
        return null;
      case 'touch':
        this.clock += 10;
        step.files.forEach((file) => {
          fs.utimesSync(this.abs(file), this.clock, this.clock);
        });
        return null;
      case 'remove':
        step.files.forEach((file) => fs.rmSync(this.abs(file)));
        return null;
      case 'rename':
        fs.renameSync(this.abs(step.from), this.abs(step.to));
        return null;
      case 'invalidate':
        step.files.forEach((file) =>
          this.cache.invalidateForFile(this.abs(file))
        );
        return null;
      case 'start':
        return this.start(step.id, step.call, step.hold);
      case 'release':
        this.release(step.id);
        return null;
      case 'consumeInvalidation': {
        const consumed = this.cache.consumeInvalidation(this.abs(step.file));
        return { ...this.takeObservation({}), consumed };
      }
      case 'transform': {
        const outcomes = await withTimeout(
          Promise.all(step.calls.map((call) => this.transform(call))),
          `transform step did not settle in ${this.scenario.id}`
        );
        return this.takeObservation(
          Object.fromEntries(
            step.calls.map((call, index) => [labelOf(call), outcomes[index]])
          )
        );
      }
      case 'join': {
        const entries = [...this.background.entries()];
        this.background.clear();
        const outcomes = await withTimeout(
          Promise.all(entries.map(([, p]) => p)),
          `join step did not settle in ${this.scenario.id}`
        );
        return this.takeObservation(
          Object.fromEntries(
            entries.map(([id], index) => [id, outcomes[index]])
          )
        );
      }
      default:
        throw new Error(`Unknown step ${JSON.stringify(step)}`);
    }
  }

  private abs(file: string): string {
    const [bare, query] = splitRequest(file);
    return `${path.join(this.root, bare)}${query}`;
  }

  private rel(filename: string): string {
    const [bare, query] = splitRequest(filename);
    return `${path.relative(this.root, bare)}${query}`;
  }

  private writeFile(file: string, content: string, mtime: number | Date) {
    const filename = this.abs(file);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
    fs.utimesSync(filename, mtime, mtime);
  }

  private markObservationStart(): void {
    this.evaluated = new Set();
    this.prepared = new Set();
    this.keySalt = this.cache.getKeySalt();
    this.resetVersion = this.cache.getResetVersion();
    this.lifecycleVersion = this.cache.getLifecycleVersion();
  }

  private takeObservation(outcomes: Record<string, Outcome>): StepObservation {
    const css: Record<string, string[]> = {};
    const error: Record<string, string> = {};
    Object.entries(outcomes).forEach(([label, outcome]) => {
      if ('error' in outcome) error[label] = outcome.error;
      else css[label] = outcome.css;
    });

    // Attaching the first salt migrates keys and is not a reset.
    const saltResets =
      this.cache.getResetVersion() -
      this.resetVersion -
      (this.keySalt === null && this.cache.getKeySalt() !== null ? 1 : 0);
    let reset: StepObservation['reset'] = 'none';
    if (this.cache.getLifecycleVersion() !== this.lifecycleVersion) {
      reset = 'recovery';
    } else if (saltResets > 0) {
      reset = 'salt';
    }

    const observation: StepObservation = {
      css,
      error,
      prepared: [...this.prepared].sort(),
      evaluated: [...this.evaluated].sort(),
      reset,
    };
    this.markObservationStart();
    return observation;
  }

  private getSessionSpec(name: string): SessionSpec {
    const spec =
      this.scenario.sessions?.[name] ?? (name === 'default' ? {} : undefined);
    if (!spec) {
      throw new Error(`Unknown session ${name} in ${this.scenario.id}`);
    }
    return spec;
  }

  private getSession(name: string) {
    const existing = this.sessions.get(name);
    if (existing) return existing;

    const session = {
      asyncResolve: this.createResolver(),
      pluginOptions: createPluginOptions(this.getSessionSpec(name)),
    };
    this.sessions.set(name, session);
    return session;
  }

  private createResolver() {
    return async (what: string, importer: string): Promise<string> => {
      const hold = [...this.holds.values()].find(
        ({ hold: candidate, isReached }) =>
          candidate.at === 'resolve' &&
          !isReached &&
          this.abs(candidate.importer) === importer &&
          candidate.request === what
      );
      if (hold) {
        hold.isReached = true;
        hold.reached.resolve();
        await hold.gate.promise;
      }

      if (what === 'test-css-processor') return processorFile;

      const [bare, query] = splitRequest(what);
      const resolved = resolveWithExtensions(
        path.resolve(path.dirname(splitRequest(importer)[0]), bare)
      );
      if (!resolved) {
        throw new Error(
          `Cannot resolve ${JSON.stringify(what)} from ${this.rel(importer)}`
        );
      }

      return `${resolved}${query}`;
    };
  }

  private createLoader(spec: SessionSpec) {
    const { loader } = spec;
    if (!loader) return undefined;

    return async (resolved: string): Promise<string | undefined> => {
      const mode = loader.files[this.rel(resolved)];
      if (!mode) return undefined;
      return applySourceMode(
        mode,
        fs.readFileSync(splitRequest(resolved)[0], 'utf8')
      );
    };
  }

  private getBrokerScope(name: string | undefined): object | undefined {
    if (name === undefined) return undefined;
    const existing = this.brokerScopes.get(name);
    if (existing) return existing;
    const scope = {};
    this.brokerScopes.set(name, scope);
    return scope;
  }

  private async transform(
    call: TransformCall,
    evalGate?: PendingHold
  ): Promise<Outcome> {
    const gate = evalGate && {
      reached: () => {
        // eslint-disable-next-line no-param-reassign
        evalGate.isReached = true;
        evalGate.reached.resolve();
      },
      released: evalGate.gate.promise,
    };
    const sessionName = call.session ?? 'default';
    const spec = this.getSessionSpec(sessionName);
    const session = this.getSession(sessionName);
    const filename = this.abs(call.file);
    const diskCode = fs.readFileSync(splitRequest(filename)[0], 'utf8');
    const code = applySourceMode(call.source ?? 'disk', diskCode)!;
    const resolverKey =
      spec.resolverKey === undefined ? 'freshness' : spec.resolverKey;
    const loader = this.createLoader(spec);

    try {
      const result: Result = await transform(
        {
          cache: this.cache,
          eventEmitter: new RecordingEmitter(this.sink, gate),
          evalBrokerScope: this.getBrokerScope(spec.evalBrokerScope),
          ...(resolverKey === null ? {} : { asyncResolveKey: resolverKey }),
          ...(loader
            ? {
                loadDependencyCode: loader,
                loadDependencyCodeKey: spec.loader!.key,
              }
            : {}),
          options: {
            filename,
            root: this.root,
            pluginOptions: spec.freshPluginOptionsPerCall
              ? { ...session.pluginOptions }
              : session.pluginOptions,
          },
        },
        code,
        spec.freshResolverPerCall
          ? (what, importer) => session.asyncResolve(what, importer)
          : session.asyncResolve
      );
      return { css: toCssBodies(result.cssText) };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async start(
    id: string,
    call: TransformCall,
    hold: Hold | undefined
  ): Promise<null> {
    if (!hold) {
      this.background.set(id, this.transform(call));
      return null;
    }

    const pending: PendingHold = {
      gate: createDeferred(),
      hold,
      isReached: false,
      reached: createDeferred(),
    };
    this.holds.set(id, pending);
    this.background.set(
      id,
      this.transform(call, hold.at === 'eval' ? pending : undefined)
    );
    await withTimeout(
      pending.reached.promise,
      `hold ${id} was never reached in ${this.scenario.id}`
    );
    return null;
  }

  private release(id: string): void {
    const pending = this.holds.get(id);
    if (!pending) throw new Error(`Unknown hold ${id}`);
    pending.gate.resolve();
  }
}

/**
 * Executes the scenario and returns one observation per observing step
 * (`transform`, `join`, `consumeInvalidation`), in order.
 */
export const runWithTransform = async (
  scenario: FreshnessScenario
): Promise<StepObservation[]> => {
  const world = new ScenarioWorld(scenario);
  const observations: StepObservation[] = [];
  try {
    for (const step of scenario.steps) {
      // Steps are sequential by definition: each one observes the world the
      // previous steps left behind.
      // eslint-disable-next-line no-await-in-loop
      const observation = await world.run(step);
      if (isObservingStep(step)) {
        observations.push(observation!);
      }
    }
  } finally {
    await world.dispose();
  }

  return observations;
};
