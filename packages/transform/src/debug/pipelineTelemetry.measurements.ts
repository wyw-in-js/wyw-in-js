import { hashContent } from '../utils/contentHash';
import type {
  CodeMeasurement,
  CodeMeasurementBucket,
  CodeMeasurementEntry,
  PipelineAccumulator,
} from './pipelineTelemetry.types';

// A reporter spans an entire build, where the same dependency revisions are
// observed from many transform roots. Keep enough measurements to cover a
// medium-sized build without repeatedly hashing the same source, while still
// bounding debug-only retention. The code-unit limit is an explicit retention
// bound; it is not an estimate of the strings' allocated memory.
const MAX_CODE_MEASUREMENTS = 4_096;
const MAX_CACHED_CODE_UNITS = 64 * 1024;
const MAX_SHARED_CODE_UNITS = 16 * 1024 * 1024;

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
  measurement: CodeMeasurement,
  reusableEntry?: CodeMeasurementEntry
): CodeMeasurementEntry => {
  const bucket = entries.get(key);
  if (!bucket) {
    const entry = reusableEntry ?? { code, measurement };
    entries.set(key, entry);
    return entry;
  }
  if (Array.isArray(bucket)) {
    const existing = bucket.find((candidate) => candidate.code === code);
    if (existing) {
      existing.measurement = measurement;
      return existing;
    }
    const entry = reusableEntry ?? { code, measurement };
    bucket.push(entry);
    return entry;
  }
  if (bucket.code === code) {
    bucket.measurement = measurement;
    return bucket;
  }

  const entry = reusableEntry ?? { code, measurement };
  entries.set(key, [bucket, entry]);
  return entry;
};

const setCodeMeasurementWithKey = (
  accumulator: PipelineAccumulator,
  key: number,
  code: string,
  measurement: CodeMeasurement,
  cacheShared = true,
  sharedKnownMissing = false
) => {
  accumulator.lastSharedMissCode = undefined;
  const localEntry = addCodeMeasurement(
    accumulator.localCodeMeasurements,
    key,
    code,
    measurement
  );
  accumulator.lastCode = code;
  accumulator.lastMeasurement = measurement;
  if (!cacheShared) return measurement;
  if (
    code.length > MAX_CACHED_CODE_UNITS ||
    code.length > MAX_SHARED_CODE_UNITS
  ) {
    return measurement;
  }

  const { codeMeasurements } = accumulator;
  if (!sharedKnownMissing) {
    const existingShared = findCodeMeasurement(
      codeMeasurements.entries,
      key,
      code
    );
    if (existingShared) {
      existingShared.measurement = measurement;
      return measurement;
    }
  }
  while (
    codeMeasurements.count >= MAX_CODE_MEASUREMENTS ||
    codeMeasurements.codeUnits + code.length > MAX_SHARED_CODE_UNITS
  ) {
    let oldestResult = codeMeasurements.evictionKeys.next();
    if (oldestResult.done) {
      codeMeasurements.evictionKeys = codeMeasurements.entries.keys();
      oldestResult = codeMeasurements.evictionKeys.next();
    }
    if (oldestResult.done) break;
    const oldestKey = oldestResult.value;
    const oldestBucket = codeMeasurements.entries.get(oldestKey);
    codeMeasurements.entries.delete(oldestKey);
    if (oldestBucket) {
      if (!Array.isArray(oldestBucket)) {
        codeMeasurements.codeUnits -= oldestBucket.code.length;
        codeMeasurements.count -= 1;
      } else {
        codeMeasurements.count -= oldestBucket.length;
        for (const entry of oldestBucket) {
          codeMeasurements.codeUnits -= entry.code.length;
        }
      }
    }
  }
  codeMeasurements.codeUnits += code.length;
  codeMeasurements.count += 1;
  addCodeMeasurement(
    codeMeasurements.entries,
    key,
    code,
    measurement,
    localEntry
  );
  return measurement;
};

export function setCodeMeasurement(
  accumulator: PipelineAccumulator,
  code: string,
  measurement: CompletedCodeMeasurement,
  cacheShared?: boolean
): CompletedCodeMeasurement;
export function setCodeMeasurement(
  accumulator: PipelineAccumulator,
  code: string,
  measurement: CodeMeasurement,
  cacheShared?: boolean
): CodeMeasurement;
export function setCodeMeasurement(
  accumulator: PipelineAccumulator,
  code: string,
  measurement: CodeMeasurement,
  cacheShared = true
): CodeMeasurement {
  return setCodeMeasurementWithKey(
    accumulator,
    codeMeasurementKey(code),
    code,
    measurement,
    cacheShared
  );
}

export const setMissingCodeMeasurement = (
  accumulator: PipelineAccumulator,
  code: string,
  measurement: CompletedCodeMeasurement
): CompletedCodeMeasurement => {
  const sharedKnownMissing = accumulator.lastSharedMissCode === code;
  return setCodeMeasurementWithKey(
    accumulator,
    codeMeasurementKey(code),
    code,
    measurement,
    true,
    sharedKnownMissing
  ) as CompletedCodeMeasurement;
};

export const getCodeMeasurement = (
  accumulator: PipelineAccumulator,
  code: string
): CompletedCodeMeasurement | undefined => {
  accumulator.lastSharedMissCode = undefined;
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

  const shared = findCodeMeasurement(
    accumulator.codeMeasurements.entries,
    key,
    code
  );
  if (!shared?.measurement.revision) {
    if (shared) {
      accumulator.lastCode = code;
      accumulator.lastMeasurement = shared.measurement;
    } else {
      accumulator.lastSharedMissCode = code;
    }
    return undefined;
  }
  addCodeMeasurement(
    accumulator.localCodeMeasurements,
    key,
    code,
    shared.measurement,
    shared
  );
  accumulator.lastCode = code;
  accumulator.lastMeasurement = shared.measurement;
  return shared.measurement as CompletedCodeMeasurement;
};

export const measureCode = (
  accumulator: PipelineAccumulator,
  code: string,
  cacheShared = true
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

  const shared = findCodeMeasurement(
    accumulator.codeMeasurements.entries,
    key,
    code
  );
  if (shared?.measurement.revision) {
    addCodeMeasurement(
      accumulator.localCodeMeasurements,
      key,
      code,
      shared.measurement,
      shared
    );
    accumulator.lastCode = code;
    accumulator.lastMeasurement = shared.measurement;
    return shared.measurement as CompletedCodeMeasurement;
  }

  const measurement = {
    bytes: local?.measurement.bytes ?? Buffer.byteLength(code),
    revision: Buffer.from(hashContent(code), 'hex').toString('base64url'),
  };
  setCodeMeasurementWithKey(
    accumulator,
    key,
    code,
    measurement,
    cacheShared,
    shared === undefined
  );
  return measurement;
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

  const shared = findCodeMeasurement(
    accumulator.codeMeasurements.entries,
    key,
    code
  );
  if (shared) {
    addCodeMeasurement(
      accumulator.localCodeMeasurements,
      key,
      code,
      shared.measurement,
      shared
    );
    accumulator.lastCode = code;
    accumulator.lastMeasurement = shared.measurement;
    return shared.measurement.bytes;
  }

  return setCodeMeasurementWithKey(
    accumulator,
    key,
    code,
    { bytes: Buffer.byteLength(code) },
    false
  ).bytes;
};
