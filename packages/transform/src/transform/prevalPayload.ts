import type { ValueCache } from '@wyw-in-js/processor-utils';
import { isPlainObject } from '@wyw-in-js/shared';
import type { EvalStrategy } from '@wyw-in-js/shared';
import { isDeepStrictEqual } from 'util';

export type PrevalPayloadSource = 'eval' | 'static';

export type PrevalPayload = {
  dependencies: string[];
  sources: Map<string, PrevalPayloadSource>;
  values: ValueCache;
};

export type CreatePrevalPayloadInput = {
  emitWarning?: (message: string) => void;
  evalDependencies?: readonly string[];
  evalValues?: Map<string, unknown> | null;
  filename: string;
  strategy: EvalStrategy;
  staticDependencies?: readonly string[];
  staticNullWYWMetaExtendsHelpers?: readonly string[];
  staticValues?: Map<string, unknown> | null;
};

const addUnique = <T>(target: T[], value: T): void => {
  if (!target.includes(value)) {
    target.push(value);
  }
};

type OwnDataProperty = { exists: false } | { exists: true; value: unknown };

type WywMetaNode = {
  className: string;
  displayName: string | undefined;
  extends: unknown;
  value: object;
};

const getOwnDataProperty = (
  value: object,
  key: PropertyKey
): OwnDataProperty | null => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    return { exists: false };
  }

  return 'value' in descriptor
    ? { exists: true, value: descriptor.value }
    : null;
};

const hasOnlyOwnKeys = (value: object, allowed: readonly string[]): boolean =>
  Reflect.ownKeys(value).every(
    (key) => typeof key === 'string' && allowed.includes(key)
  );

const getWywMetaNode = (value: unknown): WywMetaNode | null => {
  if (
    !isPlainObject(value) ||
    !hasOnlyOwnKeys(value, ['__wyw_meta', 'displayName'])
  ) {
    return null;
  }

  const metaProperty = getOwnDataProperty(value, '__wyw_meta');
  if (
    !metaProperty?.exists ||
    !isPlainObject(metaProperty.value) ||
    !hasOnlyOwnKeys(metaProperty.value, ['className', 'extends'])
  ) {
    return null;
  }

  const className = getOwnDataProperty(metaProperty.value, 'className');
  const extended = getOwnDataProperty(metaProperty.value, 'extends');
  const displayName = getOwnDataProperty(value, 'displayName');
  const displayNameValue = displayName?.exists ? displayName.value : undefined;
  if (
    !className?.exists ||
    typeof className.value !== 'string' ||
    !extended?.exists ||
    displayName === null ||
    (displayNameValue !== undefined && typeof displayNameValue !== 'string')
  ) {
    return null;
  }

  return {
    className: className.value,
    displayName: displayNameValue,
    extends: extended.value,
    value,
  };
};

// End of an `extends` chain that carries no Linaria meta: `null` is the
// static model's spelling of an opaque component, a meta-less function is the
// evaluator's (it shakes a plain component to a bare stub). Objects are not
// accepted here on purpose: a React.lazy value is an object and changes the
// emitted selector, so losing it to `null` must still be reported.
const isMetaFreeFunction = (value: unknown): value is () => unknown =>
  typeof value === 'function' && !('__wyw_meta' in value);

const haveEquivalentOpaqueEnds = (
  evalValue: unknown,
  staticValue: unknown
): boolean =>
  (evalValue === null && staticValue === null) ||
  (isMetaFreeFunction(evalValue) && staticValue === null);

