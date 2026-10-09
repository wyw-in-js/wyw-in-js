import type { StrictOptions } from '@wyw-in-js/shared';
import type { RawSourceMap } from 'source-map';

import type { EventEmitter } from '../EventEmitter';
import type { WYWTransformMetadata } from '../TransformMetadata';

export type OxcCollectOptions = Pick<
  StrictOptions,
  | 'classNameSlug'
  | 'displayName'
  | 'eval'
  | 'extensions'
  | 'processors'
  | 'tagResolver'
  | 'variableNameConfig'
> & {
  eventEmitter?: EventEmitter;
  preserveSideEffectImportOrderLocals?: Set<string>;
  preserveSideEffectImportLocals?: Set<string>;
};

export type OxcCollectResult = {
  code: string;
  map: RawSourceMap;
  metadata: WYWTransformMetadata | null;
};
