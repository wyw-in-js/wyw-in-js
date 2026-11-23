/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import { dirname, isAbsolute, resolve as resolvePath } from 'path';

import type { Expression, Node, Program } from 'oxc-parser';

import { stripQueryAndHash } from '@wyw-in-js/shared';

import { oxcShaker } from '../../../shaker';
import { getOxcNodeChildren } from '../../../utils/oxc/ast';
import type { ITransformAction, SyncScenarioFor } from '../../types';
import { hashStaticContent, getStaticMetadataPreevalResult } from './cache';
import { resolveDependency } from './dependencies';
import { parseProgram } from './environment';
import { findExportTarget } from './exportTargets';
import {
  findTopLevelConstExpression,
  functionReturnExpression,
  isTopLevelFunctionOrClass,
} from './programAnalysis';
import {
  collectWYWMetaExtendsExpressionsDeep,
  isStaticMetaObjectExpression,
} from './processorStaticModel';
import {
  collectImportBindings,
  isSafeStaticExpression,
  unwrapExpression,
} from './staticExpression';
import { rootIdentifierName } from './staticExpressionDependencies';
import type { ImportBinding, OpaqueRuntimeImportProof } from './types';

export const isKnownOpaqueRuntimeWrapperImport = (
  binding: ImportBinding | undefined
): boolean => {
  if (!binding) {
    return false;
  }

  return (
    binding.imported === 'observer' &&
    (binding.source === 'mobx-react' || binding.source === 'mobx-react-lite')
  );
};

export const isKnownOpaqueRuntimeWrapperCallee = (
  expr: Node,
  imports: Map<string, ImportBinding>
): boolean => {
  const callee = unwrapExpression(expr);
  if (callee.type === 'Identifier') {
    return isKnownOpaqueRuntimeWrapperImport(imports.get(callee.name));
  }

  return false;
};

