/* eslint-disable no-continue, @typescript-eslint/no-use-before-define, @typescript-eslint/no-explicit-any, no-param-reassign */
import path from 'path';

import type {
  ExportAllDeclaration,
  ExportNamedDeclaration,
  ImportDeclaration,
  ImportSpecifier,
  ModuleExportName,
  Statement,
} from 'oxc-parser';

import { oxcShaker } from '../../shaker';
import {
  TransformCacheCollection,
  type TransformCacheEpoch,
} from '../../cache';
import { EventEmitter } from '../../utils/EventEmitter';
import { collectOxcExportsAndImports } from '../../utils/collectOxcExportsAndImports';
import { analyzeOxcBarrelFile } from '../oxcBarrelManifest';
import { Entrypoint } from '../Entrypoint';
import type { IEntrypointDependency } from '../Entrypoint.types';
import type { ITransformAction, Services } from '../types';
import type {
  BarrelBlockedReason,
  BarrelManifest,
  BarrelManifestCacheEntry,
  BarrelManifestExport,
  BarrelResolvedBinding,
  RawBarrelManifest,
} from '../barrelManifest.types';
import { parseRewrittenBarrel } from './parse-rewritten-barrel';

const NODE_MODULES_SEGMENT = `${path.sep}node_modules${path.sep}`;

type RewriteResult = {
  code: string;
  fullyRewrittenSources: string[];
  generatedSources: string[];
  imports: Map<string, string[]> | null;
  optimizedCount: number;
  partialFallbackSources: string[];
  preResolvedImports: IEntrypointDependency[];
  skippedCount: number;
};

type RewriteMode = 'full' | 'partial' | 'unchanged';

type StatementRewriteResult = {
  generatedSources: string[];
  mode: RewriteMode;
  statements: string[];
};

type ResolvedDependencyMap = Map<string, IEntrypointDependency>;

type StarCandidate = {
  binding: BarrelResolvedBinding;
  exported: string;
};

type RewrittenImportSpecifier =
  | {
      kind: 'default';
      local: string;
      source: string;
    }
  | {
      imported: string;
      kind: 'named';
      local: string;
      source: string;
    };

type RewrittenExportSpecifier =
  | {
      exported: string;
      imported: string;
      kind: 'named';
      source: string;
    }
  | {
      exported: string;
      kind: 'namespace';
      source: string;
    };

type IneligibleBarrelEntry = Exclude<BarrelManifestCacheEntry, BarrelManifest>;

type Replacement = {
  end: number;
  start: number;
  value: string;
};

const createAnalysisServices = (
  services: Services,
  cacheEpoch: TransformCacheEpoch
): Services => ({
  ...services,
  cache: new TransformCacheCollection({
    barrelManifests: services.cache.barrelManifests,
    epochOwner: cacheEpoch.owner,
    exports: services.cache.exports,
  }),
  cacheEpoch,
  eventEmitter: EventEmitter.dummy,
});

const addBinding = (
  manifest: Record<string, BarrelManifestExport>,
  exported: string,
  binding: BarrelResolvedBinding,
  explicitExports: Set<string>
) => {
  const existing = manifest[exported];
  if (explicitExports.has(exported)) {
    return;
  }

  if (!existing) {
    manifest[exported] = binding;
    return;
  }

  if (existing.kind === 'blocked') {
    return;
  }

  if (!isSameBinding(existing, binding)) {
    manifest[exported] = {
      kind: 'blocked',
      reason: 'ambiguous',
    };
  }
};

const addBlockedExport = (
  manifest: Record<string, BarrelManifestExport>,
  exported: string,
  reason: BarrelBlockedReason
) => {
  manifest[exported] = {
    kind: 'blocked',
    reason,
  };
};

const addImport = (
  imports: Map<string, string[]>,
  source: string,
  imported: string
): void => {
  const bucket = imports.get(source) ?? [];
  if (!bucket.includes(imported)) {
    bucket.push(imported);
  }

  imports.set(source, bucket);
};

const applyReplacements = (
  code: string,
  replacements: Replacement[]
): string => {
  let result = code;
  replacements
    .sort((a, b) => b.start - a.start)
    .forEach((replacement) => {
      result =
        result.slice(0, replacement.start) +
        replacement.value +
        result.slice(replacement.end);
    });

  return result;
};

const buildResolvedDependencyMap = (
  resolvedImports: IEntrypointDependency[]
): ResolvedDependencyMap =>
  new Map(resolvedImports.map((dependency) => [dependency.source, dependency]));

