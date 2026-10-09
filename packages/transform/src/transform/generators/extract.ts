import type { Mapping } from 'source-map';
import { SourceMapGenerator } from 'source-map';

import type { Replacements, Rules } from '@wyw-in-js/shared';

import type { Options, PreprocessorFn } from '../../types';
import type { IExtractAction, SyncScenarioForAction } from '../types';
import { createStylisPreprocessor } from './createStylisPreprocessor';

export function extractCssFromAst(
  rules: Rules,
  originalCode: string,
  options: Pick<
    Options,
    'preprocessor' | 'filename' | 'outputFilename' | 'prefixer' | 'keepComments'
  >
): { cssSourceMapText: string; cssText: string; rules: Rules } {
  const mappings: Mapping[] = [];

  let cssText = '';

  let preprocessor: PreprocessorFn;
  if (typeof options.preprocessor === 'function') {
    // eslint-disable-next-line prefer-destructuring
    preprocessor = options.preprocessor;
  } else {
    switch (options.preprocessor) {
      case 'none':
        preprocessor = (selector, text) => `${selector} {${text}}\n`;
        break;
      case 'stylis':
      default:
        preprocessor = createStylisPreprocessor(options);
    }
  }

  // Kept comments and the `none` preprocessor produce multi-line rules.
  let line = 1;

  Object.keys(rules).forEach((selector) => {
    mappings.push({
      generated: {
        line,
        column: 0,
      },
      original: rules[selector].start!,
      name: selector,
      source: '',
    });

    // Atoms are inserted as is, to give the atomizer full control over the
    // rules; everything else runs through the preprocessor to support nesting.
    const ruleCssText = rules[selector].atom
      ? rules[selector].cssText
      : preprocessor(selector, rules[selector].cssText);

    cssText += `${ruleCssText}\n`;
    line += ruleCssText.split('\n').length;
  });

  return {
    cssText,
    rules,

    get cssSourceMapText() {
      if (mappings?.length) {
        const generator = new SourceMapGenerator({
          file: options.filename.replace(/\.js$/, '.css'),
        });

        mappings.forEach((mapping) =>
          generator.addMapping({ ...mapping, source: options.filename })
        );

        generator.setSourceContent(options.filename, originalCode);

        return generator.toString();
      }

      return '';
    },
  };
}

/**
 * Extract artifacts (e.g. CSS) from processors
 */
// eslint-disable-next-line require-yield
export function* extract(
  this: IExtractAction
): SyncScenarioForAction<IExtractAction> {
  const { options } = this.services;
  const { entrypoint } = this;
  const { processors } = this.data;
  const { loadedAndParsed } = entrypoint;
  if (loadedAndParsed.evaluator === 'ignored') {
    throw new Error('entrypoint was ignored');
  }

  // Merged in place: re-spreading the accumulator for every artifact is
  // quadratic in the number of processors of a file.
  const allRules: Rules = {};
  const allReplacements: Replacements = [];
  processors.forEach((processor) => {
    processor.artifacts.forEach((artifact) => {
      if (artifact[0] !== 'css') return;
      const [rules, replacements] = artifact[1] as [
        rules: Rules,
        sourceMapReplacements: Replacements,
      ];

      Object.assign(allRules, rules);
      allReplacements.push(...replacements);
    });
  });

  return {
    ...extractCssFromAst(allRules, loadedAndParsed.code, options),
    replacements: allReplacements,
  };
}
