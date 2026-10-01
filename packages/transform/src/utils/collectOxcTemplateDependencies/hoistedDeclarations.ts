import type { Expression } from 'oxc-parser';
import {
  collectOxcPatternBindingIdentifiers,
  collectOxcPatternRuntimeExpressions,
  collectOxcPatternShorthandProperties,
} from '../oxc/patterns';
import { toOxcBindingIdentity } from './bindingIdentity';
import { findResolvedReferences as getReferences } from './bindingResolution';
import {
  applyExpressionReplacements,
  replaceIdentifierReferences,
} from './expressionReplacements';
import { allocateHoistedBindingName } from './snapshotReplay';
import type { Binding, ExtractionContext, Replacement } from './types';

export const getHoistedBindingName = (
  binding: Binding,
  ctx: ExtractionContext
): string => {
  const key = toOxcBindingIdentity(binding);
  const existing = ctx.hoistedBindingNames.get(key);
  if (existing) {
    return existing;
  }

  const next = allocateHoistedBindingName(binding.name, ctx);
  ctx.hoistedBindingNames.set(key, next);
  return next;
};

export const declarationInitCode = (
  init: Expression,
  ctx: ExtractionContext
): string => {
  const renamedDependencies = new Map<number, string>();
  getReferences(init, ctx.bindingIndex).forEach(
    ({ binding: dependency, start }) => {
      if (
        !dependency ||
        dependency.importedFrom ||
        dependency.isRoot ||
        dependency.declarator?.id.type !== 'Identifier'
      ) {
        return;
      }

      renamedDependencies.set(start, getHoistedBindingName(dependency, ctx));
    }
  );

  return renamedDependencies.size > 0
    ? replaceIdentifierReferences(
        init,
        new Map(),
        ctx.code,
        renamedDependencies
      )
    : ctx.code.slice(init.start, init.end);
};

export const declarationPatternCode = (
  binding: Binding,
  ctx: ExtractionContext
): string => {
  const { declarator } = binding;
  if (
    !declarator ||
    (declarator.id.type !== 'ObjectPattern' &&
      declarator.id.type !== 'ArrayPattern')
  ) {
    return declarator
      ? ctx.code.slice(declarator.id.start, declarator.id.end)
      : '';
  }

  const replacements: Replacement[] = [];
  collectOxcPatternBindingIdentifiers(declarator.id).forEach((identifier) => {
    const patternBinding = ctx.bindingIndex.bindingsByName
      .get(identifier.name)
      ?.find((candidate) => candidate.declarator === declarator);
    if (!patternBinding) {
      return;
    }

    replacements.push({
      end: identifier.end,
      start: identifier.start,
      value: getHoistedBindingName(patternBinding, ctx),
    });
  });

  collectOxcPatternRuntimeExpressions(declarator.id).forEach((expression) => {
    getReferences(expression, ctx.bindingIndex).forEach(
      ({ binding: dependency, end, start }) => {
        if (
          !dependency ||
          dependency.importedFrom ||
          dependency.isRoot ||
          (dependency.declarator !== declarator &&
            dependency.declarator?.id.type !== 'Identifier')
        ) {
          return;
        }

        replacements.push({
          end,
          start,
          value: getHoistedBindingName(dependency, ctx),
        });
      }
    );
  });

  const shorthandProperties = collectOxcPatternShorthandProperties(
    declarator.id
  );
  const isInsideShorthand = (
    replacement: Replacement,
    property: (typeof shorthandProperties)[number]
  ): boolean =>
    property.start <= replacement.start && replacement.end <= property.end;
  const shorthandReplacements = shorthandProperties.map((property) => {
    const valueReplacements = replacements.filter((replacement) =>
      isInsideShorthand(replacement, property)
    );
    const valueCode =
      valueReplacements.length > 0
        ? applyExpressionReplacements(
            property.value,
            valueReplacements,
            ctx.code
          )
        : ctx.code.slice(property.value.start, property.value.end);
    const keyCode = ctx.code.slice(property.key.start, property.key.end);
    return {
      end: property.end,
      start: property.start,
      value: `${keyCode}: ${valueCode}`,
    };
  });
  const directReplacements = replacements.filter(
    (replacement) =>
      !shorthandProperties.some((property) =>
        isInsideShorthand(replacement, property)
      )
  );
  const allReplacements = [...directReplacements, ...shorthandReplacements];

  return allReplacements.length > 0
    ? applyExpressionReplacements(declarator.id, allReplacements, ctx.code)
    : ctx.code.slice(declarator.id.start, declarator.id.end);
};
