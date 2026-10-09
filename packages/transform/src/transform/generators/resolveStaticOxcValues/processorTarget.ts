/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { Program } from 'oxc-parser';

import { applyOxcEdits } from '../../../utils/oxc/fileEdits';
import { parseProgram } from './environment';
import { findExportTarget } from './exportTargets';
import { collectWYWMetaExtendsExpressionsDeep } from './processorStaticModel';
import {
  hasOnlySafeObjectAssignCallArgumentUses,
  resolveObjectAssignProcessorExpression,
} from './objectAssign';
import { isOpaqueRuntimeComponentExpression } from './opaqueRuntime';
import { collectStaticExpressionDependencies } from './staticExpressionDependencies';
import type {
  ExportTarget,
  PreparedProcessorTarget,
  StaticExpressionOptions,
} from './types';

export const prepareProcessorTarget = (
  code: string,
  filename: string,
  program: Program,
  target: Extract<ExportTarget, { kind: 'expression' }>,
  exportedName: string,
  opaqueImportNames: Set<string> = new Set()
): PreparedProcessorTarget | null => {
  const ignoredMutableCallArgumentNames =
    target.localName &&
    hasOnlySafeObjectAssignCallArgumentUses(program, target.localName)
      ? new Set([target.localName])
      : undefined;
  const dependencyOptions: StaticExpressionOptions = {
    allowMetadataCalls: true,
    ignoredMutableCallArgumentNames,
  };
  const expression = resolveObjectAssignProcessorExpression(
    program,
    target.expression
  );
  const extendsExpressions = collectWYWMetaExtendsExpressionsDeep(
    program,
    expression
  );
  const opaqueExtendsExpressions = extendsExpressions.filter(
    (extendsExpression) =>
      isOpaqueRuntimeComponentExpression(
        program,
        extendsExpression,
        opaqueImportNames
      )
  );

  if (opaqueExtendsExpressions.length > 0) {
    const replacements = opaqueExtendsExpressions.map((extendsExpression) => ({
      end: extendsExpression.end,
      start: extendsExpression.start,
      value: 'null',
    }));
    const evaluationCode = applyOxcEdits(code, replacements);
    const evaluationProgram = parseProgram(evaluationCode, filename);
    const evaluationTarget = findExportTarget(evaluationProgram, exportedName);
    if (!evaluationTarget || evaluationTarget.kind === 'import') {
      return null;
    }

    const evaluationExpression = resolveObjectAssignProcessorExpression(
      evaluationProgram,
      evaluationTarget.expression
    );
    const dependencies = collectStaticExpressionDependencies(
      evaluationProgram,
      {
        ...evaluationTarget,
        expression: evaluationExpression,
      },
      dependencyOptions
    );

    return dependencies
      ? {
          dependencies,
          evaluationCode,
          evaluationSpan: {
            end: evaluationExpression.end,
            start: evaluationExpression.start,
          },
          expression: evaluationExpression,
          opaqueRuntimeBase: true,
        }
      : null;
  }

  const dependencies = collectStaticExpressionDependencies(
    program,
    {
      ...target,
      expression,
    },
    dependencyOptions
  );
  return dependencies
    ? {
        dependencies,
        expression,
        opaqueRuntimeBase: false,
      }
    : null;
};
