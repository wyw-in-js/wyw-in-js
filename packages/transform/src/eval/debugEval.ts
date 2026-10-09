import fs from 'fs';
import path from 'path';

import type {
  NativeResolveRequest,
  ResolveTrace,
  ResolveTraceEvent,
} from '../resolve/resolvePolicy';
import { stripQueryAndHash } from '../utils/parseRequest';
import type { DebugEvalFileValues } from './protocol';
import type { SerializedValue } from './serialize';

export type DebugEvalValueStatus =
  | 'mixed'
  | 'none'
  | 'serialized'
  | 'stringified';

const resolveDebugEvalDir = (): string | undefined => {
  const override = process.env.WYW_DUMP_EVALS_DIR;
  if (override) {
    return path.resolve(override);
  }

  const base = process.env.WYW_DUMP_EVALS;
  if (!base) {
    return undefined;
  }

  const ts = new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[-:T]/g, (character) => (character === 'T' ? '-' : ''));
  const root = base === '1' || base === 'true' ? './tmp' : base;
  return path.resolve(root, `wyw-dump-evals-${ts}`);
};

const debugEvalDir = resolveDebugEvalDir();
let debugEvalDirReady = false;

export const debugEvalEnabled = debugEvalDir !== undefined;

export const toBase64 = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64');

export const toJsonBase64 = (value: unknown): string =>
  toBase64(JSON.stringify(value));

export const serializedExportsToDebugValues = (
  serializedExports: Record<string, SerializedValue>
): DebugEvalFileValues => ({
  exports: Object.fromEntries(
    Object.entries(serializedExports).map(([key, serialized]) => [
      key,
      {
        serialized,
        status: 'serialized' as const,
      },
    ])
  ),
});

export const getDebugValuesStatus = (
  values: DebugEvalFileValues | undefined
): DebugEvalValueStatus => {
  const statuses = [
    ...Object.values(values?.exports ?? {}),
    ...Object.values(values?.preval ?? {}),
  ].map((value) => value.status);

  if (statuses.length === 0) {
    return 'none';
  }

  const hasSerialized = statuses.includes('serialized');
  const hasStringified = statuses.includes('stringified');
  if (hasSerialized && hasStringified) {
    return 'mixed';
  }

  return hasStringified ? 'stringified' : 'serialized';
};

const ensureDebugEvalDir = () => {
  if (!debugEvalDir || debugEvalDirReady) {
    return;
  }
  fs.mkdirSync(debugEvalDir, { recursive: true });
  debugEvalDirReady = true;
};

let debugEvalSeq = 0;

export const dumpEvalCode = (
  id: string,
  code: string,
  only: string[],
  source: string,
  evalSeq: number
) => {
  if (!debugEvalDir) {
    return;
  }
  ensureDebugEvalDir();
  debugEvalSeq += 1;
  const seq = String(debugEvalSeq).padStart(5, '0');
  const evalSequence = String(evalSeq).padStart(5, '0');
  const relativeId = path.relative(process.cwd(), stripQueryAndHash(id));
  const safeName = relativeId.replace(/[/\\]/g, '__').replace(/^__/, '');
  const filename = `seq${seq}_eval${evalSequence}_${safeName}.js`;
  const header = [
    `// id: ${id}`,
    `// only: ${JSON.stringify(only)}`,
    `// source: ${source}`,
    `// seq: ${seq}`,
    `// eval: #${evalSequence}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(debugEvalDir, filename), header + code);
};

let debugActionStream: fs.WriteStream | null = null;

export const debugAction = (event: Record<string, unknown>) => {
  if (!debugEvalDir) {
    return;
  }
  ensureDebugEvalDir();
  if (!debugActionStream) {
    debugActionStream = fs.createWriteStream(
      path.join(debugEvalDir, 'actions.jsonl')
    );
  }
  debugActionStream.write(`${JSON.stringify(event)}\n`);
};

export const flushDebugStreams = () => {
  debugActionStream?.end();
  debugActionStream = null;
};

const logEvalResolveTrace = (
  { importer: importerId, kind, specifier }: NativeResolveRequest,
  event: ResolveTraceEvent
) => {
  /* eslint-disable no-console */
  switch (event.step) {
    case 'custom':
      console.warn('[wyw-eval:resolve:custom]', {
        specifier,
        importerId,
        resolved: event.id,
        normalized: event.normalized,
        external: event.external,
      });
      return;
    case 'native':
    case 'native-fallback':
      console.warn(`[wyw-eval:resolve:${event.step}]`, {
        specifier,
        importerId,
        resolved: event.id,
      });
      return;
    case 'native-miss':
      console.warn('[wyw-eval:resolve:native-miss]', {
        specifier,
        importerId,
        kind,
        error: event.error,
      });
      return;
    case 'normalize-miss':
      console.warn('[wyw-eval:resolve:native-normalize-miss]', {
        specifier,
        importerId,
        kind,
        error: event.error,
      });
      return;
    case 'bundler':
      console.warn('[wyw-eval:resolve:async]', {
        specifier,
        importerId,
        resolved: event.id,
        normalized: event.normalized,
      });
      return;
    default:
      console.warn('[wyw-eval:resolve:none]', { specifier, importerId });
  }
  /* eslint-enable no-console */
};

/** `WYW_DEBUG_EVAL_RESOLVE` logs every step of the eval resolve policy. */
export const getEvalResolveTrace = (): ResolveTrace | undefined =>
  process.env.WYW_DEBUG_EVAL_RESOLVE ? logEvalResolveTrace : undefined;
