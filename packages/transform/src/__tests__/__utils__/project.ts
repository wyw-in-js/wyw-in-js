import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

// A declarative test project: a plain map from a relative POSIX path to the
// content of that file. It holds data only, no test code, so the same project
// can be handed to any implementation that reads files from a directory.
export type ProjectFiles = Readonly<Record<string, string>>;

export interface Project {
  /** The real path (after `realpath`) of the temporary directory. */
  readonly root: string;
  /** The absolute path of a project file: `join(root, ...file.split('/'))`. */
  path(file: string): string;
}

export interface ProjectOptions {
  /** The prefix of the temporary directory name, `'wyw-project-'` by default. */
  prefix?: string;
}

const DEFAULT_PREFIX = 'wyw-project-';

const invalidPath = (file: string, reason: string) =>
  new Error(`Invalid project path ${JSON.stringify(file)}: ${reason}`);

const checkPath = (file: string) => {
  if (file === '') {
    throw invalidPath(file, 'the path is empty');
  }

  if (file.includes('\\')) {
    throw invalidPath(file, 'segments are separated by "/", not "\\"');
  }

  if (file.startsWith('/')) {
    throw invalidPath(file, 'the path must be relative to the project root');
  }

  file.split('/').forEach((segment) => {
    if (segment === '' || segment === '.' || segment === '..') {
      throw invalidPath(file, 'empty, "." and ".." segments are not allowed');
    }
  });
};

/**
 * The paths of a project in the order they are written: each one checked,
 * sorted by UTF-16 code units, so the order of the keys of `files` does not
 * matter. Throws, naming the path, on a path that is not a plain relative
 * POSIX path or that is a directory of another path of the project.
 */
export const projectFiles = (files: ProjectFiles): string[] => {
  const paths = Object.keys(files).sort();
  paths.forEach(checkPath);

  const set = new Set(paths);
  paths.forEach((file) => {
    const segments = file.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      const parent = segments.slice(0, length).join('/');
      if (set.has(parent)) {
        throw invalidPath(
          file,
          `its directory ${JSON.stringify(parent)} is a file of the project`
        );
      }
    }
  });

  return paths;
};

/**
 * Writes the project into a new temporary directory and returns it with a
 * `remove()` that deletes the directory. The paths are checked before the
 * directory is created; if writing fails, the directory is deleted before the
 * error is thrown.
 */
export const createProject = (
  files: ProjectFiles,
  { prefix = DEFAULT_PREFIX }: ProjectOptions = {}
): Project & { remove(): void } => {
  const paths = projectFiles(files);
  const directory = mkdtempSync(join(tmpdir(), prefix));

  let root: string;
  try {
    root = realpathSync(directory);
    paths.forEach((file) => {
      const target = join(root, ...file.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, files[file]);
    });
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }

  return {
    root,
    path: (file: string) => join(root, ...file.split('/')),
    remove: () => rmSync(root, { force: true, recursive: true }),
  };
};

/**
 * Writes the project, runs `run` with it and deletes the directory whatever
 * the outcome of `run`: returns what `run` returns, or rethrows its error.
 */
export const withProject = async <T>(
  files: ProjectFiles,
  run: (project: Project) => Promise<T> | T,
  options?: ProjectOptions
): Promise<T> => {
  const project = createProject(files, options);
  try {
    return await run(project);
  } finally {
    project.remove();
  }
};
