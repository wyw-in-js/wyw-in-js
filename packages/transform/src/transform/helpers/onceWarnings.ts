import type { EvalRule, StrictOptions } from '@wyw-in-js/shared';

/**
 * One-time warnings about the configuration and deprecated API of transform,
 * and about places in a file whose build output may change in 3.0.
 *
 * This module owns the record of the warnings already reported. The record
 * lives as long as the process (each worker thread has its own) and is never
 * reset: most warnings describe the setup rather than a file, and adapters that
 * build options for every file would repeat them otherwise. A warning about a
 * place in a file is reported once per place, also when the file is
 * transformed again. Nothing that affects the output depends on it.
 */
type OnceWarningId =
  | 'config-css-options'
  | 'custom-handlers'
  | 'custom-resolver-missing'
  | 'rules-conflict'
  | 'static-var-read-before-declaration';

const reported = new Set<string>();

const warnOnce = (
  id: OnceWarningId,
  report: () => void,
  place?: string
): void => {
  const key = place === undefined ? id : `${id}\0${place}`;
  if (reported.has(key)) {
    return;
  }

  reported.add(key);
  report();
};

export const CUSTOM_HANDLERS_DEPRECATION_CODE =
  'WYW_CUSTOM_HANDLERS_DEPRECATED';

export const warnCustomHandlersDeprecated = (): void =>
  warnOnce('custom-handlers', () => {
    process.emitWarning(
      '[wyw-in-js] The `customHandlers` argument of `transform()` is deprecated and will be removed in 3.0. ' +
        'It replaces internal stages of the action runner, which are not a stable API. ' +
        'To observe stages, pass an `eventEmitter` in the services.',
      { code: CUSTOM_HANDLERS_DEPRECATION_CODE, type: 'DeprecationWarning' }
    );
  });

/**
 * Reports, once per place, an expression that `eval.strategy` "static" gives
 * the value earlier versions computed, because it reads a `var` before its
 * declaration and no value is known where the expression runs.
 */
export const warnStaticVarReadBeforeDeclaration = ({
  column,
  filename,
  line,
  source,
}: {
  /** Zero-based. */
  column: number;
  filename: string;
  line: number;
  source: string;
}): void => {
  const place = `${filename}:${line}:${column + 1}`;
  // TODO(3.0): throw instead; this is a breaking change.
  warnOnce(
    'static-var-read-before-declaration',
    () => {
      // eslint-disable-next-line no-console
      console.warn(
        `[wyw-in-js] ${place}: eval.strategy "static" cannot determine the value of \`${source}\`: ` +
          'it reads a `var` before its declaration, and the value the variable has where this code runs is not statically known. ' +
          'The value that earlier versions computed is used instead, and evaluation may compute another one. ' +
          'Assign the variable once, in a declaration above the code that reads it, or use eval.strategy "hybrid". ' +
          'This will be an error in wyw-in-js 3.0.'
      );
    },
    place
  );
};

// Options of the bundler plugins (and CLI flags) that transform reads only
// from its call options, never from the config file.
const CSS_OPTION_KEYS = ['prefixer', 'keepComments', 'preprocessor'] as const;

export const formatKeys = (keys: readonly string[]): string => {
  const quoted = keys.map((key) => `\`${key}\``);
  return quoted.length > 1
    ? `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
    : quoted[0]!;
};

// Rules rebuilt from the same source, such as a config file that a plugin
// also imports, count as equal: their functions differ only by identity.
const sameRulePart = (left: unknown, right: unknown): boolean => {
  if (left === right) {
    return true;
  }
  if (typeof left === 'function' && typeof right === 'function') {
    return String(left) === String(right);
  }
  if (left instanceof RegExp && right instanceof RegExp) {
    return String(left) === String(right);
  }
  if (
    left &&
    right &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    !(left instanceof RegExp) &&
    !(right instanceof RegExp)
  ) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(right, key) &&
          sameRulePart(
            (left as Record<string, unknown>)[key],
            (right as Record<string, unknown>)[key]
          )
      )
    );
  }
  return false;
};

const sameRules = (left: unknown, right: unknown): boolean =>
  Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length &&
      left.every((rule, index) => sameRulePart(rule, right[index]))
    : sameRulePart(left, right);

/**
 * Reports, once per process, options that are loaded but do not work as they
 * read. The options themselves are used unchanged.
 */
export const warnAboutLoadedOptions = ({
  configFileOptions,
  options,
  pluginRules,
}: {
  /** Options from the config file. */
  configFileOptions: Partial<StrictOptions> & Record<string, unknown>;
  /** The merged options. */
  options: StrictOptions;
  /** `rules` passed to the plugin, without the defaults. */
  pluginRules: EvalRule[] | undefined;
}): void => {
  if (
    options.eval?.resolver === 'custom' &&
    typeof options.eval.customResolver !== 'function'
  ) {
    // TODO(3.0): throw instead; this is a breaking change.
    warnOnce('custom-resolver-missing', () => {
      // eslint-disable-next-line no-console
      console.warn(
        '[wyw-in-js] `eval.resolver` is "custom", but `eval.customResolver` is not set, ' +
          'so imports in evaluated code cannot be resolved (the prepare stage still resolves them through the bundler). ' +
          'Set `eval.customResolver` or use another `eval.resolver`. This will be an error in wyw-in-js 3.0.'
      );
    });
  }

  if (
    pluginRules !== undefined &&
    configFileOptions.rules !== undefined &&
    !sameRules(pluginRules, configFileOptions.rules)
  ) {
    // TODO(3.0): the plugin `rules` take precedence; this is a breaking change.
    warnOnce('rules-conflict', () => {
      // eslint-disable-next-line no-console
      console.warn(
        '[wyw-in-js] Both the config file and the plugin options set `rules`, and they differ. ' +
          'The `rules` from the config file are used, and the plugin `rules` are ignored. ' +
          'Set `rules` in one place. In wyw-in-js 3.0, the plugin options will take precedence.'
      );
    });
  }

  const cssOptionKeys = CSS_OPTION_KEYS.filter(
    (key) => configFileOptions[key] !== undefined
  );
  if (cssOptionKeys.length > 0) {
    const [subject, verb, object] =
      cssOptionKeys.length > 1
        ? ['these options are', 'have', 'them']
        : ['this option is', 'has', 'it'];
    warnOnce('config-css-options', () => {
      // eslint-disable-next-line no-console
      console.warn(
        `[wyw-in-js] The config file sets ${formatKeys(cssOptionKeys)}, ` +
          `but ${subject} not read from the config file and ${verb} no effect there. ` +
          `Set ${object} in the options of the bundler plugin or with CLI flags, where supported.`
      );
    });
  }
};
