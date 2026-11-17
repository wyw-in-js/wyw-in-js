import { existsSync, readdirSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';

import {
  createProject,
  projectFiles,
  withProject,
  type ProjectFiles,
} from './__utils__/project';

const uniquePrefix = () =>
  `wyw-project-test-${process.pid}-${Math.random().toString(36).slice(2)}-`;

const leftovers = (prefix: string) =>
  readdirSync(tmpdir()).filter((name) => name.startsWith(prefix));

const errorOf = (action: () => unknown): Error => {
  try {
    action();
  } catch (error) {
    return error as Error;
  }

  throw new Error('expected the action to throw');
};

describe('project helper', () => {
  it('writes every file with its content, nested files included', async () => {
    const files: ProjectFiles = {
      'entry.js': "import { color } from './values';\n",
      'values.js': "export const color = 'red';\n",
      'node_modules/pkg/index.js': 'module.exports = 1;\n',
      'node_modules/pkg/package.json': '{ "name": "pkg" }\n',
    };

    const contents = await withProject(files, (project) => ({
      entry: readFileSync(join(project.root, 'entry.js'), 'utf8'),
      values: readFileSync(join(project.root, 'values.js'), 'utf8'),
      pkgIndex: readFileSync(
        join(project.root, 'node_modules', 'pkg', 'index.js'),
        'utf8'
      ),
      pkgManifest: readFileSync(
        join(project.root, 'node_modules', 'pkg', 'package.json'),
        'utf8'
      ),
      topLevel: readdirSync(project.root).sort(),
    }));

    expect(contents).toEqual({
      entry: "import { color } from './values';\n",
      values: "export const color = 'red';\n",
      pkgIndex: 'module.exports = 1;\n',
      pkgManifest: '{ "name": "pkg" }\n',
      topLevel: ['entry.js', 'node_modules', 'values.js'],
    });
  });

  it('gives the real path of a directory under the temporary directory as its root', async () => {
    await withProject({ 'a.js': '' }, (project) => {
      expect(realpathSync(project.root)).toBe(project.root);
      expect(project.root.startsWith(`${realpathSync(tmpdir())}${sep}`)).toBe(
        true
      );
    });
  });

  it('gives the absolute path of a project file', async () => {
    await withProject({ 'src/a.js': 'a' }, (project) => {
      expect(project.path('src/a.js')).toBe(join(project.root, 'src/a.js'));
      expect(project.path('entry.js')).toBe(join(project.root, 'entry.js'));
      expect(readFileSync(project.path('src/a.js'), 'utf8')).toBe('a');
    });
  });

  it('uses the prefix for the name of the directory', async () => {
    const prefix = uniquePrefix();

    await withProject(
      { 'a.js': '' },
      (project) => {
        expect(leftovers(prefix)).toHaveLength(1);
        expect(
          project.root.startsWith(join(realpathSync(tmpdir()), prefix))
        ).toBe(true);
      },
      { prefix }
    );

    expect(leftovers(prefix)).toEqual([]);
  });

  it('orders the paths the same way whatever the order of the keys', () => {
    const one: ProjectFiles = {
      'b.js': '',
      'node_modules/pkg/index.js': '',
      'a/c.js': '',
      '10': '',
      'A.js': '',
      '2': '',
      'a.js': '',
    };
    const other: ProjectFiles = {
      'a.js': '',
      '2': '',
      'A.js': '',
      'a/c.js': '',
      '10': '',
      'node_modules/pkg/index.js': '',
      'b.js': '',
    };
    const expected = [
      '10',
      '2',
      'A.js',
      'a.js',
      'a/c.js',
      'b.js',
      'node_modules/pkg/index.js',
    ];

    expect(projectFiles(one)).toEqual(expected);
    expect(projectFiles(other)).toEqual(expected);
  });

  it('returns what run returns and removes the directory after it', async () => {
    let root = '';
    let existedDuringRun = false;

    const result = await withProject({ 'a.js': 'a' }, async (project) => {
      root = project.root;
      existedDuringRun = existsSync(project.path('a.js'));
      return 'value';
    });

    expect(result).toBe('value');
    expect(existedDuringRun).toBe(true);
    expect(root).not.toBe('');
    expect(existsSync(root)).toBe(false);
  });

  it('removes the directory and rethrows when run throws', async () => {
    let root = '';

    await expect(
      withProject({ 'a.js': 'a' }, (project) => {
        root = project.root;
        throw new Error('run failed');
      })
    ).rejects.toThrow('run failed');

    expect(root).not.toBe('');
    expect(existsSync(root)).toBe(false);
  });

  it('removes the directory and rethrows when run rejects', async () => {
    let root = '';

    await expect(
      withProject({ 'a.js': 'a' }, async (project) => {
        root = project.root;
        await Promise.resolve();
        throw new Error('run rejected');
      })
    ).rejects.toThrow('run rejected');

    expect(root).not.toBe('');
    expect(existsSync(root)).toBe(false);
  });

  it('removes the directory of createProject on remove()', () => {
    const project = createProject({ 'dir/a.js': 'a' });

    expect(readFileSync(project.path('dir/a.js'), 'utf8')).toBe('a');

    project.remove();

    expect(existsSync(project.root)).toBe(false);
  });

  describe('rejects a path that is not a plain relative POSIX path', () => {
    [
      '',
      '/a.js',
      '../a.js',
      'a/../b.js',
      './a.js',
      'a//b.js',
      'a\\b.js',
      'a/',
    ].forEach((file) => {
      it(`rejects ${JSON.stringify(file)}`, async () => {
        const prefix = uniquePrefix();
        const files: ProjectFiles = { 'ok.js': '', [file]: '' };

        expect(errorOf(() => projectFiles(files)).message).toContain(
          JSON.stringify(file)
        );
        expect(
          errorOf(() => createProject(files, { prefix })).message
        ).toContain(JSON.stringify(file));

        const run = jest.fn();
        await expect(withProject(files, run, { prefix })).rejects.toThrow(
          JSON.stringify(file)
        );
        expect(run).not.toHaveBeenCalled();

        expect(leftovers(prefix)).toEqual([]);
      });
    });
  });

  it('rejects a file that is a directory of another file', async () => {
    const prefix = uniquePrefix();
    const files: ProjectFiles = { 'a.js': '', 'a.js/b.js': '' };

    expect(errorOf(() => projectFiles(files)).message).toContain(
      JSON.stringify('a.js/b.js')
    );
    expect(errorOf(() => createProject(files, { prefix })).message).toContain(
      JSON.stringify('a.js')
    );

    const run = jest.fn();
    await expect(withProject(files, run, { prefix })).rejects.toThrow(
      'a.js/b.js'
    );
    expect(run).not.toHaveBeenCalled();

    expect(leftovers(prefix)).toEqual([]);
  });
});
