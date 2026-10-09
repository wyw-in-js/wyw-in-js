import { TransformCacheCollection } from '../../../cache';
import type { Entrypoint } from '../../Entrypoint';
import { AbortError } from '../AbortError';
import { EntrypointEvictedError } from '../EntrypointEvictedError';
import { PublicationFence } from '../PublicationFence';

const filename = '/project/entry.ts';

const createPublication = (generation: number) =>
  ({
    dependencies: new Map(),
    evaluated: false,
    generation,
    invalidationDependencies: new Map(),
    name: filename,
  }) as unknown as Entrypoint;

describe('PublicationFence', () => {
  it('reports a removed publication as an eviction of the captured entrypoint', () => {
    const cache = new TransformCacheCollection();
    const publication = createPublication(1);
    cache.add('entrypoints', filename, publication);
    const fence = new PublicationFence(cache, filename);

    cache.invalidateForFile(filename);

    let caught: unknown;
    try {
      fence.assertCurrent();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EntrypointEvictedError);
    expect((caught as EntrypointEvictedError).entrypoint).toBe(publication);
  });

  it('keeps a replaced publication a plain supersede', () => {
    const cache = new TransformCacheCollection();
    cache.add('entrypoints', filename, createPublication(1));
    const fence = new PublicationFence(cache, filename);

    cache.add('entrypoints', filename, createPublication(2));

    let caught: unknown;
    try {
      fence.assertCurrent();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AbortError);
    expect(caught).not.toBeInstanceOf(EntrypointEvictedError);
  });

  it('accepts an unchanged publication', () => {
    const cache = new TransformCacheCollection();
    cache.add('entrypoints', filename, createPublication(1));
    const fence = new PublicationFence(cache, filename);

    cache.add('entrypoints', '/project/other.ts', createPublication(1));

    expect(() => fence.assertCurrent()).not.toThrow();
  });
});
