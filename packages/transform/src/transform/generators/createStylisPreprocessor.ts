/* eslint-disable no-continue */
import * as path from 'path';
import {
  compile,
  middleware,
  prefixer,
  serialize,
  stringify,
  tokenize,
  COMMENT,
  RULESET,
  KEYFRAMES,
  DECLARATION,
} from 'stylis';
import type { Middleware, Element } from 'stylis';

import type { Options } from '../../types';

const POSIX_SEP = path.posix.sep;

export function transformUrl(
  url: string,
  outputFilename: string,
  sourceFilename: string,
  platformPath: typeof path = path
) {
  // Replace asset path with new path relative to the output CSS
  const relative = platformPath.relative(
    platformPath.dirname(outputFilename),
    // Get the absolute path to the asset from the path relative to the JS file
    platformPath.resolve(platformPath.dirname(sourceFilename), url)
  );

  if (platformPath.sep === POSIX_SEP) {
    return relative;
  }

  return relative.split(platformPath.sep).join(POSIX_SEP);
}

interface IGlobalSelectorModifiers {
  includeBaseSelector: boolean;
  includeSpaceDelimiter: boolean;
}

const DEFINED_KEYFRAMES = Symbol('definedKeyframes');
const ORIGINAL_KEYFRAME_NAME = Symbol('originalKeyframeName');
const ORIGINAL_VALUE_KEY = Symbol('originalValue');
const IS_GLOBAL_KEYFRAMES = Symbol('isGlobalKeyframes');
const vendorPrefixes = ['webkit', 'moz', 'ms', 'o', ''].map((prefix) =>
  prefix ? `-${prefix}-` : ''
);

const getPrefixedProp = (prop: string): string[] =>
  vendorPrefixes.map((prefix) => `${prefix}${prop}`);

const animationProps = new Set([
  ...getPrefixedProp('animation'),
  ...getPrefixedProp('animation-name'),
]);

const getOriginalElementValue = (
  element: (Element & { [ORIGINAL_VALUE_KEY]?: string }) | null
) => {
  return element ? element[ORIGINAL_VALUE_KEY] ?? element.value : '';
};

function throwIfNotProd(key: string, value: unknown, type: string): false {
  if (process.env.NODE_ENV !== 'production') {
    throw new Error(
      `"element.${key}" has type "${type}" (${JSON.stringify(
        value,
        null,
        2
      )}), it's not expected. Please report a bug if it happens.`
    );
  }

  return false;
}

type SpecificElement<TFields> = Omit<Element, keyof TFields> & TFields;
type Declaration = SpecificElement<{
  children: string;
  props: string;
  type: typeof DECLARATION;
}>;
type Keyframes = SpecificElement<{
  [IS_GLOBAL_KEYFRAMES]?: boolean;
  props: string[];
  type: typeof KEYFRAMES;
}>;
type Ruleset = SpecificElement<{
  props: string[];
  type: typeof RULESET;
}>;

function childrenIsString(children: string | Element[]): children is string {
  return (
    typeof children === 'string' ||
    throwIfNotProd('children', children, 'Element[]')
  );
}

function propsAreStrings(props: string | string[]): props is string[] {
  return Array.isArray(props) || throwIfNotProd('props', props, 'string');
}

function propsIsString(props: string | string[]): props is string {
  return (
    typeof props === 'string' || throwIfNotProd('props', props, 'string[]')
  );
}

const isDeclaration = (element: Element): element is Declaration => {
  return (
    element.type === DECLARATION &&
    propsIsString(element.props) &&
    childrenIsString(element.children)
  );
};

const isKeyframes = (element: Element): element is Keyframes => {
  return element.type === KEYFRAMES && propsAreStrings(element.props);
};

const isRuleset = (element: Element): element is Ruleset => {
  return element.type === RULESET && propsAreStrings(element.props);
};

function nonMediaParent(element: Element): Element | null {
  let { parent } = element;

  while (parent) {
    if (parent.type !== '@media') {
      return parent;
    }

    parent = parent.parent;
  }

  return null;
}

/**
 * Stylis plugin that mimics :global() selector behavior from Stylis v3.
 */
