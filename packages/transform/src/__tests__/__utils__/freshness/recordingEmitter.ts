import { EventEmitter } from '../../../utils/EventEmitter';

export interface RecordingSink {
  /** An entrypoint was created for `filename`. */
  created(seqId: number, filename: string): void;
  /** The eval runner received the code of `filename` to execute. */
  evaluated(filename: string): void;
  /** The entrypoint published a freshly prepared (shaken) module. */
  prepared(seqId: number): void;
}

export interface EvalGate {
  /** Called once the transform reaches its evaluation stage. */
  reached(): void;
  /** Resolves when the transform may evaluate. */
  released: Promise<void>;
}

/**
 * Public `EventEmitter` hooks turned into recomputation records. It can also
 * hold the transform it is passed to right before the evaluation stage.
 */
export class RecordingEmitter extends EventEmitter {
  private evalGate: EvalGate | undefined;

  constructor(sink: RecordingSink, evalGate?: EvalGate) {
    super(
      (labels, type) => {
        if (
          type === 'single' &&
          labels.type === 'eval-file' &&
          labels.payloadKind === 'code' &&
          typeof labels.id === 'string'
        ) {
          sink.evaluated(labels.id);
        }
      },
      () => 0,
      (seqId, _timestamp, event) => {
        if (event.type === 'created') sink.created(seqId, event.filename);
        else if (event.type === 'setTransformResult') sink.prepared(seqId);
      }
    );
    this.evalGate = evalGate;
  }

  public perf<TRes>(method: string, fn: () => TRes): TRes {
    const gate = this.evalGate;
    if (method !== 'transform:evalFile' || !gate) {
      return super.perf(method, fn);
    }

    this.evalGate = undefined;
    gate.reached();
    return gate.released.then(() => super.perf(method, fn)) as TRes;
  }
}
