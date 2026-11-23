/* eslint-disable no-await-in-loop, no-void */
import { invariant } from 'ts-invariant';

import type { WriteQueue } from '@wyw-in-js/shared';

import type {
  EvalBrokerMirrorSnapshot,
  EvalLoadTransmission,
  EvalTelemetryToken,
} from '../debug/evalTelemetry';

import type { LoadResultPayload, MainToRunnerMessage } from './protocol';

export const EVAL_MAX_MESSAGE_SIZE = 10 * 1024 * 1024;
const EVAL_MAX_CHUNK_SIZE = 512 * 1024;

export type BrokerMirrorEntry = {
  codeBytes?: number;
  hash: string;
  only: string[];
};

// Existing shipped-code dedup treats an empty `only` like wildcard coverage.
// Keep this compatibility rule separate from the runner's actual storage
// classifier so telemetry never presents it as runner state.
export const hasSameBrokerStorageShape = (
  left: string[] | undefined | null,
  right: string[] | undefined | null
): boolean => {
  const isWildcard = (only: string[] | undefined | null): boolean =>
    !only || only.length === 0 || (only.length === 1 && only[0] === '*');
  return isWildcard(left) === isWildcard(right);
};

export const getRunnerStorage = (
  only: string[] | undefined | null
): 'primary' | 'variant' =>
  !only || (only.length === 1 && only[0] === '*') ? 'primary' : 'variant';

export const hasSameRunnerStorageShape = (
  left: string[] | undefined | null,
  right: string[] | undefined | null
): boolean => getRunnerStorage(left) === getRunnerStorage(right);

export type LoadTransmissionTelemetry = {
  details: Omit<EvalLoadTransmission, 'chunks' | 'wireBytes' | 'wireMessages'>;
  token: EvalTelemetryToken;
};

export class BrokerLoadMirror {
  private readonly entries = new Map<string, BrokerMirrorEntry>();

  private cachedSnapshot: EvalBrokerMirrorSnapshot | null = null;

  public clear(): void {
    this.entries.clear();
    if (!this.cachedSnapshot) return;
    this.cachedSnapshot = {
      entries: 0,
      knownCodeBytes: 0,
      unknownByteEntries: 0,
    };
  }

  public delete(id: string): void {
    const previous = this.entries.get(id);
    if (!previous || !this.entries.delete(id)) return;
    if (!this.cachedSnapshot) return;

    this.cachedSnapshot.entries = this.entries.size;
    if (previous.codeBytes === undefined) {
      this.cachedSnapshot.unknownByteEntries -= 1;
    } else {
      this.cachedSnapshot.knownCodeBytes -= previous.codeBytes;
    }
  }

  public get(id: string): BrokerMirrorEntry | undefined {
    return this.entries.get(id);
  }

  public set(id: string, entry: BrokerMirrorEntry): void {
    const previous = this.entries.get(id);
    this.entries.set(id, entry);
    if (!this.cachedSnapshot) return;

    if (previous) {
      if (previous.codeBytes === undefined) {
        this.cachedSnapshot.unknownByteEntries -= 1;
      } else {
        this.cachedSnapshot.knownCodeBytes -= previous.codeBytes;
      }
    }
    if (entry.codeBytes === undefined) {
      this.cachedSnapshot.unknownByteEntries += 1;
    } else {
      this.cachedSnapshot.knownCodeBytes += entry.codeBytes;
    }
    this.cachedSnapshot.entries = this.entries.size;
  }

  public snapshot(): EvalBrokerMirrorSnapshot {
    if (!this.cachedSnapshot) {
      let knownCodeBytes = 0;
      let unknownByteEntries = 0;
      this.entries.forEach((entry) => {
        if (entry.codeBytes === undefined) unknownByteEntries += 1;
        else knownCodeBytes += entry.codeBytes;
      });
      this.cachedSnapshot = {
        entries: this.entries.size,
        knownCodeBytes,
        unknownByteEntries,
      };
    }

    return { ...this.cachedSnapshot };
  }
}

