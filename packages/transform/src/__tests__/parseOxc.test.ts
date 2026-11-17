/* eslint-env jest */
import {
  isOxcRawTransferAstTypeCompatible,
  MAX_PARSE_CACHE_ENTRIES,
  MAX_PARSE_CACHE_ENTRIES_PER_FILE,
  parseOxcCached,
  parseOxcFragmentProgramCached,
  setParseCacheLimit,
} from '../utils/parseOxc';

describe('parseOxcCached', () => {
  it.each([
    {
      acceptedFilename: '/project/jsx-first.tsx',
      code: 'const jsxFirst = <div />;',
      rejectedFilename: '/project/jsx-first.ts',
    },
    {
      acceptedFilename: '/project/type-assertion-first.ts',
      code: 'const typeAssertionFirst = <number>1;',
      rejectedFilename: '/project/type-assertion-first.tsx',
    },
    {
      acceptedFilename: '/project/declaration-first.d.ts',
      code: 'const declarationFirst: string;',
      rejectedFilename: '/project/declaration-first.ts',
    },
    {
      acceptedFilename: '/project/runtime-first.ts',
      code: 'let runtimeFirst = 1;',
      rejectedFilename: '/project/runtime-first.d.ts',
    },
    {
      acceptedFilename: '/project/js-fallback-first.js',
      code: 'const jsFallbackFirst = <div />;',
      rejectedFilename: '/project/js-fallback-first.mjs',
    },
  ])(
    'keeps the grammar for $acceptedFilename separate from $rejectedFilename',
    ({ acceptedFilename, code, rejectedFilename }) => {
      expect(() =>
        parseOxcCached(acceptedFilename, code, 'module')
      ).not.toThrow();
      expect(() => parseOxcCached(rejectedFilename, code, 'module')).toThrow();
    }
  );

  it('keeps no more entries than the configured limit', () => {
    const parse = (name: string) =>
      parseOxcCached(
        '/project/limit.ts',
        `export const ${name} = 1;`,
        'module'
      );
    const kept = parse('keptEntry');
    expect(parse('keptEntry')).toBe(kept);

    setParseCacheLimit(2);
    try {
      const evicted = parse('evictedEntry');
      parse('secondEntry');
      parse('thirdEntry');
      expect(parse('evictedEntry')).not.toBe(evicted);
    } finally {
      setParseCacheLimit(MAX_PARSE_CACHE_ENTRIES);
    }
  });

  it('shares entries across filenames with equivalent parser semantics', () => {
    const code = 'export const sharedDialectEntry: number = 1;';
    const first = parseOxcCached('/project/first-shared.ts', code, 'module');
    const second = parseOxcCached('/project/second-shared.ts', code, 'module');

    expect(second).toBe(first);
  });

  it('shares the AST but not cache-entry identity across source types', () => {
    const code = 'export const sharedSourceTypeEntry: number = 1;';
    const moduleEntry = parseOxcCached(
      '/project/shared-source-type.ts',
      code,
      'module'
    );
    const unambiguousEntry = parseOxcCached(
      '/project/shared-source-type.ts',
      code,
      'unambiguous'
    );

    expect(unambiguousEntry).not.toBe(moduleEntry);
    expect(unambiguousEntry.program).toBe(moduleEntry.program);
  });
});

describe('parse cache entries per file', () => {
  const versionOf = (file: string, version: string) =>
    `export const ${file}_${version} = 1;`;

  it('keeps a bounded number of versions of one file', () => {
    const parse = (version: number) =>
      parseOxcCached(
        '/project/versions.ts',
        versionOf('versions', `v${version}`),
        'module'
      );

    expect(MAX_PARSE_CACHE_ENTRIES_PER_FILE).toBe(16);
    const first = parse(1);
    const second = parse(2);
    for (let version = 3; version <= 17; version += 1) {
      parse(version);
    }

    expect(parse(2)).toBe(second);
    expect(parse(1)).not.toBe(first);
  });

  it('does not count code that another file only read against that file', () => {
    const shared = versionOf('readByOther', 'shared');
    const stored = parseOxcCached('/project/stored-by.ts', shared, 'module');
    expect(parseOxcCached('/project/read-by.ts', shared, 'module')).toBe(
      stored
    );

    for (let version = 1; version <= 17; version += 1) {
      parseOxcCached(
        '/project/read-by.ts',
        versionOf('readBy', `v${version}`),
        'module'
      );
    }

    expect(parseOxcCached('/project/read-by.ts', shared, 'module')).toBe(
      stored
    );
  });

  it('refreshes code in the index of the file that stored it when another file reads it', () => {
    const owner = '/project/owner.ts';
    const shared = versionOf('refreshedByRead', 'shared');
    const stored = parseOxcCached(owner, shared, 'module');
    for (let version = 1; version <= 15; version += 1) {
      parseOxcCached(owner, versionOf('ownerBefore', `v${version}`), 'module');
    }

    expect(parseOxcCached('/project/reader.ts', shared, 'module')).toBe(stored);
    for (let version = 1; version <= 15; version += 1) {
      parseOxcCached(owner, versionOf('ownerAfter', `v${version}`), 'module');
    }

    expect(parseOxcCached(owner, shared, 'module')).toBe(stored);
  });

  it('does not count static expression fragments against the file', () => {
    const filename = '/project/fragments.ts';
    const fileCode = versionOf('fragmentsFile', 'only');
    const stored = parseOxcCached(filename, fileCode, 'module');
    const fragment = (index: number) =>
      parseOxcFragmentProgramCached(
        filename,
        `const __wyw_static_value = "fragment-${index}";`,
        'unambiguous'
      );

    const firstFragment = fragment(0);
    for (let index = 1; index <= 20; index += 1) {
      fragment(index);
    }

    expect(parseOxcCached(filename, fileCode, 'module')).toBe(stored);
    expect(fragment(0)).toBe(firstFragment);
  });

  it('counts versions of a file under one name whatever its query', () => {
    const parse = (version: number) =>
      parseOxcCached(
        `/project/query.ts?v=${version}`,
        versionOf('query', `v${version}`),
        'module'
      );

    const first = parse(1);
    for (let version = 2; version <= 17; version += 1) {
      parse(version);
    }

    expect(parse(1)).not.toBe(first);
  });
});

describe('raw-transfer compatibility', () => {
  it.each([
    ['js', 'js', true],
    ['jsx', 'js', true],
    ['ts', 'ts', true],
    ['tsx', 'ts', true],
    ['dts', 'ts', true],
    ['ts', 'js', false],
    ['tsx', 'js', false],
    ['dts', 'js', false],
    ['js', 'ts', false],
  ] as const)(
    'classifies language %s with AST type %s',
    (language, astType, expected) => {
      expect(isOxcRawTransferAstTypeCompatible(language, astType)).toBe(
        expected
      );
    }
  );

  it('allows Oxc to select the default AST type', () => {
    expect(isOxcRawTransferAstTypeCompatible('ts', undefined)).toBe(true);
  });
});