const isSameBinding = (
  left: BarrelResolvedBinding,
  right: BarrelResolvedBinding
): boolean => {
  if (left.kind !== right.kind) {
    return false;
  }

  if (left.source !== right.source) {
    return false;
  }

  if (left.kind === 'named' && right.kind === 'named') {
    return left.imported === right.imported;
  }

  return true;
};

const isValidIdentifier = (name: string): boolean =>
  /^[$A-Z_a-z][$\w]*$/.test(name);

const canEmitNamedReexport = (imported: string): boolean =>
  imported === 'default' || isValidIdentifier(imported);

const quote = (value: string): string => JSON.stringify(value);

const moduleName = (node: ModuleExportName): string =>
  node.type === 'Literal' ? String(node.value) : node.name;

const importedNameCode = (name: string): string =>
  name === 'default' || isValidIdentifier(name) ? name : quote(name);

const exportedNameCode = (name: string): string =>
  isValidIdentifier(name) ? name : quote(name);

const importSpecifierCode = (specifier: RewrittenImportSpecifier): string => {
  if (specifier.kind === 'default') {
    return specifier.local;
  }

  const imported = importedNameCode(specifier.imported);
  return imported === specifier.local
    ? imported
    : `${imported} as ${specifier.local}`;
};

const exportSpecifierCode = (specifier: RewrittenExportSpecifier): string => {
  if (specifier.kind === 'namespace') {
    return `* as ${specifier.exported}`;
  }

  const imported = importedNameCode(specifier.imported);
  const exported = exportedNameCode(specifier.exported);
  return imported === exported ? imported : `${imported} as ${exported}`;
};

function createAnalysisEntrypoint(
  services: Services,
  filename: string,
  loadedCode?: string,
  graphTraversalToken?: object
): Entrypoint {
  return Entrypoint.createRoot(services, filename, ['*'], loadedCode, {
    graphTraversalToken,
  });
}

function getUniqueSources(raw: RawBarrelManifest): string[] {
  return Array.from(
    new Set([
      ...raw.reexports.map((reexport) => reexport.source),
      ...raw.exportAll,
    ])
  );
}

function buildImportsForResolve(raw: RawBarrelManifest): Map<string, string[]> {
  return new Map(getUniqueSources(raw).map((source) => [source, []]));
}

function getReexportResolutionMap(
  resolvedImports: IEntrypointDependency[]
): Map<string, string | null> {
  return new Map(
    resolvedImports.map((dependency) => [
      dependency.source,
      dependency.resolved,
    ])
  );
}

function isBarrelEntry(
  entry: BarrelManifestCacheEntry
): entry is BarrelManifest {
  return entry.kind === 'barrel';
}

function isRawBarrelManifest(
  entry: BarrelManifestCacheEntry | RawBarrelManifest
): entry is RawBarrelManifest {
  return 'reexports' in entry;
}

function shouldUseDirectExports(
  reason: IneligibleBarrelEntry['reason']
): boolean {
  return reason === 'impure';
}

function emitRewriteSkipped(
  action: ITransformAction,
  source: string,
  reason: BarrelBlockedReason
) {
  action.services.eventEmitter.single({
    file: action.entrypoint.name,
    kind: 'barrelRewriteSkipped',
    reason,
    source,
  });
}

function getManifestExport(
  manifest: BarrelManifest,
  exported: string
): BarrelManifestExport | null {
  return manifest.exports[exported] ?? null;
}

function collectOptimizedImports(
  code: string,
  filename: string
): Map<string, string[]> {
  const imports = new Map<string, string[]>();
  const program = parseRewrittenBarrel(code, filename);

  for (const statement of program.body as Statement[]) {
    if (statement.type === 'ImportDeclaration') {
      if (statement.importKind === 'type') {
        continue;
      }

      if (statement.specifiers.length === 0) {
        addImport(imports, statement.source.value, 'side-effect');
        continue;
      }

      for (const specifier of statement.specifiers) {
        if (
          specifier.type === 'ImportSpecifier' &&
          specifier.importKind === 'type'
        ) {
          continue;
        }

        if (specifier.type === 'ImportDefaultSpecifier') {
          addImport(imports, statement.source.value, 'default');
          continue;
        }

        if (specifier.type === 'ImportNamespaceSpecifier') {
          addImport(imports, statement.source.value, '*');
          continue;
        }

        addImport(
          imports,
          statement.source.value,
          moduleName(specifier.imported)
        );
      }
      continue;
    }

    if (statement.type === 'ExportNamedDeclaration' && statement.source) {
      if (statement.exportKind === 'type') {
        continue;
      }

      for (const specifier of statement.specifiers) {
        if (
          specifier.type === 'ExportSpecifier' &&
          specifier.exportKind !== 'type'
        ) {
          addImport(
            imports,
            statement.source.value,
            moduleName(specifier.local)
          );
        }
      }
      continue;
    }

    if (statement.type === 'ExportAllDeclaration') {
      if (statement.exportKind !== 'type') {
        addImport(imports, statement.source.value, '*');
      }
    }
  }

  return imports;
}

