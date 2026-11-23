import { LruCache } from '@wyw-in-js/shared';

describe('eval LruCache', () => {
  it('reports the exact capacity eviction without changing LRU order', () => {
    const cache = new LruCache<string, number>(2);

    const evictions: Array<{ key: string; value: number }> = [];
    cache.set('a', 1, (key, value) => evictions.push({ key, value }));
    cache.set('b', 2, (key, value) => evictions.push({ key, value }));
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3, (key, value) => evictions.push({ key, value }));
    expect(evictions).toEqual([{ key: 'b', value: 2 }]);
    expect(cache.size).toBe(2);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('does not report replacement of an existing key as eviction', () => {
    const cache = new LruCache<string, number>(1);

    cache.set('a', 1);
    const onEvict = jest.fn();
    cache.set('a', 2, onEvict);
    expect(onEvict).not.toHaveBeenCalled();
    expect(cache.get('a')).toBe(2);
    expect(cache.size).toBe(1);
  });
});
