import { normalizeInputSourceMap } from '../normalizeInputSourceMap';

describe('normalizeInputSourceMap', () => {
  it('drops missing and string source maps', () => {
    expect(normalizeInputSourceMap(undefined, '/a.ts')).toBeUndefined();
    expect(normalizeInputSourceMap(null, '/a.ts')).toBeUndefined();
    expect(
      normalizeInputSourceMap('{"version":3,"mappings":""}', '/a.ts')
    ).toBeUndefined();
  });

  it('fills the fields required by a raw source map', () => {
    expect(normalizeInputSourceMap({}, '/a.ts')).toEqual({
      file: '/a.ts',
      mappings: '',
      names: [],
      sources: [],
      version: 3,
    });
  });

  it('keeps provided fields and extra properties without mutating input', () => {
    const input = {
      file: 'a.js',
      mappings: 'AAAA',
      names: ['x'],
      sourceRoot: '/root',
      sources: ['a.ts'],
      sourcesContent: ['const x = 1;'],
      version: 3,
    };
    const snapshot = structuredClone(input);

    const normalized = normalizeInputSourceMap(input, '/a.ts');

    expect(normalized).toEqual(input);
    expect(normalized).not.toBe(input);
    expect(input).toEqual(snapshot);
  });
});