function groupImportSpecifiers(
  optimized: RewrittenImportSpecifier[]
): string[] {
  const grouped = new Map<
    string,
    {
      defaults: RewrittenImportSpecifier[];
      named: RewrittenImportSpecifier[];
    }
  >();

  for (const specifier of optimized) {
    if (!grouped.has(specifier.source)) {
      grouped.set(specifier.source, {
        defaults: [],
        named: [],
      });
    }

    const bucket = grouped.get(specifier.source)!;
    if (specifier.kind === 'default') {
      bucket.defaults.push(specifier);
    } else {
      bucket.named.push(specifier);
    }
  }

  const declarations: string[] = [];
  for (const [source, bucket] of grouped) {
    const named = bucket.named.map(importSpecifierCode);
    if (bucket.defaults.length === 0) {
      declarations.push(
        `import { ${named.join(', ')} } from ${quote(source)};`
      );
      continue;
    }

    const firstDefault = importSpecifierCode(bucket.defaults[0]);
    declarations.push(
      named.length > 0
        ? `import ${firstDefault}, { ${named.join(', ')} } from ${quote(
            source
          )};`
        : `import ${firstDefault} from ${quote(source)};`
    );

    bucket.defaults.slice(1).forEach((specifier) => {
      declarations.push(
        `import ${importSpecifierCode(specifier)} from ${quote(source)};`
      );
    });
  }

  return declarations;
}

function groupExportSpecifiers(
  optimized: RewrittenExportSpecifier[]
): string[] {
  const grouped = new Map<string, RewrittenExportSpecifier[]>();
  const namespaceDeclarations: string[] = [];

  for (const specifier of optimized) {
    if (specifier.kind === 'namespace') {
      namespaceDeclarations.push(
        `export * as ${specifier.exported} from ${quote(specifier.source)};`
      );
      continue;
    }

    if (!grouped.has(specifier.source)) {
      grouped.set(specifier.source, []);
    }

    grouped.get(specifier.source)!.push(specifier);
  }

  return [
    ...namespaceDeclarations,
    ...Array.from(grouped.entries()).map(
      ([source, specifiers]) =>
        `export { ${specifiers
          .map(exportSpecifierCode)
          .join(', ')} } from ${quote(source)};`
    ),
  ];
}

const sourceLiteral = (source: string): string => quote(source);

function createImportFallback(
  code: string,
  statement: ImportDeclaration,
  fallbackSpecifiers: ImportDeclaration['specifiers']
): string | null {
  if (fallbackSpecifiers.length === 0) {
    return null;
  }

  const defaults = fallbackSpecifiers.filter(
    (specifier) => specifier.type === 'ImportDefaultSpecifier'
  );
  const namespaces = fallbackSpecifiers.filter(
    (specifier) => specifier.type === 'ImportNamespaceSpecifier'
  );
  const named = fallbackSpecifiers.filter(
    (specifier): specifier is ImportSpecifier =>
      specifier.type === 'ImportSpecifier'
  );
  const renderedNamed = named.map((specifier) =>
    code.slice(specifier.start, specifier.end)
  );
  const source = sourceLiteral(statement.source.value);

  if (defaults.length > 0) {
    const prefix = code.slice(defaults[0].start, defaults[0].end);
    if (namespaces.length > 0) {
      return `import ${prefix}, ${code.slice(
        namespaces[0].start,
        namespaces[0].end
      )} from ${source};`;
    }

    if (renderedNamed.length > 0) {
      return `import ${prefix}, { ${renderedNamed.join(
        ', '
      )} } from ${source};`;
    }

    return `import ${prefix} from ${source};`;
  }

  if (namespaces.length > 0) {
    return `import ${code.slice(
      namespaces[0].start,
      namespaces[0].end
    )} from ${source};`;
  }

  return `import { ${renderedNamed.join(', ')} } from ${source};`;
}

function createExportFallback(
  code: string,
  statement: ExportNamedDeclaration,
  fallbackSpecifiers: ExportNamedDeclaration['specifiers']
): string | null {
  if (!statement.source || fallbackSpecifiers.length === 0) {
    return null;
  }

  return `export { ${fallbackSpecifiers
    .map((specifier) => code.slice(specifier.start, specifier.end))
    .join(', ')} } from ${sourceLiteral(statement.source.value)};`;
}

