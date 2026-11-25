/* eslint-disable no-underscore-dangle */
// The core of the eval runner: it handles the protocol messages of one runner
// process and holds all of its state in the instance that createEvalRunner
// returns. Importing it does nothing to the process: the process entry,
// runnerMain.js, owns stdin, stdout, the host console and the exit.
import fs from 'node:fs';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import vm from 'node:vm';
import path from 'node:path';
import NativeModule, { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Minimatch } from 'minimatch';
// The `eval` subpath of the shared package keeps the runner startup light. The
// lint resolver does not read package `exports`; Node resolves it.
/* eslint-disable import/no-unresolved */
import {
  EVAL_LOAD_CACHE_SIZE,
  EVAL_RESOLVE_CACHE_SIZE,
  LruCache,
  canonicalizeForHash,
  decodeGlobals,
  deserializeError,
  deserializeValue,
  isBuiltinSpecifier,
  isFeatureEnabled,
  isPlainObject,
  serializeError,
  serializePreval,
  serializeValue,
  stripQueryAndHash,
} from '@wyw-in-js/shared/eval';
/* eslint-enable import/no-unresolved */

// The runner runs as plain ESM in Node, which needs the file extension.
// eslint-disable-next-line import/extensions
import { createHappyDomWindow } from './happyDomWindow.js';
// eslint-disable-next-line import/extensions
import { evaluateGlobalFunction } from './runnerGlobalScope.js';

const NOOP = () => {};

// stdout is reserved for the JSON IPC protocol; host-side logs must not share
// it. The stream prefixes every line and writes it with writeStderr.
export const createPrefixStream = (getPrefix, writeStderr) =>
  new Writable({
    write(chunk, _enc, cb) {
      const p = getPrefix();
      const s = chunk.toString();
      // Prefix interior newlines but not the trailing one — avoids
      // double-prefix when consecutive writes each start with a prefix.
      const tail = s.endsWith('\n') ? '\n' : '';
      const body = tail ? s.slice(0, -1) : s;
      writeStderr(p + body.replaceAll('\n', `\n${p}`) + tail, cb);
    },
  });

const VITE_VIRTUAL_PREFIX = '/@';
const REACT_REFRESH_VIRTUAL_ID = '/@react-refresh';
const reactRefreshRuntime = {
  createSignatureFunctionForTransform: () => () => {},
};

const builtins = {
  assert: true,
  buffer: true,
  child_process: false,
  cluster: false,
  console: true,
  constants: true,
  crypto: true,
  dgram: false,
  dns: false,
  domain: true,
  events: true,
  fs: false,
  http: true,
  https: true,
  module: false,
  net: false,
  os: true,
  path: true,
  punycode: true,
  process: true,
  querystring: true,
  readline: false,
  repl: false,
  stream: true,
  string_decoder: true,
  sys: true,
  timers: true,
  tls: false,
  tty: true,
  url: true,
  util: true,
  vm: true,
  zlib: true,
};

const MODULE_VARIANT_LIMIT = 8;

const isErrRequireEsm = (error) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ERR_REQUIRE_ESM';

const IMPORT_META_ENV = '__wyw_import_meta_env';

const withTimeout = (promise, timeoutMs, label) => {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(
        `[wyw-in-js] Timed out while waiting for ${label}.`
      );
      error.code = 'WYW_HAPPYDOM_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
};

const setReferencePropertyIfNotPresent = (context, key) => {
  if (context[key] === context) return;
  context[key] = context;
};

export const isBarePackageSubpath = (id) => {
  if (id.startsWith('.') || path.isAbsolute(id)) return false;
  if (id.startsWith('@')) return id.split('/').length > 2;
  return id.includes('/');
};

// Resolves `specifier` from `importerFile` like require.resolve, but with the
// export conditions the broker sent in INIT for this edge kind, so a specifier
// the runner resolves on its own lands where the broker would resolve it.
// Without configured conditions Node's defaults apply, as they always did.
export const resolveFromImporter = (
  specifier,
  importerFile,
  kind,
  evalOptions,
  nodeRequire = null
) => {
  const conditions =
    kind === 'require'
      ? evalOptions.conditions?.require
      : evalOptions.conditions?.import;
  if (!conditions) {
    const importerRequire =
      nodeRequire ?? createRequire(pathToFileURL(importerFile).href);
    return importerRequire.resolve(specifier);
  }

  const parent = {
    id: importerFile,
    filename: importerFile,
    paths: NativeModule._nodeModulePaths(path.dirname(importerFile)),
  };
  const options = { conditions: new Set(conditions) };
  try {
    return NativeModule._resolveFilename(specifier, parent, false, options);
  } catch (error) {
    // A conditional wildcard export such as "./src/*" may map to an
    // extensionless target, so retry the known extensions. Only for
    // extensionless relative, absolute and package subpath ids: guessing an
    // extension for a package root such as "@scope/pkg" would name another
    // package ("@scope/pkg.js").
    const canRetry =
      error?.code === 'MODULE_NOT_FOUND' &&
      path.extname(specifier) === '' &&
      (specifier.startsWith('.') ||
        path.isAbsolute(specifier) ||
        isBarePackageSubpath(specifier));
    if (!canRetry) throw error;

    const extensions = evalOptions.extensions ?? [];
    for (let index = 0; index < extensions.length; index += 1) {
      try {
        return NativeModule._resolveFilename(
          `${specifier}${extensions[index]}`,
          parent,
          false,
          options
        );
      } catch {
        // Try the next extension.
      }
    }
    throw error;
  }
};

const normalizeResolvedId = (
  resolvedId,
  specifier,
  importer,
  evalOptions,
  kind
) => {
  const stripped = stripQueryAndHash(resolvedId);
  if (!stripped) return resolvedId;
  if (path.extname(stripped)) return resolvedId;

  const isFileSpecifier =
    specifier.startsWith('.') || path.isAbsolute(specifier);
  if (!isFileSpecifier && !path.isAbsolute(stripped)) {
    return resolvedId;
  }

  let candidate = stripped;
  if (!path.isAbsolute(candidate)) {
    if (!importer) {
      return resolvedId;
    }
    const importerFile = stripQueryAndHash(importer);
    candidate = path.resolve(path.dirname(importerFile), candidate);
  }

  const suffix = resolvedId.slice(stripped.length);
  const resolvedExtensions = evalOptions.extensions ?? [];
  for (let index = 0; index < resolvedExtensions.length; index += 1) {
    const ext = resolvedExtensions[index];
    const fileCandidate = `${candidate}${ext}`;
    if (fs.existsSync(fileCandidate)) {
      return `${fileCandidate}${suffix}`;
    }

    const indexCandidate = path.join(candidate, `index${ext}`);
    if (fs.existsSync(indexCandidate)) {
      return `${indexCandidate}${suffix}`;
    }
  }

  if (importer) {
    try {
      const resolved = resolveFromImporter(
        stripQueryAndHash(specifier),
        stripQueryAndHash(importer),
        kind,
        evalOptions
      );
      if (resolved && resolved !== stripped) {
        return `${resolved}${suffix}`;
      }
    } catch {
      // ignore fallback failures
    }
  }

  return resolvedId;
};

const isNodeModulesId = (id) => {
  if (!id) return false;
  const normalized = stripQueryAndHash(id).replace(/\\/g, '/');
  return normalized.includes('/node_modules/');
};

const mergeOnly = (current, next) => {
  if (!current || current.length === 0) return next ?? [];
  if (!next || next.length === 0) return current;
  if (current.includes('*') || next.includes('*')) {
    return ['*'];
  }
  return Array.from(new Set([...current, ...next]));
};

const toCanonicalFileKey = (resolved, root) => {
  const rootDir = root ? path.resolve(root) : process.cwd();
  const normalizedResolved = path.resolve(resolved);
  let relative = path.relative(rootDir, normalizedResolved);

  if (path.sep !== path.posix.sep) {
    relative = relative.split(path.sep).join(path.posix.sep);
  }

  if (!relative.startsWith('.')) {
    relative = `./${relative}`;
  }

  return relative;
};

const toImportKey = ({ source, resolved, root }) => {
  const isFileImport = source.startsWith('.') || path.isAbsolute(source);
  if (isFileImport && resolved) {
    return { key: toCanonicalFileKey(resolved, root), kind: 'file' };
  }
  return { key: source, kind: 'package' };
};

