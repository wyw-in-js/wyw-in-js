import { BaseProcessor, expressionToCode } from '@wyw-in-js/processor-utils';
import type {
  Expression as ProcessorExpression,
  IFileContext,
  Params,
} from '@wyw-in-js/processor-utils';
import type { StrictOptions } from '@wyw-in-js/shared';
import type { Expression, Node } from 'oxc-parser';

import { createOxcAstService } from '../oxcAstService';
import type { OxcEdit } from '../oxc/fileEdits';
import { buildOxcCodeFrameError } from '../oxc/sourceLocations';
import { applyDeclarativeProcessorSemantics } from '../../processors/declarativeSemantics';
import { getDisplayName } from './displayName';
import { getRootIdentifier } from './processorUsages';
import { getSourceLocation } from './shared';
import type {
  CreatedProcessor,
  DefinedProcessor,
  LocationLookup,
} from './types';

let didWarnSkipSymbolMismatch = false;
export const isReplacementPure = (replacement: ProcessorExpression): boolean =>
  replacement.type === 'CallExpression';

export const createProcessor = (
  definedProcessor: DefinedProcessor,
  params: Params,
  target: Expression,
  replacementTarget: Expression,
  ancestors: Node[],
  fileContext: IFileContext,
  options: Pick<
    StrictOptions,
    | 'classNameSlug'
    | 'displayName'
    | 'extensions'
    | 'processors'
    | 'tagResolver'
  >,
  code: string,
  loc: LocationLookup,
  idx: number,
  evaltimeLive: boolean,
  isReferenced: boolean,
  usedNames: Set<string>,
  replacements: OxcEdit[]
): CreatedProcessor | null => {
  const [Processor, tagSource] = definedProcessor;
  const astService = createOxcAstService(usedNames);

  const replacer = (
    replacement:
      | ProcessorExpression
      | ((tagPath: unknown) => ProcessorExpression),
    isPure: boolean
  ) => {
    const next =
      typeof replacement === 'function' ? replacement(target) : replacement;
    const replacementCode = expressionToCode(next);
    replacements.push({
      start: replacementTarget.start,
      end: replacementTarget.end,
      value:
        isPure && isReplacementPure(next)
          ? `/*#__PURE__*/${replacementCode}`
          : replacementCode,
    });
  };

  try {
    let displayName: string;
    try {
      displayName = getDisplayName(ancestors, idx, code, fileContext.filename);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Couldn't determine a name for the component")
      ) {
        let displayNameNode: Node = target;
        if (target.type === 'TaggedTemplateExpression') {
          displayNameNode = target.tag;
        } else if (target.type === 'CallExpression') {
          displayNameNode = target.callee;
        }
        const pointerNode =
          displayNameNode.type === 'MemberExpression'
            ? getRootIdentifier(displayNameNode) ?? displayNameNode
            : displayNameNode;
        throw buildOxcCodeFrameError(
          code,
          getSourceLocation(
            pointerNode.start,
            pointerNode.end,
            loc,
            fileContext.filename
          ),
          error.message
        );
      }
      throw error;
    }

    const processor = new Processor(
      params,
      tagSource,
      astService,
      getSourceLocation(target.start, target.end, loc, fileContext.filename),
      replacer,
      displayName,
      isReferenced,
      idx,
      options,
      fileContext
    );
    applyDeclarativeProcessorSemantics(
      processor,
      definedProcessor[2]?.declarativeSemantics,
      params
    );

    return {
      astService,
      evaltimeLive,
      processor,
    };
  } catch (e) {
    if (e === BaseProcessor.SKIP) {
      return null;
    }

    if (
      typeof e === 'symbol' &&
      e.description === BaseProcessor.SKIP.description
    ) {
      if (!didWarnSkipSymbolMismatch) {
        didWarnSkipSymbolMismatch = true;
        // eslint-disable-next-line no-console
        console.warn(
          [
            "[wyw-in-js] Processor threw Symbol('skip') that does not match BaseProcessor.SKIP identity.",
            'This usually means duplicate copies of @wyw-in-js/processor-utils (or the processor) are bundled/installed.',
            'Consider deduping dependencies to avoid subtle issues (instanceof checks, sentinels, etc).',
          ].join('\n')
        );
      }

      return null;
    }

    throw e;
  }
};