function* getNamedBinding(
  this: ITransformAction,
  analysisServices: Services,
  targetResolved: string,
  imported: string,
  stack: Set<string>
): Generator<any, BarrelManifestExport, any> {
  if (stack.has(targetResolved)) {
    return {
      kind: 'blocked',
      reason: 'cycle',
    };
  }

  const targetManifest = yield* getOrBuildOxcBarrelManifest.call(
    this,
    analysisServices,
    targetResolved,
    stack
  );

  if (isBarrelEntry(targetManifest)) {
    const resolved = getManifestExport(targetManifest, imported);
    if (resolved) {
      return resolved;
    }

    return {
      kind: 'blocked',
      reason: targetManifest.complete ? 'unresolved' : 'unknown-star',
    };
  }

  return {
    kind: 'named',
    imported,
    source: targetResolved,
  };
}

function* getStarCandidates(
  this: ITransformAction,
  analysisServices: Services,
  targetResolved: string,
  stack: Set<string>
): Generator<
  any,
  { candidates: StarCandidate[]; complete: boolean; dependencies: string[] },
  any
> {
  if (stack.has(targetResolved)) {
    return {
      candidates: [],
      complete: false,
      dependencies: [],
    };
  }

  const targetManifest = yield* getOrBuildOxcBarrelManifest.call(
    this,
    analysisServices,
    targetResolved,
    stack
  );

  if (isBarrelEntry(targetManifest)) {
    if (!targetManifest.complete) {
      return {
        candidates: [],
        complete: false,
        dependencies: [],
      };
    }

    return {
      candidates: Object.entries(targetManifest.exports)
        .filter(
          ([exported, binding]) =>
            exported !== 'default' && binding.kind !== 'blocked'
        )
        .map(([exported, binding]) => ({
          binding: binding as BarrelResolvedBinding,
          exported,
        })),
      complete: true,
      dependencies: [],
    };
  }

  if (!shouldUseDirectExports(targetManifest.reason)) {
    return {
      candidates: [],
      complete: false,
      dependencies: [],
    };
  }

  const exports = yield* getExportsForFile.call(
    this,
    analysisServices,
    targetResolved
  );
  const dependencies = yield* getWildcardExportDependencies.call(
    this,
    analysisServices,
    targetResolved,
    stack
  );

  return {
    candidates: exports
      .filter((exported) => exported !== 'default')
      .map((exported) => ({
        binding: {
          kind: 'named',
          imported: exported,
          source: targetResolved,
        } satisfies BarrelResolvedBinding,
        exported,
      })),
    complete: true,
    dependencies,
  };
}

function* getWildcardExportDependencies(
  this: ITransformAction,
  analysisServices: Services,
  filename: string,
  stack: Set<string>
): Generator<any, string[], any> {
  if (stack.has(filename)) {
    return [];
  }

  const loadedAndParsed = analysisServices.loadAndParseFn(
    analysisServices,
    filename,
    undefined,
    analysisServices.log
  );

  if (
    loadedAndParsed.evaluator === 'ignored' ||
    loadedAndParsed.evaluator !== oxcShaker
  ) {
    return [];
  }

  const exportNames = yield* getExportsForFile.call(
    this,
    analysisServices,
    filename
  );
  this.entrypoint.assertNotSuperseded();
  this.services.cache.publish(
    this.entrypoint.cacheEpoch,
    'exports',
    filename,
    exportNames
  );

  const wildcardReexports = collectOxcExportsAndImports(
    loadedAndParsed.code,
    filename
  ).reexports.filter((reexport) => reexport.exported === '*');

  if (wildcardReexports.length === 0) {
    return [];
  }

  const resolveEntrypoint = createAnalysisEntrypoint(
    analysisServices,
    filename,
    loadedAndParsed.code,
    this.entrypoint.graphTraversalToken
  );
  const resolvedImports = yield* this.getNext(
    'resolveImports',
    resolveEntrypoint,
    {
      imports: new Map(
        wildcardReexports.map((reexport) => [reexport.source, []])
      ),
    },
    null,
    analysisServices
  );

  const dependencies = new Set<string>();
  const nextStack = new Set(stack);
  nextStack.add(filename);

  for (const dependency of resolvedImports) {
    if (!dependency.resolved) {
      continue;
    }

    dependencies.add(dependency.resolved);
    const nested = yield* getWildcardExportDependencies.call(
      this,
      analysisServices,
      dependency.resolved,
      nextStack
    );
    nested.forEach((item) => dependencies.add(item));
  }

  this.entrypoint.assertNotSuperseded();
  this.services.cache.publishCacheDependencies(
    this.entrypoint.cacheEpoch,
    'exports',
    filename,
    dependencies
  );

  return [...dependencies];
}