export const createLoadTransmissionTelemetry = ({
  code,
  codeBytes,
  hash,
  hasSerializedExports,
  previouslySent,
  resetModule,
  sameStorageShape,
  shouldShipCode,
  token,
}: {
  code: string;
  codeBytes: number | undefined;
  hash: string | undefined;
  hasSerializedExports: boolean;
  previouslySent: BrokerMirrorEntry | undefined;
  resetModule: boolean;
  sameStorageShape: boolean;
  shouldShipCode: boolean;
  token: EvalTelemetryToken;
}): LoadTransmissionTelemetry => {
  let mode: EvalLoadTransmission['mode'];
  let resendReason: EvalLoadTransmission['resendReason'];
  if (hasSerializedExports) {
    mode = 'serialized-exports';
  } else if (!shouldShipCode) {
    mode = 'omission';
  } else if (!previouslySent) {
    mode = 'initial';
  } else if (resetModule) {
    mode = 'resend';
    resendReason = 'invalidation';
  } else {
    mode = 'resend';
    if (previouslySent.hash !== hash) {
      resendReason = 'hash-change';
    } else if (!sameStorageShape) {
      resendReason = 'storage-shape-change';
    } else {
      resendReason = 'only-widening';
    }
  }

  return {
    details: {
      ...(shouldShipCode ? { code, codeBytes } : {}),
      mode,
      ...(resendReason ? { resendReason } : {}),
    },
    token,
  };
};

type SendMessage = (
  message: MainToRunnerMessage,
  onSerialized?: (bytes: number) => void
) => Promise<void>;

export const sendEvalMessage = (
  queue: WriteQueue | null,
  message: MainToRunnerMessage,
  onSerialized?: (bytes: number) => void
): Promise<void> => {
  const payload = `${JSON.stringify(message)}\n`;
  invariant(payload.length < EVAL_MAX_MESSAGE_SIZE, 'Message too large');

  if (!queue) {
    return Promise.reject(new Error('Eval runner is not ready'));
  }

  const written = queue.write(payload);
  if (!onSerialized) return written;
  return written.then(() => {
    try {
      onSerialized(Buffer.byteLength(payload));
    } catch {
      // Debug accounting must not change transport behavior.
    }
  });
};

export const sendEvalLoadResult = async (
  id: string,
  payload: Omit<LoadResultPayload, 'chunkIndex' | 'chunkCount' | 'codeChunk'>,
  telemetry: LoadTransmissionTelemetry | undefined,
  sendMessage: SendMessage
): Promise<void> => {
  let wireBytes = 0;
  let wireMessages = 0;
  let successfulChunkCodeBytes = 0;
  let chunked = false;
  const recordWirePayload = telemetry
    ? (bytes: number) => {
        wireBytes += bytes;
        wireMessages += 1;
      }
    : undefined;
  const finishTelemetry = telemetry
    ? (chunks: number, incomplete = false) => {
        if (incomplete) {
          const { code, ...detailsWithoutCode } = telemetry.details;
          void code;
          telemetry.token.recordLoadTransmission({
            ...detailsWithoutCode,
            chunks,
            codeBytes: successfulChunkCodeBytes,
            incomplete: true,
            logicalResults: 0,
            moduleReset: payload.resetModule === true,
            wireBytes,
            wireMessages,
          });
          return;
        }

        telemetry.token.recordLoadTransmission({
          ...telemetry.details,
          chunks,
          moduleReset: payload.resetModule === true,
          wireBytes,
          wireMessages,
        });
      }
    : undefined;

  try {
    if (!payload.code) {
      await sendMessage(
        {
          type: 'LOAD_RESULT',
          id,
          payload,
        },
        recordWirePayload
      );
      finishTelemetry?.(0);
      return;
    }

    const message: MainToRunnerMessage = {
      type: 'LOAD_RESULT',
      id,
      payload,
    };
    const serialized = JSON.stringify(message);
    if (serialized.length < EVAL_MAX_MESSAGE_SIZE) {
      await sendMessage(message, recordWirePayload);
      finishTelemetry?.(0);
      return;
    }

    chunked = true;
    const { code } = payload;
    const chunkCount = Math.ceil(code.length / EVAL_MAX_CHUNK_SIZE);
    for (let index = 0; index < chunkCount; index += 1) {
      const start = index * EVAL_MAX_CHUNK_SIZE;
      const end = start + EVAL_MAX_CHUNK_SIZE;
      const codeChunk = code.slice(start, end);
      const chunkPayload: LoadResultPayload = {
        id: payload.id,
        codeChunk,
        chunkIndex: index,
        chunkCount,
      };

      if (index === 0) {
        chunkPayload.map = payload.map;
        chunkPayload.hash = payload.hash;
        chunkPayload.only = payload.only;
        chunkPayload.exports = payload.exports;
        chunkPayload.resetModule = payload.resetModule;
        chunkPayload.error = payload.error;
      }

      await sendMessage(
        {
          type: 'LOAD_RESULT',
          id,
          payload: chunkPayload,
        },
        recordWirePayload
      );
      if (telemetry) {
        successfulChunkCodeBytes += Buffer.byteLength(codeChunk);
      }
    }
    finishTelemetry?.(chunkCount);
  } catch (error) {
    finishTelemetry?.(chunked ? wireMessages : 0, true);
    throw error;
  }
};