export const isKnownOpaqueRuntimeImportSource = (source: string): boolean =>
  /\.svg(?:$|[?#])/.test(source);

export const isKnownExternalRuntimeComponentImportSource = (
  source: string
): boolean => source.startsWith('@radix-ui/react-');

export const isOpaqueRuntimeComponentExpression = (
  program: Program,
  expr: Node,
  opaqueImportNames: Set<string> = new Set(),
  seen: Set<string> = new Set()
): boolean => {
  const imports = collectImportBindings(program, { includeNamespace: true });
  const unwrapped = unwrapExpression(expr);

  if (isStaticMetaObjectExpression(unwrapped)) {
    return false;
  }

  if (
    unwrapped.type === 'ArrowFunctionExpression' ||
    unwrapped.type === 'FunctionExpression' ||
    unwrapped.type === 'ClassExpression'
  ) {
    return true;
  }

  if (
    unwrapped.type === 'CallExpression' &&
    unwrapped.arguments.length === 1 &&
    isKnownOpaqueRuntimeWrapperCallee(unwrapped.callee, imports)
  ) {
    const [argument] = unwrapped.arguments;
    return argument.type !== 'SpreadElement'
      ? isOpaqueRuntimeComponentExpression(
          program,
          argument,
          opaqueImportNames,
          seen
        )
      : false;
  }

  if (
    unwrapped.type === 'CallExpression' &&
    unwrapped.callee.type === 'Identifier'
  ) {
    const allowParams = unwrapped.arguments.every(
      (argument) =>
        argument.type !== 'SpreadElement' && isSafeStaticExpression(argument)
    );
    const local = findTopLevelConstExpression(program, unwrapped.callee.name);
    const returned = local
      ? functionReturnExpression(local, { allowParams })
      : null;
    return returned
      ? isOpaqueRuntimeComponentExpression(
          program,
          returned,
          opaqueImportNames,
          seen
        )
      : false;
  }

  if (unwrapped.type === 'MemberExpression' && !unwrapped.computed) {
    const name = rootIdentifierName(unwrapped);
    const imported = name ? imports.get(name) : undefined;
    return (
      !!name &&
      !!imported &&
      (opaqueImportNames.has(name) ||
        isKnownExternalRuntimeComponentImportSource(imported.source))
    );
  }

  if (unwrapped.type !== 'Identifier') {
    return false;
  }

  const { name } = unwrapped;
  if (seen.has(name)) {
    return false;
  }
  seen.add(name);

  const imported = imports.get(name);
  if (imported) {
    return (
      opaqueImportNames.has(name) ||
      isKnownOpaqueRuntimeImportSource(imported.source) ||
      isKnownExternalRuntimeComponentImportSource(imported.source)
    );
  }

  if (isTopLevelFunctionOrClass(program, name)) {
    return true;
  }

  const local = findTopLevelConstExpression(program, name);
  return local
    ? isOpaqueRuntimeComponentExpression(
        program,
        local,
        opaqueImportNames,
        seen
      )
    : false;
};

export const collectOpaqueRuntimeReferenceNames = (
  program: Program,
  expr: Node,
  names: Set<string>,
  seenHelpers: Set<string> = new Set()
): void => {
  const unwrapped = unwrapExpression(expr);

  if (
    unwrapped.type === 'CallExpression' &&
    unwrapped.callee.type === 'Identifier'
  ) {
    const allowParams = unwrapped.arguments.every(
      (argument) =>
        argument.type !== 'SpreadElement' && isSafeStaticExpression(argument)
    );
    if (seenHelpers.has(unwrapped.callee.name)) {
      return;
    }

    const local = findTopLevelConstExpression(program, unwrapped.callee.name);
    const returned = local
      ? functionReturnExpression(local, { allowParams })
      : null;
    if (returned) {
      seenHelpers.add(unwrapped.callee.name);
      collectOpaqueRuntimeReferenceNames(program, returned, names, seenHelpers);
      seenHelpers.delete(unwrapped.callee.name);
      return;
    }
  }

  if (unwrapped.type === 'Identifier') {
    names.add(unwrapped.name);
    return;
  }

  getOxcNodeChildren(unwrapped).forEach((child) =>
    collectOpaqueRuntimeReferenceNames(program, child, names, seenHelpers)
  );
};
export function* resolveExportAsOpaqueRuntimeImport(
  action: ITransformAction,
  filename: string,
  exportedName: string,
  stack: Set<string>,
  memo: Map<string, OpaqueRuntimeImportProof | null>
): SyncScenarioFor<OpaqueRuntimeImportProof | null> {
  const memoKey = `${filename}\0${exportedName}`;
  if (memo.has(memoKey)) {
    return memo.get(memoKey) ?? null;
  }

  if (stack.has(memoKey)) {
    memo.set(memoKey, null);
    return null;
  }

  stack.add(memoKey);

  const loadedAndParsed = action.services.loadAndParseFn(
    action.services,
    filename,
    undefined,
    action.services.log
  );
  if (
    loadedAndParsed.evaluator === 'ignored' ||
    loadedAndParsed.evaluator !== oxcShaker
  ) {
    memo.set(memoKey, null);
    stack.delete(memoKey);
    return null;
  }

  const codeHash = hashStaticContent(loadedAndParsed.code);
  const preevalResult = getStaticMetadataPreevalResult(
    action,
    filename,
    loadedAndParsed.code,
    codeHash
  );
  const program = parseProgram(
    preevalResult?.baseCode ?? loadedAndParsed.code,
    filename
  );
  const target = findExportTarget(program, exportedName);
  if (!target) {
    memo.set(memoKey, null);
    stack.delete(memoKey);
    return null;
  }

  if (target.kind === 'import') {
    const resolved = yield* resolveImportAsOpaqueRuntime(
      action,
      filename,
      target,
      stack,
      memo
    );
    memo.set(memoKey, resolved);
    stack.delete(memoKey);
    return resolved;
  }

  if (isOpaqueRuntimeComponentExpression(program, target.expression)) {
    const resolved = {
      dependencies: [filename],
      names: new Set<string>(),
    };
    memo.set(memoKey, resolved);
    stack.delete(memoKey);
    return resolved;
  }

  const imports = collectImportBindings(program, { includeNamespace: true });
  const referencedNames = new Set<string>();
  collectOpaqueRuntimeReferenceNames(
    program,
    target.expression,
    referencedNames
  );
  const opaqueImportNames = new Set<string>();
  const dependencies = new Set<string>([filename]);

  for (const name of referencedNames) {
    const binding = imports.get(name);
    if (
      !binding ||
      binding.source === 'react' ||
      isKnownOpaqueRuntimeWrapperImport(binding)
    ) {
      continue;
    }

    const proof = yield* resolveImportAsOpaqueRuntime(
      action,
      filename,
      binding,
      stack,
      memo
    );
    if (!proof) {
      continue;
    }

    opaqueImportNames.add(name);
    proof.dependencies.forEach((dependency) => dependencies.add(dependency));
  }

  const resolved = isOpaqueRuntimeComponentExpression(
    program,
    target.expression,
    opaqueImportNames
  )
    ? {
        dependencies: [...dependencies],
        names: opaqueImportNames,
      }
    : null;
  memo.set(memoKey, resolved);
  stack.delete(memoKey);
  return resolved;
}

export const knownOpaqueRuntimeSourceDependency = (
  importer: string,
  source: string
): string | null => {
  if (!isKnownOpaqueRuntimeImportSource(source)) {
    return null;
  }

  const request = stripQueryAndHash(source);
  if (isAbsolute(request)) {
    return request;
  }

  return request.startsWith('.')
    ? resolvePath(dirname(importer), request)
    : null;
};

export function* resolveImportAsOpaqueRuntime(
  action: ITransformAction,
  importer: string,
  binding: Pick<ImportBinding, 'imported' | 'source'>,
  stack: Set<string>,
  memo: Map<string, OpaqueRuntimeImportProof | null>
): SyncScenarioFor<OpaqueRuntimeImportProof | null> {
  const knownSourceDependency = knownOpaqueRuntimeSourceDependency(
    importer,
    binding.source
  );
  if (knownSourceDependency) {
    return {
      dependencies: [knownSourceDependency],
      names: new Set(),
    };
  }

  if (isKnownExternalRuntimeComponentImportSource(binding.source)) {
    return {
      dependencies: [],
      names: new Set(),
    };
  }

  const dependency = yield* resolveDependency(
    action,
    importer,
    binding.source,
    binding.imported
  );
  if (!dependency?.resolved) {
    return null;
  }

  if (
    isKnownOpaqueRuntimeImportSource(binding.source) ||
    isKnownOpaqueRuntimeImportSource(dependency.resolved)
  ) {
    return {
      dependencies: [dependency.resolved],
      names: new Set(),
    };
  }

  const resolved = yield* resolveExportAsOpaqueRuntimeImport(
    action,
    dependency.resolved,
    binding.imported,
    stack,
    memo
  );
  return resolved
    ? {
        dependencies: [
          dependency.resolved,
          ...resolved.dependencies.filter(
            (item) => item !== dependency.resolved
          ),
        ],
        names: resolved.names,
      }
    : null;
}

export function* collectOpaqueRuntimeImportProof(
  action: ITransformAction,
  filename: string,
  program: Program,
  expression: Expression
): SyncScenarioFor<OpaqueRuntimeImportProof> {
  const extendsExpressions = collectWYWMetaExtendsExpressionsDeep(
    program,
    expression
  );
  if (extendsExpressions.length === 0) {
    return {
      dependencies: [],
      names: new Set(),
    };
  }

  const imports = collectImportBindings(program, { includeNamespace: true });
  const referencedNames = new Set<string>();
  extendsExpressions.forEach((extendsExpression) =>
    collectOpaqueRuntimeReferenceNames(
      program,
      extendsExpression,
      referencedNames
    )
  );

  const dependencies = new Set<string>();
  const names = new Set<string>();
  const memo = new Map<string, OpaqueRuntimeImportProof | null>();

  for (const name of referencedNames) {
    const binding = imports.get(name);
    if (!binding || binding.source === 'react') {
      continue;
    }

    const proof = yield* resolveImportAsOpaqueRuntime(
      action,
      filename,
      binding,
      new Set(),
      memo
    );
    if (!proof) {
      continue;
    }

    names.add(name);
    proof.dependencies.forEach((dependency) => dependencies.add(dependency));
  }

  return {
    dependencies: [...dependencies],
    names,
  };
}