export const stylisGlobalPlugin: Middleware = (element) => {
  function getGlobalSelectorModifiers(el: Element): IGlobalSelectorModifiers {
    const parent = nonMediaParent(el);

    const value = getOriginalElementValue(el);
    const parentValue = getOriginalElementValue(parent);

    if (
      (parent?.children.length === 0 && parentValue.includes(':global(')) ||
      (parent && !value.includes(':global('))
    ) {
      return getGlobalSelectorModifiers(parent);
    }

    const match = value.match(/(&\f( )?)?:global\(/);

    if (match === null) {
      throw new Error(
        `Failed to match :global() selector in "${value}". Please report a bug if it happens.`
      );
    }

    const [, baseSelector, spaceDelimiter] = match;

    return {
      includeBaseSelector: !!baseSelector,
      includeSpaceDelimiter: !!spaceDelimiter,
    };
  }

  if (!isRuleset(element)) {
    return;
  }

  Object.assign(element, {
    props: element.props.map((cssSelector) => {
      // The value can be changed by other middlewares, but we need an original one with `&`
      Object.assign(element, { [ORIGINAL_VALUE_KEY]: element.value });

      // Avoids calling tokenize() on every string
      if (!cssSelector.includes(':global(')) {
        return cssSelector;
      }

      if (element.children.length === 0) {
        return cssSelector;
      }

      const { includeBaseSelector, includeSpaceDelimiter } =
        getGlobalSelectorModifiers(element);

      const tokens = tokenize(cssSelector);
      let selector = '';

      for (let i = 0, len = tokens.length; i < len; i++) {
        const token = tokens[i];

        //
        // Match for ":global("
        if (token === ':' && tokens[i + 1] === 'global') {
          //
          // Match for ":global()"
          if (tokens[i + 2] === '()') {
            selector = [
              ...tokens.slice(i + 4),
              includeSpaceDelimiter ? ' ' : '',
              ...(includeBaseSelector ? tokens.slice(0, i - 1) : []),
              includeSpaceDelimiter ? '' : ' ',
            ].join('');

            break;
          }

          //
          // Match for ":global(selector)"
          selector = [
            tokens[i + 2].slice(1, -1),
            includeSpaceDelimiter ? ' ' : '',
            ...(includeBaseSelector ? tokens.slice(0, i - 1) : []),
            includeSpaceDelimiter ? '' : ' ',
          ].join('');

          break;
        }
      }

      return selector;
    }),
  });
};

export function createStylisUrlReplacePlugin(
  filename: string,
  outputFilename: string | undefined
): Middleware {
  return (element) => {
    if (element.type === 'decl' && outputFilename) {
      // When writing to a file, we need to adjust the relative paths inside url(..) expressions.
      // It'll allow css-loader to resolve an imported asset properly.
      // The declaration is rewritten in place: the Stylis prefixer skips
      // elements that already have `return`, so setting it here would drop
      // vendor prefixes and the display normalization.
      const replaceUrls = (css: string) =>
        css.replace(
          /\b(url\((["']?))(\.[^)]+?)(\2\))/g,
          (_match, p1, _p2, p3, p4) =>
            p1 + transformUrl(p3, outputFilename, filename) + p4
        );

      Object.assign(element, {
        children:
          typeof element.children === 'string'
            ? replaceUrls(element.children)
            : element.children,
        value: replaceUrls(element.value),
      });
    }
  };
}

export function createKeyframeSuffixerPlugin(): Middleware {
  const buildPropsRegexp = (prop: string, isAtRule: boolean) => {
    const [at, colon] = isAtRule ? ['@', ''] : ['', ':'];
    return new RegExp(
      `^(${at}(?:${getPrefixedProp(prop).join('|')})${colon})\\s*`
    );
  };

  const animationNameRegexp = /:global\(([\w_-]+)\)|([\w_-]+)/;

  const getReplacer = (
    startsWith: RegExp,
    searchValue: RegExp,
    replacer: (substring: string, ...matches: string[]) => string
  ): ((input: string) => string) => {
    return (input) => {
      const [fullMatch] = input.match(startsWith) ?? [];
      if (fullMatch === undefined) {
        return input;
      }

      const rest = input.slice(fullMatch.length);
      return fullMatch + rest.replace(searchValue, replacer);
    };
  };

  const elementToKeyframeSuffix = (el: Element): string => {
    if (el.parent) {
      return elementToKeyframeSuffix(el.parent);
    }

    return el.value.replaceAll(/[^a-zA-Z0-9_-]/g, '');
  };

  const getDefinedKeyframes = (
    element: Element & {
      [DEFINED_KEYFRAMES]?: Set<string>;
      siblings?: (Element & {
        [IS_GLOBAL_KEYFRAMES]?: boolean;
        [ORIGINAL_KEYFRAME_NAME]?: string;
      })[];
    }
  ): Set<string> => {
    if (element[DEFINED_KEYFRAMES]) {
      return element[DEFINED_KEYFRAMES];
    }

    if (element.parent) {
      return getDefinedKeyframes(element.parent);
    }

    const keyframes = new Set<string>();
    for (const sibling of element.siblings ?? []) {
      if (sibling[ORIGINAL_KEYFRAME_NAME]) {
        keyframes.add(sibling[ORIGINAL_KEYFRAME_NAME]);
        continue;
      }

      const name = sibling.props[0];
      if (
        !isKeyframes(sibling) ||
        sibling[IS_GLOBAL_KEYFRAMES] === true ||
        name?.startsWith(':global(')
      ) {
        continue;
      }

      keyframes.add(sibling.props[0]);
    }

    Object.assign(element, { [DEFINED_KEYFRAMES]: keyframes });

    return keyframes;
  };

  return (element) => {
    if (isKeyframes(element) && element.parent) {
      const suffix = elementToKeyframeSuffix(element);

      const replaceFn = (
        _match: string,
        globalMatch: string,
        scopedMatch: string
      ): string => globalMatch || `${scopedMatch}-${suffix}`;

      const originalName = element.props[0];
      const isGlobal = originalName?.startsWith(':global(') ?? false;

      Object.assign(element, {
        [ORIGINAL_KEYFRAME_NAME]: isGlobal ? undefined : originalName,
        [IS_GLOBAL_KEYFRAMES]: isGlobal,
        props: element.props.map(
          getReplacer(/^\s*/, animationNameRegexp, replaceFn)
        ),
        value: getReplacer(
          buildPropsRegexp('keyframes', true),
          animationNameRegexp,
          replaceFn
        )(element.value),
      });

      return;
    }

    if (isDeclaration(element)) {
      const suffix = elementToKeyframeSuffix(element);
      const keys = [
        'children',
        'return',
        'value',
      ] satisfies (keyof Declaration)[];

      if (animationProps.has(element.props)) {
        const scopedKeyframes = getDefinedKeyframes(element);
        const patch = Object.fromEntries(
          keys.map((key) => {
            const tokens = tokenize(element[key]);
            let result = '';
            for (let i = 0; i < tokens.length; i += 1) {
              if (
                tokens[i] === ':' &&
                tokens[i + 1] === 'global' &&
                tokens[i + 2].startsWith('(')
              ) {
                const globalName = tokens[i + 2].substring(
                  1,
                  tokens[i + 2].length - 1
                );
                i += 2;

                result += globalName;
                if (tokens[i + 1] !== ';' && tokens[i + 1] !== ' ') {
                  result += ' ';
                }
                continue;
              }

              if (scopedKeyframes.has(tokens[i])) {
                result += `${tokens[i]}-${suffix}`;
                continue;
              }

              result += tokens[i];
            }

            return [key, result];
          })
        );

        Object.assign(element, patch);
      }
    }
  };
}

function createCompactGlobalAnimationNormalizationPlugin(): Middleware {
  return (element) => {
    if (!isDeclaration(element) || !element.props.endsWith(':')) {
      return;
    }

    const prop = element.props.slice(0, -1);
    if (!animationProps.has(prop) || !element.children.startsWith('global(')) {
      return;
    }

    // Stylis parses `animation::global(...)` as the property `animation:` and
    // the value `global(...)`. Restore the same declaration shape produced by
    // `animation: :global(...)` before prefixing and keyframe rewriting.
    Object.assign(element, {
      children: `:${element.children}`,
      length: prop.length,
      props: prop,
    });
  };
}

const isMiddleware = (obj: Middleware | null): obj is Middleware =>
  obj !== null;

const displayKeywordRegexp = /^[a-z-]+$/;
const knownMultiKeywordDisplayTokens = new Set([
  'block',
  'inline',
  'flow',
  'flow-root',
  'flex',
  'grid',
  'table',
  'list-item',
]);

function normalizeMultiKeywordDisplayValue(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '' || !/\s/.test(trimmed)) {
    return null;
  }

  const importantRegexp = /!\s*important\s*$/i;
  const hasImportant = importantRegexp.test(trimmed);
  const withoutImportant = trimmed.replace(importantRegexp, '').trim();

  const tokens = withoutImportant.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return null;
  }

  const normalizedTokens = tokens.map((token) => token.toLowerCase());
  if (!normalizedTokens.every((token) => displayKeywordRegexp.test(token))) {
    return null;
  }

  const tokenSet = new Set(normalizedTokens);
  const hasInline = tokenSet.has('inline');
  const hasBlock = tokenSet.has('block');
  if (hasInline && hasBlock) {
    return null;
  }

  let outside: 'block' | 'inline' | null = null;
  if (hasInline) {
    outside = 'inline';
  } else if (hasBlock) {
    outside = 'block';
  }

  const insideCandidates = [
    'flow-root',
    'flow',
    'flex',
    'grid',
    'table',
  ].filter((candidate) => tokenSet.has(candidate));
  if (insideCandidates.length > 1) {
    return null;
  }

  const inside = insideCandidates[0] ?? null;
  const hasListItem = tokenSet.has('list-item');

  const canCanonicalize = normalizedTokens.every((token) =>
    knownMultiKeywordDisplayTokens.has(token)
  );

  if (canCanonicalize) {
    const canonicalOutside = outside ?? 'block';
    const canonicalInside = inside ?? (hasListItem ? 'flow' : null);
    if (canonicalInside) {
      let canonical: string | null = null;
      if (hasListItem) {
        if (canonicalInside === 'flow' && canonicalOutside === 'block') {
          canonical = 'list-item';
        }
      } else {
        switch (canonicalInside) {
          case 'flex':
            canonical = canonicalOutside === 'inline' ? 'inline-flex' : 'flex';
            break;
          case 'grid':
            canonical = canonicalOutside === 'inline' ? 'inline-grid' : 'grid';
            break;
          case 'table':
            canonical =
              canonicalOutside === 'inline' ? 'inline-table' : 'table';
            break;
          case 'flow-root':
            canonical = canonicalOutside === 'block' ? 'flow-root' : null;
            break;
          case 'flow':
            canonical = canonicalOutside === 'inline' ? 'inline' : 'block';
            break;
          default:
            break;
        }
      }

      if (canonical) {
        return hasImportant ? `${canonical}!important` : canonical;
      }
    }
  }

  const innerDisplay = inside === 'flex' || inside === 'grid' ? inside : null;
  if (
    innerDisplay &&
    normalizedTokens[0] === innerDisplay &&
    normalizedTokens.length > 1
  ) {
    const reordered = [
      ...(outside ? [outside] : []),
      ...normalizedTokens.filter(
        (token) => token !== innerDisplay && token !== outside
      ),
      innerDisplay,
    ].join(' ');

    return hasImportant ? `${reordered}!important` : reordered;
  }

  return null;
}

function createStylisDisplayNormalizationPlugin(): Middleware {
  return (element) => {
    if (!isDeclaration(element) || element.props !== 'display') {
      return;
    }

    const normalized = normalizeMultiKeywordDisplayValue(element.children);
    if (!normalized) {
      return;
    }

    const decl = `display:${normalized};`;
    Object.assign(element, {
      children: normalized,
      value: decl,
    });
  };
}

function createStylisStringifier(
  keepComments: boolean | RegExp | undefined
): Middleware {
  if (!keepComments) {
    return stringify;
  }

  const keepAllComments = keepComments === true;
  const keepCommentsFilter =
    keepComments instanceof RegExp ? keepComments : null;

  return (element, index, children, callback) => {
    if (element.type === COMMENT) {
      if (!keepAllComments && keepCommentsFilter) {
        const commentValue =
          typeof element.children === 'string'
            ? element.children
            : element.value;
        keepCommentsFilter.lastIndex = 0;
        if (!keepCommentsFilter.test(commentValue)) {
          return '';
        }
      }
      return element.value;
    }

    return stringify(element, index, children, callback);
  };
}

export function createStylisPreprocessor(
  options: Options & { prefixer?: boolean }
) {
  const stringifier = createStylisStringifier(options.keepComments);

  function stylisPreprocess(selector: string, text: string): string {
    const compiled = compile(`${selector} {${text}}\n`);

    return serialize(
      compiled,
      middleware(
        [
          createStylisUrlReplacePlugin(
            options.filename,
            options.outputFilename
          ),
          stylisGlobalPlugin,
          createCompactGlobalAnimationNormalizationPlugin(),
          options.prefixer === false
            ? null
            : createStylisDisplayNormalizationPlugin(),
          options.prefixer === false ? null : prefixer,
          createKeyframeSuffixerPlugin(),
          stringifier,
        ].filter(isMiddleware)
      )
    );
  }

  return stylisPreprocess;
}