function* getExportsForFile(
  this: ITransformAction,
  services: Services,
  filename: string
): Generator<any, string[], any> {
  const entrypoint = createAnalysisEntrypoint(
    services,
    filename,
    undefined,
    this.entrypoint.graphTraversalToken
  );
  return yield* this.getNext(
    'getExports',
    entrypoint,
    undefined,
    null,
    services
  );
}

function* getOrBuildOxcBarrelManifest(
  this: ITransformAction,
  analysisServices: Services,
  filename: string,
  stack: Set<string> = new Set()
): Generator<any, BarrelManifestCacheEntry, any> {
  this.entrypoint.assertNotSuperseded();
  const cached = this.services.cache.get('barrelManifests', filename);
  if (cached) {
    this.services.eventEmitter.single({
      file: filename,
      kind: 'barrelManifest',
      status: 'hit',
    });
    return cached;
  }

  const loadedAndParsed = analysisServices.loadAndParseFn(
    analysisServices,
    filename,
    undefined,
    analysisServices.log
  );

  if (filename.includes(NODE_MODULES_SEGMENT)) {
    const externalEntry = {
      kind: 'ineligible',
      reason: 'custom-evaluator',
    } as const;
    this.entrypoint.assertNotSuperseded();
    this.services.cache.publish(
      this.entrypoint.cacheEpoch,
      'barrelManifests',
      filename,
      externalEntry
    );
    return externalEntry;
  }

  if (loadedAndParsed.evaluator === 'ignored') {
    const ignoredEntry = {
      kind: 'ineligible',
      reason: 'ignored',
    } as const;
    this.entrypoint.assertNotSuperseded();
    this.services.cache.publish(
      this.entrypoint.cacheEpoch,
      'barrelManifests',
      filename,
      ignoredEntry
    );
    return ignoredEntry;
  }

  if (loadedAndParsed.evaluator !== oxcShaker) {
    const customEntry = {
      kind: 'ineligible',
      reason: 'custom-evaluator',
    } as const;
    this.entrypoint.assertNotSuperseded();
    this.services.cache.publish(
      this.entrypoint.cacheEpoch,
      'barrelManifests',
      filename,
      customEntry
    );
    return customEntry;
  }

  const analyzed = analyzeOxcBarrelFile(loadedAndParsed.code, filename);
  if (!isRawBarrelManifest(analyzed)) {
    this.entrypoint.assertNotSuperseded();
    this.services.cache.publish(
      this.entrypoint.cacheEpoch,
      'barrelManifests',
      filename,
      analyzed
    );
    return analyzed;
  }

  const resolveEntrypoint = createAnalysisEntrypoint(
    analysisServices,
    filename,
    loadedAndParsed.code,
    this.entrypoint.graphTraversalToken
  );
  const resolvedImports = yield* this.getNext(
    'resolveImports',
    resolveEntrypoint,
    {
      imports: buildImportsForResolve(analyzed),
    },
    null,
    analysisServices
  );
  const manifestDependencies = resolvedImports.flatMap((dependency) =>
    dependency.resolved ? [dependency.resolved] : []
  );

  const resolutionMap = getReexportResolutionMap(resolvedImports);
  const manifest: BarrelManifest = {
    complete: analyzed.complete,
    exports: {},
    kind: 'barrel',
  };
  const explicitExports = new Set<string>(analyzed.explicitExports);
  const nextStack = new Set(stack);
  nextStack.add(filename);

  for (const reexport of analyzed.reexports) {
    explicitExports.add(reexport.exported);
    const targetResolved = resolutionMap.get(reexport.source);

    if (!targetResolved) {
      manifest.complete = false;
      addBlockedExport(manifest.exports, reexport.exported, 'unresolved');
      continue;
    }

    if (reexport.kind === 'namespace') {
      const namespaceBinding = yield* getNamespaceBinding.call(
        this,
        analysisServices,
        targetResolved,
        nextStack
      );
      manifest.exports[reexport.exported] = namespaceBinding;
      if (namespaceBinding.kind === 'blocked') {
        manifest.complete = false;
      }
      continue;
    }

    const binding = yield* getNamedBinding.call(
      this,
      analysisServices,
      targetResolved,
      reexport.imported,
      nextStack
    );
    manifest.exports[reexport.exported] = binding;
    if (binding.kind === 'blocked') {
      manifest.complete = false;
    }
  }

  for (const exportAllSource of analyzed.exportAll) {
    const targetResolved = resolutionMap.get(exportAllSource);
    if (!targetResolved) {
      manifest.complete = false;
      continue;
    }

    const { candidates, complete, dependencies } =
      yield* getStarCandidates.call(
        this,
        analysisServices,
        targetResolved,
        nextStack
      );
    manifestDependencies.push(...dependencies);

    if (!complete) {
      manifest.complete = false;
      continue;
    }

    for (const candidate of candidates) {
      addBinding(
        manifest.exports,
        candidate.exported,
        candidate.binding,
        explicitExports
      );
    }
  }

  this.entrypoint.assertNotSuperseded();
  this.services.cache.publish(
    this.entrypoint.cacheEpoch,
    'barrelManifests',
    filename,
    manifest
  );
  this.services.cache.publishCacheDependencies(
    this.entrypoint.cacheEpoch,
    'barrelManifests',
    filename,
    manifestDependencies
  );
  this.services.eventEmitter.single({
    complete: manifest.complete,
    file: filename,
    kind: 'barrelManifest',
    status: 'built',
  });

  return manifest;
}

