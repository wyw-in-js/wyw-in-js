import type { Result } from '../types';
import type { TransformWorkerJob, TransformWorkerPool } from './pool';

/**
 * Transforms of one adapter scope. Every worker keeps a separate cache for
 * each scope, so the methods below apply to all workers.
 */
export class TransformWorkerScope {
  public constructor(
    private readonly pool: TransformWorkerPool,
    private readonly scopeId: number
  ) {}

  public transform(job: TransformWorkerJob): Promise<Result> {
    return this.pool.runJob(this.scopeId, job);
  }

  public invalidateForFile(filename: string): void {
    this.pool.notifyScope({
      filename,
      scopeId: this.scopeId,
      type: 'invalidate',
    });
  }

  public clear(): void {
    this.pool.notifyScope({ scopeId: this.scopeId, type: 'clear' });
  }

  public disposeEvalBroker(): void {
    this.pool.notifyScope({ scopeId: this.scopeId, type: 'disposeEvalBroker' });
  }

  public dispose(): void {
    this.pool.notifyScope({ scopeId: this.scopeId, type: 'disposeScope' });
  }
}
