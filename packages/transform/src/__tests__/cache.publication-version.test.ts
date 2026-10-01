import { TransformCacheCollection } from '../cache';

type MockEntrypoint = {
  dependencies: Map<string, { resolved: string | null }>;
  generation: number;
  name: string;
};

const entrypoint = (name: string): MockEntrypoint => ({
  dependencies: new Map(),
  generation: 1,
  name,
});

// Action fences poll their publication on every step. The version lets them
// skip the keyed lookup while nothing in the entrypoints map has changed.
describe('TransformCacheCollection: publication version', () => {
  it('moves on every write to the entrypoints map and on nothing else', () => {
    const cache = new TransformCacheCollection<MockEntrypoint>();
    const first = entrypoint('a.js');
    const second = entrypoint('a.js');
    const versions: number[] = [cache.getPublicationVersion()];
    const record = () => versions.push(cache.getPublicationVersion());

    cache.add('entrypoints', 'a.js', first);
    record();
    cache.get('entrypoints', 'a.js');
    cache.has('entrypoints', 'a.js');
    cache.add('exports', 'a.js', ['x']);
    record();
    expect(
      cache.replacePublished(
        cache.getCurrentEpoch(),
        'entrypoints',
        'a.js',
        first,
        second
      )
    ).toBe(true);
    record();
    expect(
      cache.replacePublished(
        cache.getCurrentEpoch(),
        'entrypoints',
        'a.js',
        first,
        second
      )
    ).toBe(false);
    record();
    cache.invalidate('entrypoints', 'a.js');
    record();
    cache.invalidate('entrypoints', 'a.js');
    record();
    cache.clear('entrypoints');
    record();

    expect(versions.map((v, i) => (i === 0 ? 0 : v - versions[i - 1]))).toEqual(
      [0, 1, 0, 1, 0, 1, 0, 1]
    );
  });
});