// Under the hybrid strategy the two rounds can spell the same styled target
// differently: the evaluator produces `{ displayName, __wyw_meta }` objects
// whose chain ends in a stub function, the static resolver produces bare
// `{ __wyw_meta }` objects whose chain ends in `null`. Every consumer walks
// `__wyw_meta.className` / `__wyw_meta.extends` and stops at the first value
// without meta, so two values with the same class-name chain and an opaque
// end on both sides are agreement, not drift.
const haveEquivalentWywMetaChains = (
  evalValue: unknown,
  staticValue: unknown,
  allowOpaqueRoot: boolean
): boolean => {
  try {
    const seenEval = new Set<object>();
    const seenStatic = new Set<object>();
    let currentEval = evalValue;
    let currentStatic = staticValue;
    let depth = 0;

    for (;;) {
      const evalNode = getWywMetaNode(currentEval);
      const staticNode = getWywMetaNode(currentStatic);
      if (evalNode || staticNode) {
        if (
          !evalNode ||
          !staticNode ||
          seenEval.has(evalNode.value) ||
          seenStatic.has(staticNode.value) ||
          evalNode.className !== staticNode.className ||
          (staticNode.displayName !== undefined &&
            evalNode.displayName !== staticNode.displayName)
        ) {
          return false;
        }

        seenEval.add(evalNode.value);
        seenStatic.add(staticNode.value);
        currentEval = evalNode.extends;
        currentStatic = staticNode.extends;
        depth += 1;
      } else {
        return (
          (depth > 0 || allowOpaqueRoot) &&
          haveEquivalentOpaqueEnds(currentEval, currentStatic)
        );
      }
    }
  } catch {
    // Deferred IPC fields and hostile accessors/proxies are not proof of
    // equivalence. Fall through to the regular disagreement path.
    return false;
  }
};

const isSafelyDeepStrictEqual = (left: unknown, right: unknown): boolean => {
  try {
    return isDeepStrictEqual(left, right);
  } catch {
    // Deferred eval fields throw when observed. A value that cannot be fully
    // compared is not proven equal, so preserve the existing disagreement
    // handling and static-value precedence.
    return false;
  }
};

const formatDiagnosticValue = (value: unknown): string => {
  try {
    return String(value);
  } catch {
    return '<unprintable>';
  }
};

const emitProductionWarning = (
  emitWarning: ((message: string) => void) | undefined,
  message: string
): void => {
  if (emitWarning) {
    emitWarning(message);
    return;
  }

  // eslint-disable-next-line no-console
  console.warn(message);
};

const handleDisagreement = (
  filename: string,
  name: string,
  evalValue: unknown,
  staticValue: unknown,
  emitWarning: ((message: string) => void) | undefined
): void => {
  const message = [
    `[wyw-in-js] PrevalPayload disagreement for "${name}" in ${filename}.`,
    'Static and evaluated values differ; keeping the static value to preserve baseline precedence.',
    `eval: ${formatDiagnosticValue(evalValue)}`,
    `static: ${formatDiagnosticValue(staticValue)}`,
  ].join(' ');

  if (process.env.NODE_ENV === 'production') {
    emitProductionWarning(emitWarning, message);
    return;
  }

  throw new Error(message);
};

export const createPrevalPayload = ({
  emitWarning,
  evalDependencies = [],
  evalValues,
  filename,
  strategy,
  staticDependencies = [],
  staticNullWYWMetaExtendsHelpers = [],
  staticValues,
}: CreatePrevalPayloadInput): PrevalPayload => {
  const dependencies: string[] = [];
  const sources = new Map<string, PrevalPayloadSource>();
  const values: ValueCache = new Map();
  const staticOpaqueValueNames = new Set(staticNullWYWMetaExtendsHelpers);

  if (strategy !== 'static') {
    evalDependencies.forEach((dependency) =>
      addUnique(dependencies, dependency)
    );
    evalValues?.forEach((value, name) => {
      values.set(name, value);
      sources.set(String(name), 'eval');
    });
  }

  if (strategy !== 'execute') {
    staticDependencies.forEach((dependency) =>
      addUnique(dependencies, dependency)
    );
    staticValues?.forEach((value, name) => {
      if (
        values.has(name) &&
        !isSafelyDeepStrictEqual(values.get(name), value) &&
        !haveEquivalentWywMetaChains(
          values.get(name),
          value,
          staticOpaqueValueNames.has(String(name))
        )
      ) {
        handleDisagreement(
          filename,
          String(name),
          values.get(name),
          value,
          emitWarning
        );
      }

      values.set(name, value);
      sources.set(String(name), 'static');
    });
  }

  return {
    dependencies,
    sources,
    values,
  };
};