const minimatchOptions = {
  dot: true,
  nocomment: true,
  nonegate: true,
};

const compileImportOverrides = (importOverrides) => {
  const matchers = Object.entries(importOverrides)
    .map(([pattern, override]) => ({
      matcher: new Minimatch(pattern, minimatchOptions),
      override,
      pattern,
    }))
    .sort((a, b) => b.pattern.length - a.pattern.length);

  return { matchers };
};

const resolveMockSpecifier = ({ mock, importer, root }) => {
  const specifier =
    mock.startsWith('.') && root ? path.resolve(root, mock) : mock;
  const nodeRequire = createRequire(pathToFileURL(importer).href);
  return nodeRequire.resolve(specifier);
};

const isFullModuleLoad = (loaded) =>
  !loaded.only || (loaded.only.length === 1 && loaded.only[0] === '*');

const toSourceModuleId = (id) => stripQueryAndHash(String(id));

const toVersionedModuleIdentifier = (id, hash) => {
  if (!hash) return id;
  const separator = id.includes('?') ? '&' : '?';
  return `${id}${separator}wyw-hash=${hash}`;
};

// Stale async work belongs to a VM context which has already been discarded.
// Leave that work pending instead of rejecting it: user code commonly starts
// fire-and-forget dynamic imports, and rejecting those during INIT would turn
// a normal session transition into an unhandled rejection.
const abandonStaleSession = () => new Promise(() => {});

const buildPreamble = (id) =>
  [
    `const __wyw_module = __wyw_getModule(${JSON.stringify(id)});`,
    `let exports = __wyw_module.exports;`,
    `const module = __wyw_module.module;`,
    `const require = __wyw_module.require;`,
    `const __filename = __wyw_module.filename;`,
    `const __dirname = __wyw_module.dirname;`,
    `const __wyw_dynamic_import = __wyw_module.dynamicImport;`,
    ``,
  ].join('\n');

const getImporterPackage = (importer) => {
  const normalized = importer.replace(/\\/g, '/');
  const marker = '/node_modules/';
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) return path.basename(importer);
  const rest = normalized.slice(idx + marker.length);
  if (rest.startsWith('@')) {
    const [scope, name] = rest.split('/').slice(0, 2);
    return `${scope}/${name}`;
  }
  return rest.split('/')[0];
};

const toSyntheticExports = (value) => {
  if (value && (typeof value === 'object' || typeof value === 'function')) {
    const exportsValue = {};
    Object.keys(value).forEach((key) => {
      exportsValue[key] = value[key];
    });
    exportsValue.default =
      Object.prototype.hasOwnProperty.call(value, 'default') ||
      Object.prototype.hasOwnProperty.call(exportsValue, 'default')
        ? value.default
        : value;
    return exportsValue;
  }
  return { default: value };
};

const isUnknownFileExtensionError = (error) => {
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    if (current.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      return true;
    }
    seen.add(current);
    current = current.cause;
  }
  return false;
};

// import() of a CommonJS file only exposes the named exports that
// cjs-module-lexer can find statically, so anything assigned dynamically is
// missing from the namespace. Node routes such a file through the CJS loader,
// which leaves the real module.exports in the require cache — prefer that so
// dynamically built exports keep working.
const unwrapCjsNamespace = (namespace, resolvedFile) => {
  if (!resolvedFile || !path.isAbsolute(resolvedFile)) return namespace;

  const candidates = [resolvedFile];
  try {
    candidates.push(fs.realpathSync(resolvedFile));
  } catch {
    // The file may have disappeared; the unresolved path is still worth a try.
  }

  const cache = NativeModule._cache ?? {};
  const hit = candidates.map((file) => cache[file]).find(Boolean);
  return hit ? hit.exports : namespace;
};

const resolveExportValue = (source, key) => {
  if (key === 'default') {
    if (source && typeof source === 'object' && 'default' in source) {
      return source.default;
    }
    return source;
  }

  if (source && (typeof source === 'object' || typeof source === 'function')) {
    if (key in source) {
      return source[key];
    }
    if (
      source.default &&
      typeof source.default === 'object' &&
      key in source.default
    ) {
      return source.default[key];
    }
  }

  return undefined;
};

const stringifyDebugValue = (value) => {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // fall through
  }

  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
};

const serializeDebugReason = (error) =>
  error instanceof Error ? error.message : String(error);

const MALFORMED_MESSAGE_PREVIEW_LENGTH = 200;

