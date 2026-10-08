import type { Debugger } from '@wyw-in-js/shared';

import { BaseEntrypoint } from './BaseEntrypoint';
import type {
  IEntrypointCode,
  IIgnoredEntrypoint,
  IEntrypointDependency,
  IPreevalResult,
  TransformResultCode,
} from './Entrypoint.types';
import type { ParentEntrypoint } from '../types';

export interface IEvaluatedEntrypoint extends ParentEntrypoint {
  dependencies: Map<string, IEntrypointDependency>;
  evaluated: true;
  evaluatedOnly: string[];
  exports: Record<string | symbol, unknown>;
  generation: number;
  hasTransformResult: boolean;
  hasWywMetadata: boolean;
  ignored: false;
  initialCode?: string;
  invalidationDependencies: Map<string, IEntrypointDependency>;
  invalidateOnDependencyChange: Set<string>;
  loadedAndParsed?: IEntrypointCode | IIgnoredEntrypoint;
  log: Debugger;
  only: string[];
  preevalResult: IPreevalResult | null;
  /** Transform output shared without reading its code; see `transformResultCode`. */
  transformResult?: TransformResultCode | null;
  transformResultCode: string | null;
}

export class EvaluatedEntrypoint
  extends BaseEntrypoint
  implements IEvaluatedEntrypoint
{
  public readonly evaluated = true;

  public readonly ignored = false;

  public hasTransformResult = false;

  public hasWywMetadata = false;

  public initialCode?: string;

  public loadedAndParsed?: IEntrypointCode | IIgnoredEntrypoint;

  public preevalResult: IPreevalResult | null = null;

  public transformResult: TransformResultCode | null = null;

  public get transformResultCode(): string | null {
    return this.transformResult?.code ?? null;
  }

  public set transformResultCode(code: string | null) {
    this.transformResult = code === null ? null : { code };
  }
}
