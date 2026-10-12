import fs from 'fs';
import path from 'path';

type Realpath = (filename: string) => string;

const isUnder = (relativePath: string) =>
  relativePath !== '..' &&
  !relativePath.startsWith(`..${path.sep}`) &&
  !path.isAbsolute(relativePath);

const tryRealpath = (filename: string, realpath: Realpath) => {
  try {
    return realpath(filename);
  } catch {
    return null;
  }
};

/**
 * Creates a function that places a matched file under `sourceRoot`, so paths
 * derived from `path.relative(sourceRoot, filename)` stay inside the output
 * directories.
 *
 * `sourceRoot` is resolved without following symlinks. A relative pattern
 * matches files under the real working directory (on macOS, `/tmp` is
 * `/private/tmp`), and an absolute pattern keeps its symlinks, so the two
 * paths can name the same directory differently. When the file is not under
 * `sourceRoot` as given, the real paths of `sourceRoot` and of the file's
 * directory are compared, and a file found under the real source root gets
 * the same relative path under `sourceRoot`. The file itself is not resolved:
 * a symlinked file keeps the place of the link. Otherwise the filename is
 * returned unchanged.
 */
export function createSourceRootLocator(
  sourceRoot: string,
  realpath: Realpath = fs.realpathSync
): (filename: string) => string {
  const realSourceRoot = tryRealpath(sourceRoot, realpath);

  return (filename) => {
    if (
      realSourceRoot === null ||
      isUnder(path.relative(sourceRoot, filename))
    ) {
      return filename;
    }

    const realDirectory = tryRealpath(path.dirname(filename), realpath);
    if (realDirectory === null) {
      return filename;
    }

    const realRelativePath = path.relative(
      realSourceRoot,
      path.join(realDirectory, path.basename(filename))
    );

    return isUnder(realRelativePath)
      ? path.join(sourceRoot, realRelativePath)
      : filename;
  };
}