function* getNamespaceBinding(
  this: ITransformAction,
  analysisServices: Services,
  targetResolved: string,
  stack: Set<string>
): Generator<any, BarrelManifestExport, any> {
  if (stack.has(targetResolved)) {
    return {
      kind: 'blocked',
      reason: 'cycle',
    };
  }

  const targetManifest = yield* getOrBuildOxcBarrelManifest.call(
    this,
    analysisServices,
    targetResolved,
    stack
  );

  if (isBarrelEntry(targetManifest)) {
    return {
      kind: 'blocked',
      reason: 'namespace-barrel',
    };
  }

  return {
    kind: 'namespace',
    source: targetResolved,
  };
}

function getResolvedDependency(
  dependencies: ResolvedDependencyMap,
  source: string
): IEntrypointDependency | undefined {
  return dependencies.get(source);
}

function* rewriteImportDeclaration(
  this: ITransformAction,
  analysisServices: Services,
  code: string,
  statement: ImportDeclaration,
  dependencies: ResolvedDependencyMap
): Generator<any, StatementRewriteResult, any> {
  const dependency = getResolvedDependency(
    dependencies,
    statement.source.value
  );
  if (!dependency?.resolved || statement.specifiers.length === 0) {
    return {
      generatedSources: [],
      mode: 'unchanged',
      statements: [code.slice(statement.start, statement.end)],
    };
  }

  const manifest = yield* getOrBuildOxcBarrelManifest.call(
    this,
    analysisServices,
    dependency.resolved
  );
  if (!isBarrelEntry(manifest)) {
    return {
      generatedSources: [],
      mode: 'unchanged',
      statements: [code.slice(statement.start, statement.end)],
    };
  }

  const optimized: RewrittenImportSpecifier[] = [];
  const fallback = [] as ImportDeclaration['specifiers'];

  for (const specifier of statement.specifiers) {
    if (specifier.type === 'ImportNamespaceSpecifier') {
      fallback.push(specifier);
      continue;
    }

    if (specifier.type === 'ImportDefaultSpecifier') {
      const binding = getManifestExport(manifest, 'default');
      if (binding?.kind === 'named' && binding.imported === 'default') {
        optimized.push({
          kind: 'default',
          local: specifier.local.name,
          source: binding.source,
        });
        continue;
      }

      if (binding?.kind === 'blocked') {
        emitRewriteSkipped(this, statement.source.value, binding.reason);
      }
      fallback.push(specifier);
      continue;
    }

    const imported = moduleName(specifier.imported);
    const binding = getManifestExport(manifest, imported);

    if (binding?.kind === 'named') {
      optimized.push({
        imported: binding.imported,
        kind: 'named',
        local: specifier.local.name,
        source: binding.source,
      });
      continue;
    }

    if (binding?.kind === 'blocked') {
      emitRewriteSkipped(this, statement.source.value, binding.reason);
    }
    fallback.push(specifier);
  }

  if (optimized.length === 0) {
    return {
      generatedSources: [],
      mode: 'unchanged',
      statements: [code.slice(statement.start, statement.end)],
    };
  }

  const rewritten = groupImportSpecifiers(optimized);
  const fallbackDeclaration = createImportFallback(code, statement, fallback);
  const mode: RewriteMode = fallbackDeclaration ? 'partial' : 'full';

  this.services.eventEmitter.single({
    file: this.entrypoint.name,
    kind: 'barrelRewrite',
    mode,
    optimized: optimized.length,
    source: statement.source.value,
  });

  return {
    generatedSources: Array.from(
      new Set(optimized.map((specifier) => specifier.source))
    ),
    mode,
    statements: fallbackDeclaration
      ? [fallbackDeclaration, ...rewritten]
      : rewritten,
  };
}

