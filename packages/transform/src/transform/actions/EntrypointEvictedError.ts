import type { Entrypoint } from '../Entrypoint';
import { AbortError } from './AbortError';

/** A publication was removed without replacing the entrypoint's lineage. */
export class EntrypointEvictedError extends AbortError {
  constructor(public readonly entrypoint: Entrypoint) {
    super('superseded');
  }
}
