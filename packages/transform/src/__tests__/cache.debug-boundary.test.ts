import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { parseSync } from 'oxc-parser';

const srcDir = resolve(__dirname, '..');
const debugDir = join(srcDir, 'debug');

// Cache modules may still report into pipeline telemetry through these
// write-only sinks until the telemetry observer replaces them. Nothing that
// the cache reads (hashes, memo lookups, flags) may come from debug modules.
const WRITE_ONLY_TELEMETRY_SINKS = [
  'recordPipelineCacheClear',
  'recordPipelineCacheRequest',
  'recordPipelineCacheSalt',
];

type ImportedBinding = { name: string; target: string };

const isInside = (file: string, dir: string): boolean =>
  file === dir || file.startsWith(`${dir}${sep}`);

const resolveSourceFile = (from: string, request: string): string => {
  const base = resolve(dirname(from), request);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? base;
};

const collectRelativeImports = (file: string): ImportedBinding[] => {
  const source = readFileSync(file, 'utf8');
  const { module } = parseSync(file, source, { sourceType: 'module' });
  const bindings: ImportedBinding[] = [];
  const add = (request: string, name: string) => {
    if (request.startsWith('.')) {
      bindings.push({ name, target: resolveSourceFile(file, request) });
    }
  };

  for (const staticImport of module.staticImports) {
    const request = staticImport.moduleRequest.value;
    if (staticImport.entries.length === 0) add(request, '<side effect>');
    for (const entry of staticImport.entries) {
      add(request, entry.importName.name ?? `<${entry.importName.kind}>`);
    }
  }
  for (const staticExport of module.staticExports) {
    for (const entry of staticExport.entries) {
      if (entry.moduleRequest) {
        add(
          entry.moduleRequest.value,
          entry.importName.name ?? `<${entry.importName.kind}>`
        );
      }
    }
  }
  for (const dynamicImport of module.dynamicImports) {
    const request = source
      .slice(dynamicImport.moduleRequest.start, dynamicImport.moduleRequest.end)
      .replace(/^['"`]|['"`]$/g, '');
    add(request, '<dynamic import>');
  }

  return bindings;
};

const collectImportClosure = (entry: string): Set<string> => {
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (!visited.has(file) && existsSync(file)) {
      visited.add(file);
      for (const { target } of collectRelativeImports(file)) {
        queue.push(target);
      }
    }
  }
  return visited;
};

const cacheModules = [
  join(srcDir, 'cache.ts'),
  ...readdirSync(join(srcDir, 'cache'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(srcDir, 'cache', name)),
];

const toSrcPath = (file: string) => relative(srcDir, file).split(sep).join('/');

describe('cache → debug boundary', () => {
  it('lets cache modules use only write-only telemetry sinks from debug', () => {
    const debugImports = cacheModules.flatMap((file) =>
      collectRelativeImports(file)
        .filter(({ target }) => isInside(target, debugDir))
        .map(({ name, target }) => ({
          from: toSrcPath(file),
          name,
          target: toSrcPath(target),
        }))
    );

    expect(
      debugImports.filter(
        ({ name }) => !WRITE_ONLY_TELEMETRY_SINKS.includes(name)
      )
    ).toEqual([]);
    // Keep the exception list honest: once a sink stops being imported, it
    // must be removed from the list rather than silently re-allowed later.
    expect([...new Set(debugImports.map(({ name }) => name))].sort()).toEqual(
      WRITE_ONLY_TELEMETRY_SINKS
    );
  });

  it('keeps content hashing and cache types out of reach of debug modules', () => {
    for (const entry of [
      join(srcDir, 'utils', 'contentHash.ts'),
      join(srcDir, 'cache', 'cacheTypes.ts'),
    ]) {
      expect(existsSync(entry)).toBe(true);
      const reachedDebugModules = [...collectImportClosure(entry)]
        .filter((file) => isInside(file, debugDir))
        .map(toSrcPath);
      expect({ entry: toSrcPath(entry), reachedDebugModules }).toEqual({
        entry: toSrcPath(entry),
        reachedDebugModules: [],
      });
    }
  });

  it('routes every cache content hash through the content hash module', () => {
    const hashOwners = cacheModules.flatMap((file) =>
      collectRelativeImports(file)
        .filter(({ name }) => name === 'hashContent')
        .map(({ target }) => toSrcPath(target))
    );

    expect(hashOwners.length).toBeGreaterThan(0);
    expect(new Set(hashOwners)).toEqual(new Set(['utils/contentHash.ts']));
  });
});
