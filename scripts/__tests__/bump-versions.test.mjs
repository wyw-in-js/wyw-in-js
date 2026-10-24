import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const bumpVersionsScript = join(repoRoot, 'scripts/bump-versions.mjs');
const changesetBin = join(
  repoRoot,
  process.platform === 'win32'
    ? 'node_modules/.bin/changeset.cmd'
    : 'node_modules/.bin/changeset'
);

function writeJSON(filename, value) {
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function writePackage(root, packagePath, packageJson) {
  const packageRoot = join(root, packagePath);
  mkdirSync(packageRoot, { recursive: true });
  writeJSON(join(packageRoot, 'package.json'), packageJson);
}

test('bump-versions aligns only publishable workspaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-bump-versions-'));

  try {
    writeJSON(join(root, 'package.json'), {
      name: 'fixture-root',
      private: true,
      version: '1.0.0',
      workspaces: ['.', 'packages/*', 'examples/*'],
    });
    writeFileSync(join(root, 'bun.lock'), '');

    mkdirSync(join(root, '.changeset'), { recursive: true });
    writeJSON(join(root, '.changeset/config.json'), {
      access: 'restricted',
      baseBranch: 'main',
      changelog: false,
      commit: false,
      fixed: [],
      ignore: [],
      linked: [],
      privatePackages: {
        tag: false,
        version: false,
      },
      updateInternalDependencies: 'patch',
    });
    writeFileSync(
      join(root, '.changeset/minor-core.md'),
      [
        '---',
        '"@fixture/core": minor',
        '---',
        '',
        'Add a public API.',
        '',
      ].join('\n')
    );

    writePackage(root, 'packages/core', {
      name: '@fixture/core',
      version: '1.0.0',
    });
    writePackage(root, 'packages/adapter', {
      name: '@fixture/adapter',
      version: '1.0.5',
    });
    writePackage(root, 'examples/demo', {
      dependencies: {
        '@fixture/core': 'workspace:*',
      },
      name: '@fixture/demo',
      private: true,
      version: '0.1.0',
    });

    const result = spawnSync(process.execPath, [bumpVersionsScript], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());

    const generatedChangeset = readdirSync(join(root, '.changeset'))
      .filter((filename) => filename.endsWith('.md'))
      .filter((filename) => filename !== 'minor-core.md');

    assert.equal(generatedChangeset.length, 1);

    const contents = readFileSync(
      join(root, '.changeset', generatedChangeset[0]),
      'utf8'
    );

    assert.match(contents, /"@fixture\/adapter": minor/);
    assert.doesNotMatch(contents, /@fixture\/demo/);

    const versionResult = spawnSync(changesetBin, ['version'], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(
      versionResult.status,
      0,
      `${versionResult.stdout}\n${versionResult.stderr}`.trim()
    );
    assert.equal(
      JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8'))
        .version,
      '1.1.0'
    );
    assert.equal(
      JSON.parse(
        readFileSync(join(root, 'packages/adapter/package.json'), 'utf8')
      ).version,
      '1.1.0'
    );
    assert.equal(
      JSON.parse(readFileSync(join(root, 'examples/demo/package.json'), 'utf8'))
        .version,
      '0.1.0'
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
