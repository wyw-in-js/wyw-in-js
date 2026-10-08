import type { Program } from 'oxc-parser';

import { applyOxcEdits } from '../oxc/fileEdits';
import {
  collectReferencedNames,
  collectRemovableNamesFromStatements,
  collectTopLevelBindingsFromStatements,
  collectTopLevelStatementInfos,
} from './cleanupBindings';
import {
  collectEmptyTopLevelBlockRemovals,
  collectScopedBindingInfos,
  collectTopLevelExpressionStatementRemovals,
  collectUnusedGeneratedHelperDeclarationRemovals,
  collectUnusedImportRemovals,
  collectUnusedScopedDeclarationRemovals,
  collectUnusedTopLevelDeclarationRemovals,
  mergeEmptyRemovalRanges,
} from './cleanupRemovals';
import { parseOxc } from './shared';
import {
  beginPipelineCleanup,
  finishPipelineCleanup,
  recordPipelineCleanupIteration,
} from '../../debug/pipelineTelemetry';

export const removeUnusedAfterReplacement = (
  code: string,
  filename: string,
  initialRemovableNames: Set<string>,
  removableExpressionRefs: Set<string>,
  preserveSideEffectImportLocals: Set<string>,
  preserveSideEffectImportOrderLocals: Set<string> = preserveSideEffectImportLocals
): string => {
  let current = code;
  let program: Program | null = null;
  const cumulativeRemovableNames = new Set(initialRemovableNames);
  const pipelineCleanup = beginPipelineCleanup(filename);

  try {
    // Validate the next revision once and reuse that AST on the next iteration.
    for (let idx = 0; idx < 5; idx += 1) {
      const previous = current;
      if (program === null) {
        program = parseOxc(current, filename);
      }
      const statements = collectTopLevelStatementInfos(program);
      const removableNames = collectRemovableNamesFromStatements(
        statements,
        cumulativeRemovableNames
      );
      removableNames.forEach((name) => cumulativeRemovableNames.add(name));
      const referencedNames = collectReferencedNames(program);
      const topLevelBindings =
        collectTopLevelBindingsFromStatements(statements);
      const scopedBindings = collectScopedBindingInfos(program);
      const scopedDeclarationRemovals = collectUnusedScopedDeclarationRemovals(
        current,
        scopedBindings,
        cumulativeRemovableNames
      );
      const topLevelDeclarationRemovals =
        collectUnusedTopLevelDeclarationRemovals(
          current,
          program,
          referencedNames,
          cumulativeRemovableNames
        );
      const generatedHelperRemovals =
        collectUnusedGeneratedHelperDeclarationRemovals(
          current,
          program,
          referencedNames
        );
      const importRemovals = collectUnusedImportRemovals(
        current,
        program,
        referencedNames,
        cumulativeRemovableNames,
        preserveSideEffectImportLocals,
        preserveSideEffectImportOrderLocals
      );
      const expressionRemovals = collectTopLevelExpressionStatementRemovals(
        current,
        statements,
        topLevelBindings,
        removableExpressionRefs
      );
      const emptyBlockRemovals = collectEmptyTopLevelBlockRemovals(
        current,
        program
      );
      const removals = mergeEmptyRemovalRanges([
        ...scopedDeclarationRemovals,
        ...topLevelDeclarationRemovals,
        ...generatedHelperRemovals,
        ...importRemovals,
        ...expressionRemovals,
        ...emptyBlockRemovals,
      ]);

      if (removals.length === 0) {
        recordPipelineCleanupIteration(
          pipelineCleanup,
          current,
          removals,
          false,
          scopedDeclarationRemovals.length,
          topLevelDeclarationRemovals.length,
          generatedHelperRemovals.length,
          importRemovals.length,
          expressionRemovals.length,
          emptyBlockRemovals.length
        );
        finishPipelineCleanup(pipelineCleanup, 'converged');
        return current;
      }

      const next = applyOxcEdits(current, removals);
      try {
        program = parseOxc(next, filename);
        recordPipelineCleanupIteration(
          pipelineCleanup,
          current,
          removals,
          true,
          scopedDeclarationRemovals.length,
          topLevelDeclarationRemovals.length,
          generatedHelperRemovals.length,
          importRemovals.length,
          expressionRemovals.length,
          emptyBlockRemovals.length
        );
        current = next;
      } catch {
        recordPipelineCleanupIteration(
          pipelineCleanup,
          current,
          removals,
          false,
          scopedDeclarationRemovals.length,
          topLevelDeclarationRemovals.length,
          generatedHelperRemovals.length,
          importRemovals.length,
          expressionRemovals.length,
          emptyBlockRemovals.length
        );
        finishPipelineCleanup(pipelineCleanup, 'rollback');
        return current;
      }

      if (current === previous) {
        finishPipelineCleanup(pipelineCleanup, 'stalled');
        return current;
      }
    }

    finishPipelineCleanup(pipelineCleanup, 'cap');
    return current;
  } catch (error) {
    finishPipelineCleanup(pipelineCleanup, 'error');
    throw error;
  }
};
