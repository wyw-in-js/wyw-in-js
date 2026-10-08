/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import { isAbsolute, relative } from 'path';

import type { Program } from 'oxc-parser';

import { parseOxcProgram } from '../../../utils/oxc/parse';
import { stripQueryAndHash } from '../../../utils/parseRequest';
import type { ITransformAction } from '../../types';
import type { StaticResolveDebugEvent } from './types';
import type { OxcPureCallHint } from '../../../utils/collectOxcTemplateDependencies';
import type { ExpressionSpan } from '../../../utils/collectOxcTemplateDependencies/types';

export const isInsideRoot = (filename: string, root: string): boolean => {
  const relativePath = relative(root, filename);
  return (
    relativePath === '' ||
    (!!relativePath &&
      !relativePath.startsWith('..') &&
      !isAbsolute(relativePath))
  );
};

export const nodeModulesPattern = /[\\/]node_modules[\\/]/;

export const isLocalStaticMetadataFile = (
  filename: string,
  root: string
): boolean => {
  const strippedFilename = stripQueryAndHash(filename);
  if (isInsideRoot(strippedFilename, root)) {
    return true;
  }

  return (
    isAbsolute(strippedFilename) && !nodeModulesPattern.test(strippedFilename)
  );
};

export const isEnvDisabled = (value: string): boolean =>
  value === '0' || value === 'false' || value === 'no' || value === 'off';

/** Reason codes emitted by the static resolver when a candidate is rejected. */
export type StaticRejectionReason =
  | 'candidate-import-unresolved'
  | 'candidate-callable-usage-unsupported'
  | 'candidate-mutation-guard-unresolved'
  | 'candidate-expression-non-serializable'
  | 'candidate-expression-undefined'
  | 'runtime-callback'
  | 'not-eval-dependency';

export type StaticRejectionDetail = {
  pureCallHintSpan?: ExpressionSpan;
  reason: StaticRejectionReason;
};

const reasonExplanations: Record<StaticRejectionReason, string> = {
  'candidate-import-unresolved': "imported value isn't statically analyzable",
  'candidate-callable-usage-unsupported': 'depends on a runtime function call',
  'candidate-mutation-guard-unresolved':
    'an earlier call may mutate a value used by this interpolation',
  'candidate-expression-non-serializable':
    'value is non-serializable at build time',
  'candidate-expression-undefined':
    'resolved to undefined (export missing or not exported)',
  'runtime-callback': 'depends on a runtime function call',
  'not-eval-dependency': "imported value isn't statically analyzable",
};

export type UnresolvedValueDetail = {
  /** Original source text of the interpolation, e.g. `theme.warm.light`. */
  source?: string;
  /** Module the value was imported from, when it originates from an import. */
  importedFrom?: string;
  /** Why the value could not be resolved, when the resolver determined it. */
  reason?: StaticRejectionReason;
  pureCallHints?: OxcPureCallHint[];
};

const leadFor = (
  name: string,
  detail: UnresolvedValueDetail | undefined
): string => {
  // Lead with the source expression the developer wrote; fall back to the
  // `_exp` placeholder only when no source is available.
  return detail?.source && detail.source !== name ? detail.source : name;
};

type Grouped = {
  importedFrom?: string;
  reason?: StaticRejectionReason;
  /** lead text -> occurrence count, deduped within the file */
  leads: Map<string, number>;
};

export const getStaticStrategyFailure = (
  filename: string,
  dependencyNames: Iterable<string>,
  details?: ReadonlyMap<string, UnresolvedValueDetail>
): Error => {
  const names = [...dependencyNames];

  // Group by (module, reason): an emptied module produces one group covering
  // every value, so the shared cause is stated once and the leads listed bare.
  const groups: Grouped[] = [];
  for (const name of names) {
    const detail = details?.get(name);
    const lead = leadFor(name, detail);
    let group = groups.find(
      (g) =>
        g.importedFrom === detail?.importedFrom && g.reason === detail?.reason
    );
    if (!group) {
      group = {
        importedFrom: detail?.importedFrom,
        reason: detail?.reason,
        leads: new Map(),
      };
      groups.push(group);
    }
    group.leads.set(lead, (group.leads.get(lead) ?? 0) + 1);
  }

  const renderLead = (lead: string, count: number): string =>
    count > 1 ? `  - ${lead} (×${count})` : `  - ${lead}`;

  const renderGroup = (group: Grouped): string => {
    const leadLines = [...group.leads]
      .map(([lead, count]) => renderLead(lead, count))
      .join('\n');
    const explanation = group.reason
      ? reasonExplanations[group.reason]
      : undefined;
    const origin = group.importedFrom ? ` from ${group.importedFrom}` : '';
    // A single shared cause becomes a header; otherwise leave leads bare.
    if (explanation || origin) {
      return `${
        explanation ?? 'could not be resolved'
      }${origin}:\n${leadLines}`;
    }
    return leadLines;
  };

  const body = groups.map(renderGroup).join('\n\n');

  const pureCallHints = new Map<string, OxcPureCallHint>();
  names.forEach((name) => {
    const detail = details?.get(name);
    if (
      detail?.reason &&
      detail.reason !== 'candidate-mutation-guard-unresolved'
    ) {
      return;
    }
    detail?.pureCallHints?.forEach((hint) => {
      pureCallHints.set(
        `${hint.callFilename}:${hint.callStart}:${hint.callEnd}`,
        hint
      );
    });
  });
  const hintText =
    pureCallHints.size > 0
      ? `\n\nCalls that may be safe to annotate:\n${[...pureCallHints.values()]
          .map(
            (hint) =>
              `  - ${hint.callFilename}:${hint.callLine}:${
                hint.callColumn + 1
              }\n` +
              `    If this call is side-effect-free, annotate it as: ` +
              `/*#__PURE__*/ ${hint.callSource}`
          )
          .join('\n')}`
      : '';

  // The generic catch-all is only useful when no value carries a specific
  // reason; otherwise the per-group explanations already say why.
  const anyReason = groups.some((group) => group.reason);
  const generic = anyReason
    ? ''
    : `\nThey reference runtime-only values (function calls, mutated objects, ` +
      `non-serializable data, or modules the static evaluator skips).\n`;

  return new Error(
    `[wyw-in-js] eval.strategy: "static" cannot fall back to the build-time evaluator for ${filename}.\n` +
      `These interpolated values could not be resolved at build time:\n${body}${hintText}\n${generic}\n` +
      `Either make them statically analyzable, or relax eval.strategy from "static" to "hybrid".`
  );
};

export const debugStaticResolve = (
  action: ITransformAction,
  event: StaticResolveDebugEvent
): void => {
  const labels = Object.fromEntries(
    Object.entries({
      ...event,
      type: 'staticResolve',
    }).filter(([, value]) => value !== undefined)
  );

  action.services.eventEmitter.single(labels);
};

export const parseProgram = (code: string, filename: string): Program =>
  parseOxcProgram(code, filename, 'unambiguous');

export const getStaticBindings = (
  action: ITransformAction
): Record<string, Record<string, unknown>> | undefined =>
  action.services.options.pluginOptions?.staticBindings;