// Creates the runner of one process.
// - send(message) sends a protocol frame to the broker; the caller serializes
//   and writes it.
// - writeStderr(text, callback) writes diagnostics and the output of evaluated
//   code.
// - env is the environment: WYW_EVAL_RUNNER_DEBUG and the happy-dom timeout are
//   read once here, WYW_DEBUG_EVAL_RESOLVE on every resolution, and evaluated
//   code sees env as process.env.
export const createEvalRunner = ({ send, writeStderr, env }) => {
  const packageTypeCache = new Map();

  const getPackageType = (filename) => {
    let dir = path.dirname(filename);
    while (dir && dir !== path.dirname(dir)) {
      const cached = packageTypeCache.get(dir);
      if (cached === 'module' || cached === 'commonjs') return cached;
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          const type = pkg?.type === 'module' ? 'module' : 'commonjs';
          packageTypeCache.set(dir, type);
          return type;
        } catch {
          packageTypeCache.set(dir, null);
          return null;
        }
      }
      packageTypeCache.set(dir, null);
      dir = path.dirname(dir);
    }
    return null;
  };

  const shouldPreferImport = (resolvedFile) => {
    if (!resolvedFile) return false;
    if (!path.isAbsolute(resolvedFile)) return false;
    if (resolvedFile.endsWith('.mjs')) return true;
    if (resolvedFile.endsWith('.cjs')) return false;
    if (!resolvedFile.endsWith('.js')) return false;
    return getPackageType(resolvedFile) === 'module';
  };

  let importMetaEnvWarned = false;
  let happyDomLoadWarned = false;
  let happyDomUnavailable = false;
  let happyDomImportPromise = null;
  const debugEnabled = Boolean(env.WYW_EVAL_RUNNER_DEBUG);
  const debug = (...args) => {
    if (!debugEnabled) return;
    // eslint-disable-next-line no-console
    console.warn('[wyw-eval-runner:debug]', ...args);
  };

  const processShim = {
    nextTick: (fn) => setTimeout(fn, 0),
    platform: 'browser',
    arch: 'browser',
    execPath: 'browser',
    title: 'browser',
    pid: 1,
    browser: true,
    argv: [],
    binding() {
      throw new Error('No such module. (Possibly not yet loaded)');
    },
    cwd: () => '/',
    exit: NOOP,
    kill: NOOP,
    chdir: NOOP,
    umask: NOOP,
    dlopen: NOOP,
    uptime: NOOP,
    memoryUsage: NOOP,
    uvCounters: NOOP,
    features: {},
    env,
  };

  const createImportMetaEnvProxy = () => {
    const target = Object.create(null);
    const warnOnce = () => {
      if (importMetaEnvWarned) return;
      importMetaEnvWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        [
          `[wyw-in-js] import.meta.env was accessed during build-time evaluation, but no env values were provided.`,
          ``,
          `If you're using Vite, make sure @wyw-in-js/vite plugin is enabled (it injects Vite env for evaluation).`,
          `Otherwise provide "__wyw_import_meta_env" via pluginOptions.overrideContext.`,
        ].join('\n')
      );
    };

    return new Proxy(target, {
      get(obj, key) {
        if (typeof key === 'symbol') return Reflect.get(obj, key);
        warnOnce();
        return obj[key];
      },
      has(obj, key) {
        if (typeof key === 'symbol') return Reflect.has(obj, key);
        warnOnce();
        return Reflect.has(obj, key);
      },
      getOwnPropertyDescriptor(obj, key) {
        return Reflect.getOwnPropertyDescriptor(obj, key);
      },
      ownKeys(obj) {
        return Reflect.ownKeys(obj);
      },
      set(obj, key, value) {
        if (typeof key === 'symbol') return Reflect.set(obj, key, value);
        warnOnce();
        return Reflect.set(obj, key, value);
      },
    });
  };

  const HAPPY_DOM_TIMEOUT_MS = Number(
    env.WYW_EVAL_HAPPYDOM_INIT_TIMEOUT_MS ??
      env.WYW_HAPPYDOM_TIMEOUT_MS ??
      15000
  );

  const loadHappyDom = async () => {
    if (!happyDomImportPromise) {
      happyDomImportPromise = import('happy-dom');
    }
    return happyDomImportPromise;
  };

  const createWindow = async () => {
    if (happyDomUnavailable) return undefined;
    try {
      debug('happyDom:import:start');
      const importStart = Date.now();
      const happyDom = await withTimeout(
        loadHappyDom(),
        HAPPY_DOM_TIMEOUT_MS,
        'happy-dom import'
      );
      debug('happyDom:import:done', Date.now() - importStart);
      const windowStart = Date.now();
      const win = createHappyDomWindow(happyDom);
      debug('happyDom:window:done', Date.now() - windowStart);
      win.Buffer = Buffer;
      win.Uint8Array = Uint8Array;
      return win;
    } catch (error) {
      happyDomUnavailable = true;
      happyDomImportPromise = null;
      if (!happyDomLoadWarned) {
        happyDomLoadWarned = true;
        // eslint-disable-next-line no-console
        console.warn(
          [
            `[wyw-in-js] DOM emulation is enabled (features.happyDOM), but "happy-dom" could not be loaded in this build-time runtime.`,
            `WyW will continue without DOM emulation (as if features.happyDOM:false).`,
            ``,
            `To silence this warning: set features: { happyDOM: false }.`,
            `To restore DOM emulation, ensure "happy-dom" can be imported in the build-time runtime.`,
          ].join('\n')
        );
      }
      return undefined;
    }
  };

  const createBaseContext = (win, additionalContext) => {
    const baseContext = win ?? {};
    setReferencePropertyIfNotPresent(baseContext, 'window');
    setReferencePropertyIfNotPresent(baseContext, 'self');
    setReferencePropertyIfNotPresent(baseContext, 'top');
    setReferencePropertyIfNotPresent(baseContext, 'parent');
    setReferencePropertyIfNotPresent(baseContext, 'global');
    setReferencePropertyIfNotPresent(baseContext, 'process');

    baseContext.document = win?.document;
    baseContext.process = processShim;

    baseContext.clearImmediate = NOOP;
    baseContext.clearInterval = NOOP;
    baseContext.clearTimeout = NOOP;
    baseContext.setImmediate = NOOP;
    baseContext.requestAnimationFrame = NOOP;
    baseContext.setInterval = NOOP;
    baseContext.setTimeout = NOOP;

    Object.assign(baseContext, additionalContext);
    return baseContext;
  };

  const createVmContext = async (filename, features, globals) => {
    const isHappyDomEnabled = isFeatureEnabled(features, 'happyDOM', filename);
    const win = isHappyDomEnabled ? await createWindow() : undefined;
    const envContext = {
      [IMPORT_META_ENV]: createImportMetaEnvProxy(),
    };
    const baseContext = createBaseContext(win, {
      __filename: filename,
      ...envContext,
      ...globals,
    });
    // Evaluated code must never write to stdout — it is the IPC channel.
    const vmIdent = () => `vm(${path.basename(baseContext.__filename ?? '?')})`;
    baseContext.console = new Console({
      stdout: createPrefixStream(
        () => `[wyw-runner:${vmIdent()} stdout] `,
        writeStderr
      ),
      stderr: createPrefixStream(
        () => `[wyw-runner:${vmIdent()} stderr] `,
        writeStderr
      ),
    });
    const context = vm.createContext(baseContext);
    return {
      context,
      teardown: () => {
        if (win?.happyDOM) {
          win.happyDOM.abort();
        }
      },
    };
  };

  const compiledOverridesCache = new WeakMap();

  const getImportOverride = (importOverrides, key) => {
    if (!importOverrides) return undefined;
    const direct = importOverrides[key];
    if (direct) return direct;

    let compiled = compiledOverridesCache.get(importOverrides);
    if (!compiled) {
      compiled = compileImportOverrides(importOverrides);
      compiledOverridesCache.set(importOverrides, compiled);
    }

    return compiled.matchers.find(({ matcher }) => matcher.match(key))
      ?.override;
  };

  const state = {
    context: null,
    teardown: null,
    happyDomEnabled: null,
    globalsSignature: null,
    evalOptions: {
      errors: 'strict',
      require: 'warn-and-run',
      globals: {},
      importOverrides: undefined,
      root: undefined,
      extensions: [],
    },
    features: {},
    debugEvalFiles: false,
    entrypoint: 'eval-runner',
  };

  const moduleCache = new LruCache(EVAL_LOAD_CACHE_SIZE);
  const moduleHashes = new Map();
  const moduleData = new Map();
  const moduleOnly = new Map();
  const moduleVariants = new Map();
  const moduleLastVariant = new Map();
  const linkPromises = new Map();
  const loadInFlight = new Map();
  const externalInFlight = new Map();
  const dynamicEvaluations = new Set();
  const resolveCache = new LruCache(EVAL_RESOLVE_CACHE_SIZE);
  const resolveInFlight = new Map();

  const pending = new Map();
  const loadResultChunks = new Map();
  let activeSessionId = 0;
  let activeSessionRef = { id: 0 };
  // Ids evicted during the in-flight EVAL session via resetSingleModuleState.
  // Surfaced in EVAL_RESULT so the broker can drop matching entries from its
  // "what runner has" mirror (lastSentLoadByModule) — otherwise the broker would
  // keep short-circuiting subsequent LOADs with empty `code` and the runner
  // would have no way to obtain fresh source.
  const evictedThisSession = new Set();
  let nextId = 0;

  // Tracks the SourceTextModule identifier (versioned with hash) that was last
  // included in an EVAL_RESULT for each id. Reused module variants don't need
  // re-serialization across eval sessions — same variant = same namespace =
  // same exports the broker already has cached.
  const sentNamespaceIdentifiers = new Map();

  const resetModuleState = () => {
    moduleCache.clear();
    moduleHashes.clear();
    moduleData.clear();
    moduleOnly.clear();
    moduleVariants.clear();
    moduleLastVariant.clear();
    linkPromises.clear();
    loadInFlight.clear();
    externalInFlight.clear();
    dynamicEvaluations.clear();
    resolveInFlight.clear();
    resolveCache.clear();
    sentNamespaceIdentifiers.clear();
  };

  const resetSingleModuleState = (id, cachedModule = moduleCache.get(id)) => {
    if (cachedModule) {
      linkPromises.delete(cachedModule);
    }

    const variants = moduleVariants.get(id);
    if (variants) {
      variants.forEach((variant) => linkPromises.delete(variant));
    }

    moduleCache.delete(id);
    moduleHashes.delete(id);
    moduleData.delete(id);
    moduleVariants.delete(id);
    moduleLastVariant.delete(id);
    sentNamespaceIdentifiers.delete(id);
  };

  // Stronger reset for error paths: clears moduleOnly too and records the id so
  // the broker can drop its lastSentLoadByModule entry. Used when a module's
  // SourceTextModule has reached an unrecoverable state (e.g. link errored
  // against a transient missing import) and should not be reused.
  const evictPoisonedModule = (id) => {
    resetSingleModuleState(id);
    moduleOnly.delete(id);
    evictedThisSession.add(id);
  };

  const getModuleVariant = (id, hash) => moduleVariants.get(id)?.get(hash);

  const setModuleVariant = (id, hash, module) => {
    let variants = moduleVariants.get(id);
    if (!variants) {
      variants = new Map();
      moduleVariants.set(id, variants);
    }
    variants.set(hash, module);
    moduleLastVariant.set(id, module);

    if (variants.size > MODULE_VARIANT_LIMIT) {
      const oldestHash = variants.keys().next().value;
      if (oldestHash !== undefined) {
        const oldest = variants.get(oldestHash);
        if (oldest) {
          linkPromises.delete(oldest);
        }
        variants.delete(oldestHash);
      }
    }
  };

  const resetEvaluationState = () => {
    if (state.teardown) {
      state.teardown();
    }
    state.context = null;
    state.teardown = null;
    state.happyDomEnabled = null;
    state.globalsSignature = null;
    resetModuleState();
  };

  const isSessionActive = (sessionId) => sessionId === activeSessionId;

  const sendWarn = (warning) => {
    send({ type: 'WARN', payload: warning });
  };

  const request = (type, payload, sessionId = activeSessionId) => {
    nextId += 1;
    const id = `${nextId}`;
    send({ type, id, payload, sessionId });
    const response = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    return response.then((value) =>
      isSessionActive(sessionId) ? value : abandonStaleSession()
    );
  };

  const resolvePending = (id, payload) => {
    const pendingItem = pending.get(id);
    if (!pendingItem) return;
    pending.delete(id);
    pendingItem.resolve(payload);
  };

  const handleLoadResult = (id, payload) => {
    // A full INIT drops all requests from the previous semantic session. Late
    // chunks for one of those ids must not recreate a partial-response entry.
    if (!pending.has(id)) return;

    if (
      !payload ||
      typeof payload.codeChunk !== 'string' ||
      typeof payload.chunkIndex !== 'number' ||
      typeof payload.chunkCount !== 'number'
    ) {
      resolvePending(id, payload);
      return;
    }

    let entry = loadResultChunks.get(id);
    if (!entry) {
      entry = {
        chunks: new Array(payload.chunkCount),
        received: 0,
        meta: null,
      };
      loadResultChunks.set(id, entry);
    }

    if (!entry.chunks[payload.chunkIndex]) {
      entry.received += 1;
    }
    entry.chunks[payload.chunkIndex] = payload.codeChunk;

    if (payload.chunkIndex === 0) {
      const { codeChunk, chunkIndex, chunkCount, ...meta } = payload;
      entry.meta = meta;
    }

    if (entry.received >= payload.chunkCount) {
      const code = entry.chunks.join('');
      const finalPayload = {
        ...(entry.meta ?? {}),
        code,
      };
      loadResultChunks.delete(id);
      resolvePending(id, finalPayload);
    }
  };

  const warnedRequires = new Set();

  const getEvalRequireOverride = (specifier, resolved) => {
    const keyInfo = toImportKey({
      source: specifier,
      resolved,
      root: state.evalOptions.root,
    });
    return getImportOverride(state.evalOptions.importOverrides, keyInfo.key);
  };

  // Decides whether eval is allowed to pull a real runtime dependency in, and
  // reports it when it is. Shared by the require() fallback and by the import()
  // path that replaces it for `import` edges, so eval.require keeps the same
  // meaning no matter which loader ends up doing the work.
  const enforceEvalRequirePolicy = ({
    importerFile,
    specifier,
    resolved,
    override,
    mockTarget = null,
  }) => {
    const basePolicy =
      state.evalOptions.require === 'warn-and-run' ? 'warn' : 'error';
    let policy = override?.unknown ?? (override ? 'allow' : basePolicy);
    if (state.evalOptions.require === 'off' && policy !== 'error') {
      policy = 'error';
    }

    if (policy === 'error') {
      throw new Error(
        [
          `[wyw-in-js] require() fallback reached during eval but eval.require='error'.`,
          ``,
          `importer: ${importerFile}`,
          `source:   ${specifier}`,
          `hint: add importOverrides or set eval.require to "warn-and-run".`,
        ].join('\n')
      );
    }

    if (policy !== 'warn') return;

    const key = `${specifier}::${getImporterPackage(importerFile)}`;
    if (warnedRequires.has(key)) return;
    warnedRequires.add(key);
    sendWarn({
      code: 'require-fallback',
      message: [
        `[wyw-in-js] Runtime require() fallback during eval`,
        ``,
        `importer: ${importerFile}`,
        `source:   ${specifier}`,
        `resolved: ${resolved}`,
        mockTarget ? `mock:     ${override.mock} -> ${mockTarget}` : ``,
        ``,
        `hint: use importOverrides to mock runtime-only deps and avoid eval-time requires.`,
      ]
        .filter(Boolean)
        .join('\n'),
      importer: importerFile,
      specifier,
      resolved,
    });
  };

  const createRequireFn = (importer) => {
    const importerFile = stripQueryAndHash(importer);
    const nodeRequire = createRequire(pathToFileURL(importerFile).href);

    return (specifier, nonLiteralOrResolved, maybeResolved) => {
      const hasNonLiteralFlag = typeof nonLiteralOrResolved === 'boolean';
      const nonLiteral = hasNonLiteralFlag ? nonLiteralOrResolved : false;
      const resolvedOverride = hasNonLiteralFlag
        ? maybeResolved
        : nonLiteralOrResolved;
      const hasResolvedOverride =
        typeof resolvedOverride === 'string' && resolvedOverride.length > 0;
      if (state.evalOptions.require === 'off') {
        throw new Error(
          `[wyw-in-js] require() fallback is disabled by eval.require: 'off'.`
        );
      }

      if (nonLiteral || typeof specifier !== 'string') {
        if (state.evalOptions.errors === 'strict') {
          throw new Error(
            `[wyw-in-js] Non-literal require() is not supported during eval.\n` +
              `importer: ${importerFile}\n` +
              `hint: make it a string literal or mock the import via importOverrides.`
          );
        }

        sendWarn({
          code: 'require-error',
          message:
            '[wyw-in-js] Non-literal require() reached during eval (eval.errors: "loose").',
          importer: importerFile,
        });
        return {};
      }

      if (specifier === REACT_REFRESH_VIRTUAL_ID) {
        return reactRefreshRuntime;
      }

      if (
        specifier.startsWith(VITE_VIRTUAL_PREFIX) ||
        specifier.startsWith('virtual:')
      ) {
        return {};
      }

      if (isBuiltinSpecifier(specifier)) {
        const normalized = specifier.startsWith('node:')
          ? specifier.slice(5)
          : specifier;
        if (normalized in builtins) {
          if (builtins[normalized]) {
            return nodeRequire(normalized);
          }
          return null;
        }
      }

      const extensions = NativeModule._extensions;
      const added = [];

      try {
        state.evalOptions.extensions?.forEach((ext) => {
          if (ext === '.cjs' || ext === '.mjs') return;
          if (ext in extensions) return;
          extensions[ext] = NOOP;
          added.push(ext);
        });

        let resolved = hasResolvedOverride
          ? stripQueryAndHash(resolvedOverride)
          : resolveFromImporter(
              stripQueryAndHash(specifier),
              importerFile,
              'require',
              state.evalOptions,
              nodeRequire
            );

        const isFileSpecifier =
          specifier.startsWith('.') || path.isAbsolute(specifier);
        if (
          isFileSpecifier &&
          path.extname(specifier) === '' &&
          resolved.endsWith('.cjs')
        ) {
          const candidate = `${resolved.slice(0, -4)}.js`;
          if (fs.existsSync(candidate)) {
            resolved = candidate;
          }
        }

        const override = getEvalRequireOverride(specifier, resolved);

        let finalResolved = resolved;
        if (override?.mock) {
          finalResolved = resolveMockSpecifier({
            mock: override.mock,
            importer: importerFile,
            root: state.evalOptions.root,
            stack: [importerFile],
          });
        }

        enforceEvalRequirePolicy({
          importerFile,
          specifier,
          resolved,
          override,
          mockTarget: override?.mock ? finalResolved : null,
        });

        return nodeRequire(finalResolved);
      } finally {
        added.forEach((ext) => delete extensions[ext]);
      }
    };
  };

  function createSyntheticModule(id, exportsValue, cache = true) {
    const exportNames = new Set(Object.keys(exportsValue));
    if (!exportNames.has('default')) {
      exportNames.add('default');
    }

    const module = new vm.SyntheticModule(
      [...exportNames],
      function init() {
        exportNames.forEach((key) => {
          const value =
            key === 'default' ? exportsValue.default : exportsValue[key];
          this.setExport(key, value);
        });
      },
      { context: state.context, identifier: id }
    );

    if (cache) {
      moduleCache.set(id, module);
    }
    return module;
  }

  let resolveModule;
  let loadModule;

  const resolveExternalImportTarget = (
    resolvedFile,
    importer,
    specifier,
    kind
  ) => {
    const target = resolvedFile ?? specifier;
    if (path.isAbsolute(target)) {
      return { target: pathToFileURL(target).href, resolvedFile: target };
    }

    // A custom or bundler resolver may deliberately leave an external package
    // as a bare id. Dynamic import resolves bare ids relative to this runner,
    // unlike the old createRequire(importer) path, so resolve the id from the
    // evaluated importer before switching loaders.
    const importerResolved = resolveFromImporter(
      target,
      stripQueryAndHash(importer),
      kind,
      state.evalOptions
    );
    if (path.isAbsolute(importerResolved)) {
      return {
        target: pathToFileURL(importerResolved).href,
        resolvedFile: importerResolved,
      };
    }

    return { target: importerResolved, resolvedFile: null };
  };

  const loadExternalModule = async (
    resolvedId,
    importer,
    specifier,
    kind,
    sessionId = activeSessionId
  ) => {
    if (!isSessionActive(sessionId)) return abandonStaleSession();
    const cacheId = resolvedId ?? specifier;
    const cached = moduleCache.get(cacheId);
    if (cached) return cached;

    const inFlight = externalInFlight.get(cacheId);
    if (inFlight) {
      const result = await inFlight;
      return isSessionActive(sessionId) ? result : abandonStaleSession();
    }

    const task = (async () => {
      const start = Date.now();
      debug('external:start', { specifier, resolvedId, importer });
      const requireFn = createRequireFn(importer);
      const resolvedFile = resolvedId ? stripQueryAndHash(resolvedId) : null;
      const importTarget =
        resolvedFile && path.isAbsolute(resolvedFile)
          ? pathToFileURL(resolvedFile).href
          : specifier;

      const loadWithNode = async () => {
        let value;
        let hasValue = false;

        const extension = resolvedFile ? path.extname(resolvedFile) : '';
        const isImportKind = kind === 'import' || kind === 'dynamic-import';
        const isRequireOnlyAsset =
          extension === '.json' || extension === '.node';
        // Builtins have dedicated handling in createRequireFn and should not be
        // reclassified as eval-time require fallbacks on an import edge.
        const isBuiltin = isBuiltinSpecifier(specifier);

        if (shouldPreferImport(resolvedFile)) {
          value = await import(importTarget);
          hasValue = true;
        } else if (isImportKind && !isRequireOnlyAsset && !isBuiltin) {
          // A failed link elsewhere in the graph can leave an uninstantiated job
          // in Node's ESM registry (for example a barrel that the broker had to
          // take over after an unsupported sibling threw). require() then trips
          // the require-ESM bridge assertion "Unexpected module status 0", and
          // that require() also poisons the entry for any later import(), so the
          // sync attempt has to be skipped rather than retried. JSON and native
          // assets stay on require() because import() needs different
          // assertion/loader semantics for them.
          const importerFile = stripQueryAndHash(importer);
          enforceEvalRequirePolicy({
            importerFile,
            specifier,
            resolved: resolvedFile,
            override: getEvalRequireOverride(specifier, resolvedFile),
          });
          const resolvedImport = resolveExternalImportTarget(
            resolvedFile,
            importer,
            specifier,
            kind
          );
          value = unwrapCjsNamespace(
            await import(resolvedImport.target),
            resolvedImport.resolvedFile
          );
          hasValue = true;
        }
        if (!hasValue) {
          try {
            value = requireFn(specifier, resolvedId ?? null);
            hasValue = true;
          } catch (error) {
            if (!isErrRequireEsm(error)) {
              throw error;
            }

            const isFileSpecifier =
              specifier.startsWith('.') || path.isAbsolute(specifier);
            const isPackageSpecifier =
              !isFileSpecifier && !isBuiltinSpecifier(specifier);
            if (resolvedId && isPackageSpecifier) {
              try {
                value = requireFn(specifier, null);
                hasValue = true;
              } catch (retryError) {
                if (!isErrRequireEsm(retryError)) {
                  throw retryError;
                }
              }
            }

            if (!hasValue) {
              value = await import(importTarget);
              hasValue = true;
            }
          }
        }

        return value;
      };

      let value;
      try {
        value = await loadWithNode();
      } catch (error) {
        if (!isSessionActive(sessionId)) return abandonStaleSession();
        if (
          resolvedFile &&
          isNodeModulesId(resolvedFile) &&
          isUnknownFileExtensionError(error)
        ) {
          debug('external:fallback-broker', {
            specifier,
            resolvedId,
            importer,
            errorCode: error?.code,
          });
          return loadModule(resolvedFile, importer, specifier, sessionId);
        }
        throw error;
      }

      if (!isSessionActive(sessionId)) return abandonStaleSession();

      const module = createSyntheticModule(cacheId, toSyntheticExports(value));
      debug('external:done', {
        specifier,
        resolvedId,
        durationMs: Date.now() - start,
      });
      return module;
    })();

    externalInFlight.set(cacheId, task);
    try {
      const result = await task;
      return isSessionActive(sessionId) ? result : abandonStaleSession();
    } finally {
      if (externalInFlight.get(cacheId) === task) {
        externalInFlight.delete(cacheId);
      }
    }
  };

  const shouldLoadNodeModulesAssetWithBroker = (resolvedId) => {
    if (!isNodeModulesId(resolvedId)) return false;

    const resolvedFile = stripQueryAndHash(resolvedId);
    if (!path.isAbsolute(resolvedFile)) return false;

    const extension = path.extname(resolvedFile);
    if (!extension) return false;
    if (extension === '.json' || extension === '.node') return false;
    return !state.evalOptions.extensions?.includes(extension);
  };

  const shouldLoadAsExternalModule = (
    specifier,
    resolvedId,
    explicitExternal
  ) => {
    if (shouldLoadNodeModulesAssetWithBroker(resolvedId)) {
      return false;
    }

    if (explicitExternal || isBuiltinSpecifier(specifier)) {
      return true;
    }

    return isNodeModulesId(resolvedId);
  };

  const linkModule = async (module, sessionId = activeSessionId) => {
    if (!isSessionActive(sessionId)) return abandonStaleSession();
    const cached = linkPromises.get(module);
    if (cached) {
      const result = await cached;
      return isSessionActive(sessionId) ? result : abandonStaleSession();
    }
    if (module.status !== 'unlinked') return module;
    const linking = (async () => {
      try {
        await module.link((specifier, referencingModule) =>
          resolveModule(
            specifier,
            referencingModule.identifier,
            'import',
            sessionId
          )
        );
        if (!isSessionActive(sessionId)) return abandonStaleSession();
        return module;
      } catch (error) {
        if (!isSessionActive(sessionId)) return abandonStaleSession();
        // The vm SourceTextModule is now in 'errored' (or partially-linked)
        // state and can never be re-linked. With reuseModules:true the cached
        // module would otherwise stick around and short-circuit linkModule's
        // status guard above on the next session — surfacing the original
        // failure forever even after the user fixes the underlying problem.
        // Drop it so the next LOAD rebuilds a fresh SourceTextModule.
        const identifier =
          typeof module.identifier === 'string' ? module.identifier : null;
        if (identifier) {
          evictPoisonedModule(toSourceModuleId(identifier));
        }
        // ERR_VM_MODULE_LINK_FAILURE means a dependency is in "errored" state.
        // Node chains .cause through the link failure hierarchy. Walk to the
        // deepest cause to surface the original evaluation error (e.g. a
        // TypeError in user code), not intermediate "resolved to errored" hops.
        if (error?.code === 'ERR_VM_MODULE_LINK_FAILURE') {
          let rootCause = error;
          while (rootCause.cause instanceof Error) {
            rootCause = rootCause.cause;
          }
          if (rootCause !== error) {
            const enhanced = new Error(
              `${error.message}\n` +
                `  Root cause: ${rootCause.name ?? 'Error'}: ${
                  rootCause.message
                }`
            );
            enhanced.cause = rootCause;
            throw enhanced;
          }
        }
        throw error;
      } finally {
        linkPromises.delete(module);
      }
    })();
    linkPromises.set(module, linking);
    return linking;
  };

  resolveModule = async (
    specifier,
    importer,
    kind,
    sessionId = activeSessionId
  ) => {
    if (!isSessionActive(sessionId)) return abandonStaleSession();
    const importerId = toSourceModuleId(importer);
    if (env.WYW_DEBUG_EVAL_RESOLVE) {
      writeStderr(
        `[wyw-eval-runner:resolve] ${JSON.stringify({
          specifier,
          importer: importerId,
          kind,
        })}\n`
      );
    }
    if (specifier === REACT_REFRESH_VIRTUAL_ID) {
      return createSyntheticModule(specifier, reactRefreshRuntime);
    }

    if (
      specifier.startsWith(VITE_VIRTUAL_PREFIX) ||
      specifier.startsWith('virtual:')
    ) {
      return createSyntheticModule(specifier, { default: {} });
    }

    const key = `${kind}:${importerId}:${specifier}`;
    const cached = resolveCache.get(key);
    if (cached) {
      if (!cached.resolvedId) {
        if (state.evalOptions.errors === 'loose') {
          return createSyntheticModule(specifier, { default: undefined });
        }
        throw new Error(
          [
            `[wyw-in-js] Unable to resolve "${specifier}" during evaluation.`,
            ``,
            `importer: ${importerId}`,
            `hint: check eval.resolver/customResolver or add importOverrides for this specifier.`,
          ].join('\n')
        );
      }

      const normalized = normalizeResolvedId(
        cached.resolvedId,
        specifier,
        importerId,
        state.evalOptions,
        kind
      );
      const treatExternal = shouldLoadAsExternalModule(
        specifier,
        normalized,
        cached.external
      );

      if (treatExternal) {
        const externalModule = await loadExternalModule(
          normalized,
          importerId,
          specifier,
          kind,
          sessionId
        );
        if (!isSessionActive(sessionId)) return abandonStaleSession();
        return externalModule;
      }

      return loadModule(normalized, importerId, specifier, sessionId);
    }

    const inFlight = resolveInFlight.get(key);
    if (inFlight) {
      const result = await inFlight;
      return isSessionActive(sessionId) ? result : abandonStaleSession();
    }

    const task = (async () => {
      const resolved = await request(
        'RESOLVE',
        {
          specifier,
          importerId,
          kind,
        },
        sessionId
      );

      if (resolved.error) {
        throw deserializeError(resolved.error);
      }

      const normalized = resolved.resolvedId
        ? normalizeResolvedId(
            resolved.resolvedId,
            specifier,
            importerId,
            state.evalOptions,
            kind
          )
        : resolved.resolvedId;
      if (env.WYW_DEBUG_EVAL_RESOLVE) {
        writeStderr(
          `[wyw-eval-runner:resolved] ${JSON.stringify({
            specifier,
            importer: importerId,
            resolved: resolved.resolvedId ?? null,
            normalized: normalized ?? null,
            external: Boolean(resolved.external),
          })}\n`
        );
      }

      resolveCache.set(key, {
        resolvedId: normalized,
        external: Boolean(resolved.external),
      });

      if (!normalized) {
        if (state.evalOptions.errors === 'loose') {
          return createSyntheticModule(specifier, { default: undefined });
        }
        throw new Error(
          [
            `[wyw-in-js] Unable to resolve "${specifier}" during evaluation.`,
            ``,
            `importer: ${importerId}`,
            `hint: check eval.resolver/customResolver or add importOverrides for this specifier.`,
          ].join('\n')
        );
      }

      const treatExternal = shouldLoadAsExternalModule(
        specifier,
        normalized,
        resolved.external
      );

      if (treatExternal) {
        return loadExternalModule(
          normalized,
          importerId,
          specifier,
          kind,
          sessionId
        );
      }

      return loadModule(normalized, importerId, specifier, sessionId);
    })();

    resolveInFlight.set(key, task);
    try {
      const result = await task;
      return isSessionActive(sessionId) ? result : abandonStaleSession();
    } finally {
      if (resolveInFlight.get(key) === task) {
        resolveInFlight.delete(key);
      }
    }
  };

  const loadModuleUnqueued = async (
    id,
    importer,
    requestSpec,
    sessionId,
    sessionRef
  ) => {
    if (!isSessionActive(sessionId)) return abandonStaleSession();
    let cached = moduleCache.get(id);
    const loadStart = Date.now();
    const loaded = await request(
      'LOAD',
      {
        id,
        importerId: importer,
        request: requestSpec ?? null,
      },
      sessionId
    );
    if (!isSessionActive(sessionId)) return abandonStaleSession();
    debug('load:done', {
      id,
      importer,
      durationMs: Date.now() - loadStart,
    });
    if (loaded.error) {
      // Surface the importer + specifier alongside the broker's message.
      // Without this, ENOENT and similar load failures bubble up as a bare
      // path (or, after Node's VM wraps them, as the opaque
      // ERR_VM_MODULE_STATUS) leaving no clue which file's import is broken.
      const detail = [
        `[wyw-in-js] Failed to load module during evaluation.`,
        `  importer: ${importer ?? '(unknown)'}`,
        `  request:  ${requestSpec ?? id}`,
        `  resolved: ${id}`,
        `  cause:    ${loaded.error.message}`,
      ].join('\n');
      // The importer's SourceTextModule (if it was already created and
      // cached) compiled this `import` against `id`; reusing it next session
      // would link against the same id and either re-trigger the failure or
      // skip linking via the status guard. Drop both so the next session
      // pulls fresh code for both ends of the broken edge.
      if (importer && importer !== id) {
        evictPoisonedModule(toSourceModuleId(importer));
      }
      evictPoisonedModule(id);
      const enhanced = new Error(detail);
      enhanced.cause = deserializeError(loaded.error);
      throw enhanced;
    }

    cached = moduleCache.get(id);
    try {
      if (loaded.resetModule === true) {
        resetSingleModuleState(id);
        moduleOnly.delete(id);
        cached = undefined;

        if (id === state.entrypoint) {
          resolveCache.clear();
        }
      }

      if (loaded.only) {
        const current = moduleOnly.get(id) ?? [];
        moduleOnly.set(id, mergeOnly(current, loaded.only));
      }

      if (loaded.exports) {
        // Serialized exports are a narrow slice — only the keys the importer
        // requested. If we have a fully evaluated module (in moduleCache or as
        // a variant), prefer it: its namespace has ALL exports, so any consumer
        // can link against it without "does not provide export" errors.
        //
        // An evaluated variant is only safe to reuse when its namespace covers
        // the serialized key set. A narrow variant that was evaluated first may
        // lack exports that a wider consumer needs (the 4df6e915 race).
        const requiredKeys = Object.keys(loaded.exports);
        const coversKeys = (mod) => {
          const ns = mod.namespace;
          return requiredKeys.every((k) => k in ns);
        };

        let evaluated =
          cached && cached.status === 'evaluated' && coversKeys(cached)
            ? cached
            : undefined;

        if (!evaluated) {
          const variants = moduleVariants.get(id);
          if (variants) {
            evaluated = Array.from(variants.values()).find(
              (variant) => variant.status === 'evaluated' && coversKeys(variant)
            );
          }
        }

        if (evaluated) {
          return evaluated;
        }

        // Reuse a previously created SyntheticModule for this exact serialized set
        if (loaded.hash) {
          const existing = getModuleVariant(id, loaded.hash);
          if (existing) {
            return existing;
          }
        }

        const exportsValue = {};
        Object.entries(loaded.exports).forEach(([key, serialized]) => {
          exportsValue[key] = deserializeValue(serialized);
        });
        const module = createSyntheticModule(id, exportsValue, false);
        if (loaded.hash) {
          setModuleVariant(id, loaded.hash, module);
        }
        return module;
      }

      const usePrimaryCache = isFullModuleLoad(loaded);
      if (usePrimaryCache) {
        const current = moduleCache.get(id);
        if (current && loaded.hash && moduleHashes.get(id) === loaded.hash) {
          return current;
        }
      } else if (loaded.hash) {
        const variant = getModuleVariant(id, loaded.hash);
        if (variant) {
          return variant;
        }
      }

      // The broker omits `code` entirely when it expects the runner to reuse a
      // cached module via the hash-match short-circuit above — an empty
      // string is a legitimate LoadResult in its own right (a module whose
      // runtime footprint genuinely shakes down to zero bytes, e.g. a
      // types-only module reached through a barrel's `export *`). Reaching
      // this point with `code` truly absent means the broker's "what runner
      // has" mirror is out of sync with our actual moduleCache/moduleVariants
      // — fail loudly rather than feeding undefined source into
      // vm.SourceTextModule.
      if (loaded.code == null) {
        throw new Error(
          `[wyw-in-js] LoadResult for ${id} has no code but no cached module ` +
            `matched hash ${loaded.hash ?? '(none)'}. ` +
            `This indicates a broker/runner cache desync.`
        );
      }

      if (usePrimaryCache) {
        resetSingleModuleState(id, cached);
      }

      const module = new vm.SourceTextModule(
        `${buildPreamble(id)}${loaded.code ?? ''}`,
        {
          context: state.context,
          identifier: toVersionedModuleIdentifier(id, loaded.hash),
          initializeImportMeta(meta, targetModule) {
            const identifier =
              typeof targetModule.identifier === 'string'
                ? targetModule.identifier
                : id;
            const fileId = stripQueryAndHash(identifier);
            // eslint-disable-next-line no-param-reassign
            meta.url = path.isAbsolute(fileId)
              ? pathToFileURL(fileId).href
              : fileId;
          },
          importModuleDynamically(specifier, referencingModule) {
            const dynamicSessionId = sessionRef.id;
            return resolveModule(
              specifier,
              referencingModule.identifier,
              'dynamic-import',
              dynamicSessionId
            );
          },
        }
      );

      if (usePrimaryCache) {
        moduleCache.set(id, module);
        if (loaded.hash) {
          moduleHashes.set(id, loaded.hash);
        }
      } else if (loaded.hash) {
        setModuleVariant(id, loaded.hash, module);
      }
      return module;
    } catch (error) {
      if (importer && importer !== id) {
        evictPoisonedModule(toSourceModuleId(importer));
      }
      evictPoisonedModule(id);
      throw error;
    }
  };

  loadModule = async (
    id,
    importer,
    requestSpec,
    sessionId = activeSessionId
  ) => {
    if (!isSessionActive(sessionId)) return abandonStaleSession();
    const sessionRef = activeSessionRef;
    const predecessor = loadInFlight.get(id);
    const task = predecessor
      ? (async () => {
          await predecessor;
          if (!isSessionActive(sessionId)) return abandonStaleSession();
          return loadModuleUnqueued(
            id,
            importer,
            requestSpec,
            sessionId,
            sessionRef
          );
        })()
      : loadModuleUnqueued(id, importer, requestSpec, sessionId, sessionRef);
    loadInFlight.set(id, task);
    try {
      const result = await task;
      return isSessionActive(sessionId) ? result : abandonStaleSession();
    } finally {
      if (loadInFlight.get(id) === task) {
        loadInFlight.delete(id);
      }
    }
  };

  const createDynamicImportFn = (importer, sessionRef) => {
    return async (specifier) => {
      const sessionId = sessionRef.id;
      if (typeof specifier !== 'string') {
        sendWarn({
          code: 'eval-error',
          message:
            '[wyw-in-js] Dynamic import with non-string specifier during eval.',
          importer,
        });
        if (state.evalOptions.errors === 'strict') {
          throw new Error(
            `[wyw-in-js] Dynamic import with non-string specifier is not supported during eval.\n` +
              `importer: ${importer}\n` +
              `hint: make it a string literal or mock the import via importOverrides.`
          );
        }
        return createSyntheticModule(`dynamic:${String(specifier)}`, {
          default: undefined,
        });
      }

      sendWarn({
        code: 'dynamic-import',
        message: `[wyw-in-js] Dynamic import executed during eval: ${specifier}`,
        importer,
        specifier,
      });

      const resolved = await resolveModule(
        specifier,
        importer,
        'dynamic-import',
        sessionId
      );
      if (!isSessionActive(sessionId)) return abandonStaleSession();
      await linkModule(resolved, sessionId);
      if (!isSessionActive(sessionId)) return abandonStaleSession();
      const evaluation = resolved.evaluate();
      dynamicEvaluations.add(evaluation);
      try {
        await evaluation;
      } catch (error) {
        // A fire-and-forget import from an old VM may reject after INIT has
        // installed a replacement context. Keep that stale promise abandoned
        // instead of turning its rejection into an unhandled process failure.
        if (!isSessionActive(sessionId)) return abandonStaleSession();
        throw error;
      } finally {
        dynamicEvaluations.delete(evaluation);
      }
      if (!isSessionActive(sessionId)) return abandonStaleSession();
      return resolved;
    };
  };

  const getModuleData = (id, sessionRef = activeSessionRef) => {
    const cached = moduleData.get(id);
    if (cached) return cached;

    const filename = stripQueryAndHash(id);
    const exportsValue = {};
    const moduleObj = { exports: exportsValue };
    const data = {
      exports: exportsValue,
      module: moduleObj,
      require: createRequireFn(id),
      filename,
      dirname: path.dirname(filename),
      dynamicImport: createDynamicImportFn(id, sessionRef),
    };

    moduleData.set(id, data);
    return data;
  };

  const collectModuleExports = () => {
    const exportsByModule = {};
    const debugEvalFiles = state.debugEvalFiles ? {} : undefined;

    moduleOnly.forEach((only, id) => {
      if (!only || only.length === 0) return;

      const module = moduleCache.get(id) ?? moduleLastVariant.get(id);
      const data = moduleData.get(id);
      if (!module || !data) return;

      // The broker already has the serialized exports for this exact variant
      // from a prior eval session. Re-serializing here just wastes CPU on the
      // runner side and bloats the EVAL_RESULT payload. Same variant identifier
      // ⇒ same namespace ⇒ no change to send.
      const moduleIdentifier =
        typeof module.identifier === 'string' ? module.identifier : id;
      if (sentNamespaceIdentifiers.get(id) === moduleIdentifier) {
        return;
      }

      // .namespace is only safe on fully evaluated modules. Modules that
      // errored or were never evaluated (stale from a prior failed session
      // with reuseModules) have TDZ bindings that crash Object.keys().
      if (module.status !== 'evaluated') {
        sendWarn({
          code: 'eval-stale-module',
          message:
            `[wyw-in-js] Skipping export collection for ${id}: ` +
            `module status is "${module.status}" (expected "evaluated"). ` +
            `Cached exports for this module may be stale.`,
        });
        return;
      }

      const { namespace } = module;
      const hasNamespace =
        namespace &&
        typeof namespace === 'object' &&
        Object.keys(namespace).length;
      const source = hasNamespace ? namespace : data.module.exports;

      const discoveredKeys = Object.keys(source ?? {}).filter(
        (key) => key !== '__wywPreval' && key !== 'side-effect' && key !== '*'
      );
      const requestedKeys = only.filter(
        (key) => key !== '__wywPreval' && key !== 'side-effect' && key !== '*'
      );
      const keys = Array.from(new Set([...requestedKeys, ...discoveredKeys]));

      if (keys.length === 0) return;

      const serialized = {};
      const debugExports = state.debugEvalFiles ? {} : undefined;
      keys.forEach((key) => {
        const value = resolveExportValue(source, key);
        try {
          serialized[key] = serializeValue(value, {
            rootLabel: 'module exports',
            path: [id, key],
          });
          if (debugExports) {
            debugExports[key] = {
              serialized: serialized[key],
              status: 'serialized',
            };
          }
        } catch (error) {
          if (debugExports) {
            debugExports[key] = {
              reason: serializeDebugReason(error),
              status: 'stringified',
              stringified: stringifyDebugValue(value),
            };
          }
          // Skip non-serializable exports when caching eval values.
        }
      });

      if (debugEvalFiles && debugExports && Object.keys(debugExports).length) {
        debugEvalFiles[id] = {
          exports: debugExports,
        };
      }

      if (Object.keys(serialized).length) {
        exportsByModule[id] = serialized;
        sentNamespaceIdentifiers.set(id, moduleIdentifier);
      }
    });

    return { debugEvalFiles, modules: exportsByModule };
  };

  async function evaluateEntrypoint(id) {
    const sessionId = activeSessionId;
    const evalStart = Date.now();
    debug('eval:start', id);
    const module = await loadModule(id, id, id, sessionId);
    debug('eval:loaded', { id, durationMs: Date.now() - evalStart });
    await linkModule(module, sessionId);
    debug('eval:linked', { id, durationMs: Date.now() - evalStart });
    await module.evaluate();
    debug('eval:evaluated', { id, durationMs: Date.now() - evalStart });

    const data = getModuleData(id);
    const exportsValue = data.module.exports;
    const hasPrevalExport =
      exportsValue &&
      typeof exportsValue === 'object' &&
      '__wywPreval' in exportsValue;
    const { namespace } = module;
    const hasPrevalNamespace =
      namespace && typeof namespace === 'object' && '__wywPreval' in namespace;

    const { debugEvalFiles, modules } = collectModuleExports();

    if (!hasPrevalExport && !hasPrevalNamespace) {
      return { debugEvalFiles, values: null, modules };
    }

    const preval = hasPrevalExport
      ? exportsValue.__wywPreval
      : namespace.__wywPreval;
    if (!preval || typeof preval !== 'object') {
      return { debugEvalFiles, values: null, modules };
    }

    const values = {};
    const debugPreval = state.debugEvalFiles ? {} : undefined;
    Object.entries(preval).forEach(([key, lazy]) => {
      let value;
      try {
        value = typeof lazy === 'function' ? lazy() : lazy;
      } catch (error) {
        value = error;
      }
      Object.assign(values, serializePreval({ [key]: value }));
      if (debugPreval) {
        debugPreval[key] = {
          serialized: values[key],
          status: 'serialized',
        };
      }
    });

    if (debugEvalFiles && debugPreval && Object.keys(debugPreval).length) {
      debugEvalFiles[id] = {
        ...(debugEvalFiles[id] ?? {}),
        preval: debugPreval,
      };
    }

    return { debugEvalFiles, values, modules };
  }

  const handleMessage = async (message) => {
    switch (message.type) {
      case 'INIT': {
        const initSessionId = Number.isSafeInteger(message.payload.sessionId)
          ? message.payload.sessionId
          : activeSessionId + 1;
        try {
          const initStart = Date.now();
          debug('init:start', message.payload.entrypoint ?? 'eval-runner');
          const sessionChanged = initSessionId !== activeSessionId;
          const hasUnfinishedSessionWork =
            sessionChanged &&
            (pending.size > 0 ||
              loadResultChunks.size > 0 ||
              loadInFlight.size > 0 ||
              externalInFlight.size > 0 ||
              dynamicEvaluations.size > 0 ||
              resolveInFlight.size > 0 ||
              linkPromises.size > 0);
          activeSessionId = initSessionId;
          if (sessionChanged) {
            // Requests from the previous logical session must never resume
            // inside the context initialized below. Dropping them keeps
            // abandoned fire-and-forget imports pending without producing
            // unhandled errors.
            pending.clear();
            loadResultChunks.clear();
          }
          const encodedGlobals = message.payload.evalOptions.globals ?? {};
          const nextGlobalsSignature = JSON.stringify(
            canonicalizeForHash(encodedGlobals)
          );
          const nextFeatures = message.payload.features ?? {};
          const nextDebugEvalFiles = Boolean(message.payload.debugEvalFiles);
          const nextEntrypoint = message.payload.entrypoint ?? 'eval-runner';
          const nextHappyDomEnabled = isFeatureEnabled(
            nextFeatures,
            'happyDOM',
            nextEntrypoint
          );
          const globalsChanged =
            state.globalsSignature !== null &&
            state.globalsSignature !== nextGlobalsSignature;
          const reuseModules = Boolean(message.payload.reuseModules);
          const nextGlobals =
            reuseModules && !globalsChanged && state.globalsSignature !== null
              ? state.evalOptions.globals
              : decodeGlobals(encodedGlobals, evaluateGlobalFunction);
          const nextEvalOptions = {
            ...message.payload.evalOptions,
            globals: nextGlobals,
          };

          const canReuseContext =
            state.context &&
            state.happyDomEnabled === nextHappyDomEnabled &&
            !globalsChanged &&
            !hasUnfinishedSessionWork;

          if (canReuseContext && reuseModules) {
            activeSessionRef.id = initSessionId;
            // Clear resolution caches between sessions even when reusing modules.
            // The broker rebuilds onlyByModule from scratch each session (cleared
            // in evaluate()). If the runner's resolveCache persists, RESOLVE
            // requests for previously-seen (importer, specifier) pairs are
            // skipped, preventing the broker from learning what exports are
            // needed. This can cause a barrel module to be served with a stale
            // `only` set that's missing exports a consumer actually imports,
            // leading to "does not provide an export named 'X'" link errors.
            resolveCache.clear();
            resolveInFlight.clear();
            loadInFlight.clear();
            state.evalOptions = nextEvalOptions;
            state.features = nextFeatures;
            state.debugEvalFiles = nextDebugEvalFiles;
            state.entrypoint = nextEntrypoint;
            Object.assign(state.context, {
              __dirname: path.dirname(nextEntrypoint),
              __filename: nextEntrypoint,
              ...nextEvalOptions.globals,
              __wyw_getModule: (moduleId) =>
                getModuleData(moduleId, activeSessionRef),
            });
            state.globalsSignature = nextGlobalsSignature;
            debug('init:reuse', Date.now() - initStart);
            send({
              type: 'INIT_ACK',
              id: message.id,
              modulesReset: false,
            });
            break;
          }

          resetEvaluationState();
          state.evalOptions = nextEvalOptions;
          state.features = nextFeatures;
          state.debugEvalFiles = nextDebugEvalFiles;
          state.entrypoint = nextEntrypoint;
          debug('init:globals', Date.now() - initStart);
          const nextSessionRef = { id: initSessionId };

          const windowStart = Date.now();
          const { context, teardown } = await createVmContext(
            state.entrypoint,
            state.features,
            {
              ...state.evalOptions.globals,
              __wyw_getModule: (moduleId) =>
                getModuleData(moduleId, nextSessionRef),
            }
          );
          if (!isSessionActive(initSessionId)) {
            teardown();
            break;
          }
          debug('init:context', Date.now() - windowStart);
          activeSessionRef = nextSessionRef;
          state.context = context;
          state.teardown = teardown;
          state.happyDomEnabled = nextHappyDomEnabled;
          state.globalsSignature = nextGlobalsSignature;

          // Full context rebuild ⇒ moduleCache was cleared by resetEvaluationState.
          send({ type: 'INIT_ACK', id: message.id, modulesReset: true });
          debug('init:done', Date.now() - initStart);
        } catch (error) {
          if (!isSessionActive(initSessionId)) break;
          send({
            type: 'INIT_ACK',
            id: message.id,
            error: serializeError(error),
          });
        }
        break;
      }
      case 'EVAL': {
        evictedThisSession.clear();
        try {
          const { debugEvalFiles, values, modules } = await evaluateEntrypoint(
            message.payload.id
          );
          send({
            type: 'EVAL_RESULT',
            id: message.id,
            payload: {
              ...(debugEvalFiles ? { debugEvalFiles } : {}),
              values,
              modules,
              evictedIds: Array.from(evictedThisSession),
            },
          });
        } catch (error) {
          send({
            type: 'EVAL_RESULT',
            id: message.id,
            payload: {
              values: null,
              evictedIds: Array.from(evictedThisSession),
            },
            error: serializeError(error),
          });
        }
        break;
      }
      case 'RESOLVE_RESULT': {
        resolvePending(message.id, message.payload);
        break;
      }
      case 'LOAD_RESULT': {
        handleLoadResult(message.id, message.payload);
        break;
      }
      default:
        break;
    }
  };

  // stdin carries one JSON message per line. A line that is not a protocol
  // message is reported on stderr and dropped instead of taking the runner, and
  // every evaluation in flight with it, down.
  const parseStdinMessage = (line) => {
    let message;
    let problem = null;
    try {
      message = JSON.parse(line);
      if (
        !isPlainObject(message) ||
        typeof message.type !== 'string' ||
        !isPlainObject(message.payload)
      ) {
        problem = 'not a protocol message';
      }
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }

    if (problem === null) return message;

    const preview =
      line.length > MALFORMED_MESSAGE_PREVIEW_LENGTH
        ? `${line.slice(0, MALFORMED_MESSAGE_PREVIEW_LENGTH)}… (${
            line.length
          } chars)`
        : line;
    writeStderr(
      `[wyw-eval-runner] Dropped malformed stdin message (${problem}): ${preview}\n`
    );
    return null;
  };

  const teardown = () => {
    if (state.teardown) {
      state.teardown();
    }
  };

  return { handleMessage, parseStdinMessage, teardown };
};
