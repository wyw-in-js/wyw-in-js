import { hashContent } from '../utils/contentHash';
import type {
  CodeMeasurement,
  CodeMeasurementBucket,
  CodeMeasurementEntry,
  PipelineAccumulator,
} from './pipelineTelemetry.types';

// Measurements are kept for one root. A reporter spans an entire build, where
// the same revisions are observed from many roots: across roots they come
// from the content hash memo, which the reporter keeps alive while registered.

export type CompletedCodeMeasurement = CodeMeasurement & {
  revision: string;
};

const codeMeasurementKey = (code: string): number => {
  const { length } = code;
  if (length === 0) return 0;

  let key = length;
  key = (key * 33 + code.charCodeAt(0)) % 2_147_483_647;
  key = (key * 33 + code.charCodeAt(Math.floor(length / 2))) % 2_147_483_647;
  return (key * 33 + code.charCodeAt(length - 1)) % 2_147_483_647;
};

const findCodeMeasurement = (
  entries: Map<number, CodeMeasurementBucket>,
  key: number,
  code: string
): CodeMeasurementEntry | undefined => {
  const bucket = entries.get(key);
  if (!bucket) return undefined;
  if (!Array.isArray(bucket)) {
    return bucket.code === code ? bucket : undefined;
  }

  for (const entry of bucket) {
    if (entry.code === code) return entry;
  }
  return undefined;
};

const addCodeMeasurement = (
  entries: Map<number, CodeMeasurementBucket>,
  key: number,
  code: string,
  measurement: CodeMeasurement
): void => {
  const bucket = entries.get(key);
  if (!bucket) {
    entries.set(key, { code, measurement });
    return;
  }
  if (Array.isArray(bucket)) {
    const existing = bucket.find((candidate) => candidate.code === code);
    if (existing) {
      existing.measurement = measurement;
      return;
    }
    bucket.push({ code, measurement });
    return;
  }
  if (bucket.code === code) {
    bucket.measurement = measurement;
    return;
  }

  entries.set(key, [bucket, { code, measurement }]);
};

const setCodeMeasurementWithKey = <T extends CodeMeasurement>(
  accumulator: PipelineAccumulator,
  key: number,
  code: string,
  measurement: T
): T => {
  addCodeMeasurement(accumulator.localCodeMeasurements, key, code, measurement);
  accumulator.lastCode = code;
  accumulator.lastMeasurement = measurement;
  return measurement;
};

/** Keeps a measurement taken in another root as this root's measurement. */
export const setMissingCodeMeasurement = (
  accumulator: PipelineAccumulator,
  code: string,
  measurement: CompletedCodeMeasurement
): CompletedCodeMeasurement =>
  setCodeMeasurementWithKey(
    accumulator,
    codeMeasurementKey(code),
    code,
    measurement
  );

export const getCodeMeasurement = (
  accumulator: PipelineAccumulator,
  code: string
): CompletedCodeMeasurement | undefined => {
  if (accumulator.lastCode === code && accumulator.lastMeasurement?.revision) {
    return accumulator.lastMeasurement as CompletedCodeMeasurement;
  }
  const local = findCodeMeasurement(
    accumulator.localCodeMeasurements,
    codeMeasurementKey(code),
    code
  );
  if (!local?.measurement.revision) {
    return undefined;
  }

  accumulator.lastCode = code;
  accumulator.lastMeasurement = local.measurement;
  return local.measurement as CompletedCodeMeasurement;
};

export const measureCode = (
  accumulator: PipelineAccumulator,
  code: string
): CompletedCodeMeasurement => {
  if (accumulator.lastCode === code && accumulator.lastMeasurement?.revision) {
    return accumulator.lastMeasurement as CompletedCodeMeasurement;
  }
  const key = codeMeasurementKey(code);
  const local = findCodeMeasurement(
    accumulator.localCodeMeasurements,
    key,
    code
  );
  if (local?.measurement.revision) {
    accumulator.lastCode = code;
    accumulator.lastMeasurement = local.measurement;
    return local.measurement as CompletedCodeMeasurement;
  }

  return setCodeMeasurementWithKey(accumulator, key, code, {
    bytes: local?.measurement.bytes ?? Buffer.byteLength(code),
    revision: Buffer.from(hashContent(code), 'hex').toString('base64url'),
  });
};

export const measureBytes = (
  accumulator: PipelineAccumulator,
  code: string
): number => {
  if (accumulator.lastCode === code && accumulator.lastMeasurement) {
    return accumulator.lastMeasurement.bytes;
  }
  const key = codeMeasurementKey(code);
  const local = findCodeMeasurement(
    accumulator.localCodeMeasurements,
    key,
    code
  );
  if (local) {
    accumulator.lastCode = code;
    accumulator.lastMeasurement = local.measurement;
    return local.measurement.bytes;
  }

  return setCodeMeasurementWithKey(accumulator, key, code, {
    bytes: Buffer.byteLength(code),
  }).bytes;
};
