import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, extname, isAbsolute } from 'path';
import type { Debugger, EvalRule, Evaluator } from '@wyw-in-js/shared';
import { logger } from '@wyw-in-js/shared';

import { oxcShaker } from '../shaker';
import type { ParentEntrypoint } from '../types';
import { getFileIdx } from '../utils/getFileIdx';
import { parseOxcProgramFresh } from '../utils/parseOxc';
import { stripQueryAndHash } from '../utils/parseRequest';

import type {
  IEntrypointCode,
  IIgnoredEntrypoint,
  ParsedAst,
} from './Entrypoint.types';
import type { Services } from './types';

const nodeRequire = createRequire(import.meta.url);

export function getMatchedRule(
  rules: EvalRule[],
  filename: string,
  code: string
): EvalRule {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (!rule.test) {
      return rule;
    }

    if (typeof rule.test === 'function' && rule.test(filename, code)) {
      return rule;
    }

    if (rule.test instanceof RegExp && rule.test.test(filename)) {
      return rule;
    }
  }

  return { action: 'ignore' };
}

export function parseFile(
  _runtime: unknown,
  filename: string,
  originalCode: string
): ParsedAst {
  const log = logger.extend('transform:parse').extend(getFileIdx(filename));

  // Public callers own the returned AST and may mutate it, so it must never be
  // the program shared through the parse cache.
  const program = parseOxcProgramFresh(filename, originalCode, 'module');

  log('stage-1', `${filename} has been parsed`);

  return program;
}

export function loadAndParse(
  services: Services,
  name: string,
  loadedCode: string | undefined,
  log: Debugger
): IEntrypointCode | IIgnoredEntrypoint {
  const {
    options: { pluginOptions },
  } = services;

  const filename = stripQueryAndHash(name);
  const extension = extname(filename);

  if (!pluginOptions.extensions.includes(extension)) {
    log(
      '[createEntrypoint] %s is ignored. If you want it to be processed, you should add \'%s\' to the "extensions" option.',
      filename,
      extension
    );

    return {
      code: isAbsolute(filename) ? loadedCode : '',
      evaluator: 'ignored',
      reason: 'extension',
    };
  }

  let code = loadedCode;

  if (code === undefined) {
    const cachedEntrypoint = services.cache.get('entrypoints', name);
    if (
      cachedEntrypoint &&
      'initialCode' in cachedEntrypoint &&
      typeof cachedEntrypoint.initialCode === 'string'
    ) {
      code = cachedEntrypoint.initialCode;
    }
  }

  code ??= readFileSync(filename, 'utf-8');

  const { action } = getMatchedRule(pluginOptions.rules, filename, code);

  if (action === 'ignore') {
    log('[createEntrypoint] %s is ignored by rule', name);
    return {
      code,
      evaluator: 'ignored',
      reason: 'rule',
    };
  }

  const evaluator: Evaluator =
    typeof action === 'function'
      ? action
      : nodeRequire(
          nodeRequire.resolve(action, {
            paths: [dirname(filename)],
          })
        ).default;

  if (evaluator !== oxcShaker) {
    throw new Error(
      `[wyw-in-js] ${filename} matched a legacy evaluator. The Oxc runtime path supports only the default Oxc evaluator.`
    );
  }

  return {
    code,
    evaluator,
    evalConfig: {
      ast: false,
      configFile: false,
      filename,
      root: services.options.root ?? process.cwd(),
    },
  };
}

export function getStack(entrypoint: ParentEntrypoint) {
  if (!entrypoint) return [];

  const stack = [entrypoint.name];

  let { parents } = entrypoint;
  while (parents.length) {
    stack.push(parents[0].name);
    parents = parents[0].parents;
  }

  return stack;
}

export function mergeOnly(a: string[], b: string[]) {
  const result = new Set(a);
  b.forEach((item) => result.add(item));
  return [...result].filter((i) => i).sort();
}

export const isSuperSet = <T>(a: (T | '*')[], b: (T | '*')[]) => {
  if (a.includes('*')) return true;
  if (b.length === 0) return true;
  const aSet = new Set(a);
  return b.every((item) => aSet.has(item));
};