function* rewriteExportNamedDeclaration(
  this: ITransformAction,
  analysisServices: Services,
  code: string,
  statement: ExportNamedDeclaration,
  dependencies: ResolvedDependencyMap
): Generator<any, StatementRewriteResult, any> {
  if (!statement.source) {
    return {
      generatedSources: [],
      mode: 'unchanged',
      statements: [code.slice(statement.start, statement.end)],
    };
  }

  const dependency = getResolvedDependency(
    dependencies,
    statement.source.value
  );
  if (!dependency?.resolved) {
    return {
      generatedSources: [],
      mode: 'unchanged',
      statements: [code.slice(statement.start, statement.end)],
    };
  }

  const manifest = yield* getOrBuildOxcBarrelManifest.call(
    this,
    analysisServices,
    dependency.resolved
  );
  if (!isBarrelEntry(manifest)) {
    return {
      generatedSources: [],
      mode: 'unchanged',
      statements: [code.slice(statement.start, statement.end)],
    };
  }

  const optimized: RewrittenExportSpecifier[] = [];
  const fallback = [] as ExportNamedDeclaration['specifiers'];

  for (const specifier of statement.specifiers) {
    if (specifier.type !== 'ExportSpecifier') {
      fallback.push(specifier);
      continue;
    }

    const imported = moduleName(specifier.local);
    const exported = moduleName(specifier.exported);
    const binding = getManifestExport(manifest, imported);

    if (binding?.kind === 'named' && canEmitNamedReexport(binding.imported)) {
      optimized.push({
        exported,
        imported: binding.imported,
        kind: 'named',
        source: binding.source,
      });
      continue;
    }

    if (binding?.kind === 'namespace' && isValidIdentifier(exported)) {
      optimized.push({
        exported,
        kind: 'namespace',
        source: binding.source,
      });
      continue;
    }

    if (binding?.kind === 'blocked') {
      emitRewriteSkipped(this, statement.source.value, binding.reason);
    }
    fallback.push(specifier);
  }

  if (optimized.length === 0) {
    return {
      generatedSources: [],
      mode: 'unchanged',
      statements: [code.slice(statement.start, statement.end)],
    };
  }

  const rewritten = groupExportSpecifiers(optimized);
  const fallbackDeclaration = createExportFallback(code, statement, fallback);
  const mode: RewriteMode = fallbackDeclaration ? 'partial' : 'full';

  this.services.eventEmitter.single({
    file: this.entrypoint.name,
    kind: 'barrelRewrite',
    mode,
    optimized: optimized.length,
    source: statement.source.value,
  });

  return {
    generatedSources: Array.from(
      new Set(optimized.map((specifier) => specifier.source))
    ),
    mode,
    statements: fallbackDeclaration
      ? [fallbackDeclaration, ...rewritten]
      : rewritten,
  };
}

function* rewriteExportAllDeclaration(
  this: ITransformAction,
  analysisServices: Services,
  code: string,
  statement: ExportAllDeclaration,
  dependencies: ResolvedDependencyMap
): Generator<any, StatementRewriteResult, any> {
  if (statement.exported) {
    return {
      generatedSources: [],
      mode: 'unchanged',
      statements: [code.slice(statement.start, statement.end)],
    };
  }

  const dependency = getResolvedDependency(
    dependencies,
    statement.source.value
  );
  if (!dependency?.resolved) {
    return {
      generatedSources: [],
      mode: 'unchanged',
      statements: [code.slice(statement.start, statement.end)],
    };
  }

  const manifest = yield* getOrBuildOxcBarrelManifest.call(
    this,
    analysisServices,
    dependency.resolved
  );
  if (!isBarrelEntry(manifest) || !manifest.complete) {
    return {
      generatedSources: [],
      mode: 'unchanged',
      statements: [code.slice(statement.start, statement.end)],
    };
  }

  const optimized: RewrittenExportSpecifier[] = [];
  let hasUnrewritableExport = false;
  for (const [exported, binding] of Object.entries(manifest.exports)) {
    if (exported === 'default' || binding.kind === 'blocked') {
      continue;
    }

    if (binding.kind === 'namespace') {
      if (!isValidIdentifier(exported)) {
        emitRewriteSkipped(this, statement.source.value, 'namespace-barrel');
        hasUnrewritableExport = true;
        continue;
      }

      optimized.push({
        exported,
        kind: 'namespace',
        source: binding.source,
      });
      continue;
    }

    if (!canEmitNamedReexport(binding.imported)) {
      emitRewriteSkipped(this, statement.source.value, 'unknown-star');
      hasUnrewritableExport = true;
      continue;
    }

    optimized.push({
      exported,
      imported: binding.imported,
      kind: 'named',
      source: binding.source,
    });
  }

  if (hasUnrewritableExport) {
    return {
      generatedSources: [],
      mode: 'unchanged',
      statements: [code.slice(statement.start, statement.end)],
    };
  }

  if (optimized.length === 0) {
    this.services.eventEmitter.single({
      file: this.entrypoint.name,
      kind: 'barrelRewrite',
      mode: 'full',
      optimized: 0,
      source: statement.source.value,
    });

    return {
      generatedSources: [],
      mode: 'full',
      statements: [],
    };
  }

  this.services.eventEmitter.single({
    complete: true,
    file: this.entrypoint.name,
    kind: 'barrelRewrite',
    mode: 'full',
    optimized: optimized.length,
    source: statement.source.value,
  });

  return {
    generatedSources: Array.from(
      new Set(optimized.map((specifier) => specifier.source))
    ),
    mode: 'full',
    statements: groupExportSpecifiers(optimized),
  };
}

