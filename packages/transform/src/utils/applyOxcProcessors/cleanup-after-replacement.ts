import type { Program } from 'oxc-parser';

import { applyOxcEdits, mergeOxcRemovals } from '../oxc/fileEdits';
import {
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
} from './cleanupRemovals';
import { parseOxc } from './shared';
import { currentPipelineObserver } from '../../telemetry/observer';

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
  const pipelineCleanup = currentPipelineObserver().beginCleanup(filename);

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
      const referencedNames = new Set<string>();
      statements.forEach((statement) => {
        statement.references.forEach((name) => referencedNames.add(name));
      });
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
      const removals = mergeOxcRemovals([
        ...scopedDeclarationRemovals,
        ...topLevelDeclarationRemovals,
        ...generatedHelperRemovals,
        ...importRemovals,
        ...expressionRemovals,
        ...emptyBlockRemovals,
      ]);

      if (removals.length === 0) {
        pipelineCleanup.recordIteration(
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
        pipelineCleanup.finish('converged');
        return current;
      }

      const next = applyOxcEdits(current, removals);
      try {
        program = parseOxc(next, filename);
        pipelineCleanup.recordIteration(
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
        pipelineCleanup.recordIteration(
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
        pipelineCleanup.finish('rollback');
        return current;
      }

      if (current === previous) {
        pipelineCleanup.finish('stalled');
        return current;
      }
    }

    pipelineCleanup.finish('cap');
    return current;
  } catch (error) {
    pipelineCleanup.finish('error');
    throw error;
  }
};
