import type { TransformCacheCollection } from '../../cache';
import type { Entrypoint } from '../Entrypoint';
import type { IEvaluatedEntrypoint } from '../EvaluatedEntrypoint';

import { AbortError } from './AbortError';

// Fences poll the publication on every action step. The cache version lets
// them skip the keyed lookup while nothing in the entrypoints map changed.
export class PublicationFence {
  private publication: Entrypoint | IEvaluatedEntrypoint | undefined;

  private version = -1;

  constructor(
    private readonly cache: TransformCacheCollection,
    private readonly name: string
  ) {
    this.capture();
  }

  public capture(): void {
    this.publication = this.cache.get('entrypoints', this.name);
    this.version = this.cache.getPublicationVersion();
  }

  public assertCurrent(): void {
    const version = this.cache.getPublicationVersion();
    if (version === this.version) {
      return;
    }
    if (this.cache.get('entrypoints', this.name) !== this.publication) {
      throw new AbortError('superseded');
    }
    this.version = version;
  }
}