export function* rewriteOptimizedOxcBarrelImports(
  this: ITransformAction,
  code: string,
  filename: string,
  resolvedImports: IEntrypointDependency[]
): Generator<any, RewriteResult, any> {
  const dependencies = buildResolvedDependencyMap(resolvedImports);
  const analysisServices = createAnalysisServices(
    this.services,
    this.entrypoint.cacheEpoch
  );
  const program = parseRewrittenBarrel(code, filename);
  const replacements: Replacement[] = [];
  const generatedSources = new Set<string>();
  let optimizedCount = 0;
  const sourceModes = new Map<string, Exclude<RewriteMode, 'unchanged'>>();
  let skippedCount = 0;

  const recordSourceMode = (
    source: string,
    mode: RewriteMode,
    statementChanged: boolean
  ) => {
    if (mode === 'unchanged') {
      return;
    }

    if (statementChanged) {
      optimizedCount += 1;
    }

    if (mode === 'partial') {
      sourceModes.set(source, 'partial');
      return;
    }

    if (!sourceModes.has(source)) {
      sourceModes.set(source, 'full');
    }
  };

  for (const statement of program.body as Statement[]) {
    let rewritten: StatementRewriteResult | null = null;
    let source: string | null = null;

    if (statement.type === 'ImportDeclaration') {
      source = statement.source.value;
      rewritten = yield* rewriteImportDeclaration.call(
        this,
        analysisServices,
        code,
        statement,
        dependencies
      );
    } else if (
      statement.type === 'ExportNamedDeclaration' &&
      statement.source
    ) {
      source = statement.source.value;
      rewritten = yield* rewriteExportNamedDeclaration.call(
        this,
        analysisServices,
        code,
        statement,
        dependencies
      );
    } else if (statement.type === 'ExportAllDeclaration') {
      source = statement.source.value;
      rewritten = yield* rewriteExportAllDeclaration.call(
        this,
        analysisServices,
        code,
        statement,
        dependencies
      );
      if (
        rewritten.mode === 'unchanged' &&
        rewritten.statements.length === 1 &&
        rewritten.statements[0] === code.slice(statement.start, statement.end)
      ) {
        skippedCount += 1;
      }
    }

    if (!rewritten || source === null) {
      continue;
    }

    const original = code.slice(statement.start, statement.end);
    const next = rewritten.statements.join('\n');
    const statementChanged = next !== original;
    recordSourceMode(source, rewritten.mode, statementChanged);
    rewritten.generatedSources.forEach((generatedSource) =>
      generatedSources.add(generatedSource)
    );

    if (statementChanged) {
      replacements.push({
        end: statement.end,
        start: statement.start,
        value: next,
      });
    }
  }

  const rewrittenCode =
    replacements.length > 0 ? applyReplacements(code, replacements) : code;
  const imports = collectOptimizedImports(rewrittenCode, filename);
  const preResolvedImports = Array.from(imports.entries()).flatMap(
    ([source, only]) => {
      const dependency = dependencies.get(source);
      if (dependency) {
        return [
          {
            ...dependency,
            only,
          },
        ];
      }

      if (generatedSources.has(source)) {
        return [
          {
            only,
            resolved: source,
            source,
          },
        ];
      }

      return [];
    }
  );

  return {
    code: rewrittenCode,
    fullyRewrittenSources: Array.from(sourceModes.entries())
      .filter(([, mode]) => mode === 'full')
      .map(([source]) => source),
    generatedSources: Array.from(generatedSources),
    imports,
    optimizedCount,
    partialFallbackSources: Array.from(sourceModes.entries())
      .filter(([, mode]) => mode === 'partial')
      .map(([source]) => source),
    preResolvedImports,
    skippedCount,
  };
}
