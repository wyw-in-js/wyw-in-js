import fs, { type BigIntStats, type Stats } from 'node:fs';

export interface FileStat {
  mtimeMs: number;
  fingerprint: string | null;
}

// Nanosecond timestamps distinguish writes within one millisecond. Keep
// compatibility with partial stats returned by mocks or exotic filesystems.
export const toFileStat = (stats: Stats | BigIntStats): FileStat => {
  const mtimeMs = Number(stats.mtimeMs);
  if ('mtimeNs' in stats) {
    return {
      mtimeMs,
      fingerprint: `${stats.mtimeNs}\0${stats.ctimeNs}\0${stats.size}\0${stats.ino}`,
    };
  }

  return {
    mtimeMs,
    fingerprint:
      Number.isFinite(stats.ctimeMs) &&
      Number.isFinite(stats.size) &&
      Number.isFinite(stats.ino)
        ? `${stats.mtimeMs}\0${stats.ctimeMs}\0${stats.size}\0${stats.ino}`
        : null,
  };
};

export const readFileStat = (filename: string): FileStat =>
  toFileStat(fs.statSync(filename, { bigint: true }));

export const isFileStatUnchanged = (
  current: FileStat,
  cached: FileStat | undefined
): boolean =>
  cached !== undefined &&
  current.mtimeMs === cached.mtimeMs &&
  (cached.fingerprint === null || current.fingerprint === cached.fingerprint);
