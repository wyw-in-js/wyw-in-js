import type { Node, Program } from 'oxc-parser';
import { collectExternalReferences } from './executableIndex';
import {
  getOxcRuntimePropertyPathKeyRoot,
  type OxcRuntimePropertyPathKey,
} from '../oxc/projections';
import type { collectTopLevelAliases } from './bindingProvenance';
import {
  aliasesImportedRootCohortInState,
  aliasesImportedRootInState,
  getAliasComponentId,
  getAliasComponentMembers,
} from './bindingProvenance';
import { createNormalizedCatalogResolver } from './provenanceClosure';

type StatementOwner = { node: Node };

type AnyNode = Node & Record<string, unknown>;

export const collectRootImportedBindings = (program: Program): Set<string> => {
  const rootImportedBindings = new Set<string>();
  program.body.forEach((node) => {
    if (
      node.type !== 'ImportDeclaration' ||
      (node as AnyNode).importKind === 'type'
    ) {
      return;
    }

    node.specifiers.forEach((specifier) => {
      if ((specifier as AnyNode).importKind !== 'type') {
        rootImportedBindings.add(specifier.local.name);
      }
    });
  });

  return rootImportedBindings;
};

export const createCallableCatalogResolver = <T>(
  catalog: ReadonlyMap<string, T>,
  topLevelAliasState: ReturnType<typeof collectTopLevelAliases>,
  normalizeProvenancePath: (
    path: OxcRuntimePropertyPathKey
  ) => OxcRuntimePropertyPathKey
): ((binding: string) => Set<T>) => {
  const resolveNormalized = createNormalizedCatalogResolver(catalog, (path) =>
    normalizeProvenancePath(path as OxcRuntimePropertyPathKey)
  );
  const componentCandidates = new Map<string, Set<T>>();
  const resolveComponentCandidates = (binding: string): Set<T> => {
    const componentId = getAliasComponentId(topLevelAliasState, binding);
    const cached = componentCandidates.get(componentId);
    if (cached) {
      return new Set(cached);
    }

    const candidates = new Set<T>();
    getAliasComponentMembers(topLevelAliasState, binding).forEach((member) => {
      const candidate = catalog.get(member);
      if (candidate) {
        candidates.add(candidate);
      }
    });
    componentCandidates.set(componentId, candidates);
    return new Set(candidates);
  };
  return (binding) => {
    const path = binding as OxcRuntimePropertyPathKey;
    const root = getOxcRuntimePropertyPathKeyRoot(path);
    // A bare imported binding cannot have a local declaration, but a direct
    // alias can share its component with local callables or classes. Keep
    // those candidates without widening to the imported-result cohort.
    if (
      root === path &&
      aliasesImportedRootInState(topLevelAliasState, root) &&
      !aliasesImportedRootCohortInState(topLevelAliasState, root)
    ) {
      return resolveComponentCandidates(root);
    }
    return resolveNormalized(binding);
  };
};

export const createAliasComponentIndex = (
  topLevelAliasState: ReturnType<typeof collectTopLevelAliases>
): Map<string, Set<string>> => {
  const aliasComponents = new Map<string, Set<string>>();
  const indexedAliasComponents = new Set<string>();
  topLevelAliasState.aliases.forEach((_directAliases, binding) => {
    const componentId = getAliasComponentId(topLevelAliasState, binding);
    if (indexedAliasComponents.has(componentId)) {
      return;
    }
    indexedAliasComponents.add(componentId);
    const component = getAliasComponentMembers(topLevelAliasState, binding);
    component.forEach((member) =>
      aliasComponents.set(member, component as Set<string>)
    );
  });

  return aliasComponents;
};

export const createStatementReferenceCollector = () => {
  const externalReferencesByStatement = new Map<StatementOwner, Set<string>>();
  const getExternalStatementReferences = (
    statement: StatementOwner
  ): Set<string> => {
    const cached = externalReferencesByStatement.get(statement);
    if (cached) {
      return cached;
    }
    const references = collectExternalReferences(statement.node);
    externalReferencesByStatement.set(statement, references);
    return references;
  };
  return getExternalStatementReferences;
};
