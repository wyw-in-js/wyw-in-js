import { parseRequest, stripQueryAndHash } from '../parseRequest';

describe('stripQueryAndHash', () => {
  it.each([
    ['', ''],
    ['/src/a.ts', '/src/a.ts'],
    ['/src/a.ts?raw', '/src/a.ts'],
    ['/src/a.ts#hash', '/src/a.ts'],
    ['/src/a.ts?raw#hash', '/src/a.ts'],
    ['/src/a.ts#hash?raw', '/src/a.ts'],
    ['/src/a.ts?', '/src/a.ts'],
    ['/src/a.ts#', '/src/a.ts'],
    ['?raw', ''],
    ['C:\\src\\a.ts?v=1', 'C:\\src\\a.ts'],
    ['./a.css?__wyw_css', './a.css'],
  ])('%j -> %j', (request, expected) => {
    expect(stripQueryAndHash(request)).toBe(expected);
  });

  it('matches the split-based variant used by bundler adapters', () => {
    const requests = [
      '/a.ts',
      '/a.ts?x',
      '/a.ts#y',
      '/a.ts?x#y',
      '/a.ts#y?x',
      '/a.ts??x',
      '/a.ts##y',
      '?',
      '#',
    ];

    requests.forEach((request) => {
      expect(stripQueryAndHash(request)).toBe(
        request.split('?')[0].split('#')[0]
      );
    });
  });

  it('keeps the stripped suffix recoverable by slicing', () => {
    const request = '/a.ts?inline#frag';
    const filename = stripQueryAndHash(request);

    expect(request.slice(filename.length)).toBe('?inline#frag');
  });
});

describe('parseRequest', () => {
  it('returns the bare request when there is no suffix', () => {
    expect(parseRequest('/src/a.ts')).toEqual({
      filename: '/src/a.ts',
      hash: '',
      query: '',
    });
  });

  it('splits query and hash', () => {
    expect(parseRequest('/src/a.ts?raw&x=1#frag')).toEqual({
      filename: '/src/a.ts',
      hash: 'frag',
      query: 'raw&x=1',
    });
  });

  it('treats a question mark after the hash as part of the hash', () => {
    expect(parseRequest('/src/a.ts#frag?raw')).toEqual({
      filename: '/src/a.ts',
      hash: 'frag?raw',
      query: '',
    });
  });

  it('agrees with stripQueryAndHash on the filename', () => {
    ['/a', '/a?b', '/a#c', '/a?b#c', '/a#c?b', '?b', '#c'].forEach(
      (request) => {
        expect(parseRequest(request).filename).toBe(stripQueryAndHash(request));
      }
    );
  });
});
