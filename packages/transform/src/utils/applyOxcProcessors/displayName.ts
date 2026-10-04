/* eslint-disable no-restricted-syntax */

import { basename, dirname } from 'path';

import type { ExpressionValue } from '@wyw-in-js/shared';
import { ValueType } from '@wyw-in-js/shared';
import type { Node, Program } from 'oxc-parser';

import type { OxcStaticValue } from '../collectOxcTemplateDependencies';
import { isOxcNode, walkOxc } from '../oxc/ast';
import { isNodeReference } from './cleanupBindings';
import type { AnyNode } from './types';

export const getPropertyKeyName = (
  property: AnyNode,
  code: string
): string | null => {
  const { key } = property;
  if (!isOxcNode(key)) {
    return null;
  }

  if (key.type === 'Identifier') {
    return key.name;
  }

  if (key.type === 'Literal') {
    return String(key.value);
  }

  return typeof key.start === 'number' && typeof key.end === 'number'
    ? code.slice(key.start, key.end)
    : null;
};

export const getDisplayName = (
  ancestors: Node[],
  idx: number,
  code: string,
  filename?: string | null
): string => {
  const owner = [...ancestors].reverse().find((node) => {
    return (
      node.type === 'Property' ||
      node.type === 'JSXOpeningElement' ||
      node.type === 'VariableDeclarator'
    );
  }) as AnyNode | undefined;

  if (owner?.type === 'Property') {
    const keyName = getPropertyKeyName(owner, code);
    if (keyName) {
      return keyName;
    }
  } else if (owner?.type === 'JSXOpeningElement') {
    const { name } = owner;
    if (isOxcNode(name) && name.type === 'JSXIdentifier') {
      return name.name;
    }
  } else if (owner?.type === 'VariableDeclarator') {
    const { id } = owner;
    if (isOxcNode(id) && id.type === 'Identifier') {
      return id.name;
    }
  }

  let displayName = basename(filename ?? 'unknown').replace(/\.[a-z\d]+$/, '');
  if (filename && /^index\.[a-z\d]+$/.test(basename(filename))) {
    displayName = basename(dirname(filename));
  }

  if (!displayName) {
    throw new Error(
      "Couldn't determine a name for the component. Ensure that it's either:\n" +
        '- Assigned to a variable\n' +
        '- Is an object property\n' +
        '- Is a prop in a JSX element\n'
    );
  }

  return `${displayName}${idx}`;
};

export const getTagOwner = (ancestors: Node[]): AnyNode | null => {
  const owner = [...ancestors]
    .reverse()
    .find(
      (node) =>
        node.type === 'Property' ||
        node.type === 'JSXOpeningElement' ||
        node.type === 'VariableDeclarator'
    ) as AnyNode | undefined;

  return owner ?? null;
};

// Collected with one walk per program. Tags used to walk the whole program
// once per usage, in both the preeval and the collect pass.
const referencedNamesByProgram = new WeakMap<Program, Set<string>>();

const getReferencedNames = (program: Program): Set<string> => {
  const cached = referencedNamesByProgram.get(program);
  if (cached) {
    return cached;
  }

  const names = new Set<string>();
  walkOxc(program, (node, parent) => {
    if (
      (node.type === 'Identifier' || node.type === 'JSXIdentifier') &&
      isNodeReference(node, parent)
    ) {
      names.add(node.name);
    }
  });

  referencedNamesByProgram.set(program, names);
  return names;
};

export const isTagReferenced = (
  program: Program,
  ancestors: Node[]
): boolean => {
  const owner = getTagOwner(ancestors);
  if (owner?.type !== 'VariableDeclarator') {
    return true;
  }

  const { id } = owner;
  if (!isOxcNode(id) || id.type !== 'Identifier') {
    return true;
  }

  if (ancestors.some((node) => node.type === 'ExportNamedDeclaration')) {
    return true;
  }

  // isNodeReference rejects the declarator's own id, so a hit is always
  // another identifier referring to the tag.
  return getReferencedNames(program).has(id.name);
};

export const collectSameFileProcessorStaticValues = (
  expressionValues: Omit<ExpressionValue, 'buildCodeFrameError'>[],
  processorStaticValuesByLocal: Map<string, unknown>
): OxcStaticValue[] => {
  const staticValues: OxcStaticValue[] = [];
  const seen = new Set<string>();

  expressionValues.forEach((value) => {
    if (value.kind !== ValueType.LAZY) {
      return;
    }

    const staticValue = processorStaticValuesByLocal.get(value.source);
    if (
      staticValue === undefined ||
      value.ex.type !== 'Identifier' ||
      seen.has(value.ex.name)
    ) {
      return;
    }

    seen.add(value.ex.name);
    staticValues.push({
      name: value.ex.name,
      value: staticValue,
    });
  });

  return staticValues;
};
