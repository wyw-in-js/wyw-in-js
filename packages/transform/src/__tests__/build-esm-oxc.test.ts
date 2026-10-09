/* eslint-env jest */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const buildScript = join(repoRoot, 'scripts', 'build-esm-oxc.mjs');
const nodeBinary =
  process.env.WYW_NODE_BINARY ||
  (process.execPath.includes('bun') ? 'node' : process.execPath);

describe('build-esm-oxc', () => {
  it('lowers explicit resource management for Node 22-compatible ESM output', () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-build-esm-'));

    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            type: 'module',
            exports: {
              '.': {
                default: './esm/index.js',
              },
            },
          },
          null,
          2
        )
      );
      writeFileSync(
        join(root, 'src', 'index.ts'),
        [
          'const events: string[] = [];',
          'const resource = {',
          '  [Symbol.dispose]() {',
          "    events.push('disposed');",
          '  },',
          '};',
          '',
          'export function run() {',
          '  using active = resource;',
          "  events.push('body');",
          '  return active;',
          '}',
          '',
        ].join('\n')
      );

      const build = spawnSync(nodeBinary, [buildScript], {
        cwd: root,
        encoding: 'utf8',
      });

      if (build.status !== 0) {
        throw new Error(
          `build failed with ${build.status}\n${build.stdout}\n${build.stderr}`
        );
      }

      const output = readFileSync(join(root, 'esm', 'index.js'), 'utf8');
      expect(output).not.toContain('using active');
      expect(output).not.toContain('@oxc-project/runtime/helpers/usingCtx');

      const check = spawnSync(nodeBinary, [
        '--check',
        join(root, 'esm', 'index.js'),
      ]);
      expect(check.status).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('points .js specifiers of TypeScript siblings at the emitted extension', () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-build-esm-'));

    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ type: 'module' }, null, 2)
      );
      writeFileSync(
        join(root, 'src', 'helper.ts'),
        'export const answer: number = 42;\n'
      );
      writeFileSync(
        join(root, 'src', 'index.ts'),
        "export { answer } from './helper.js';\n"
      );

      const build = spawnSync(
        nodeBinary,
        [buildScript, '--out-file-extension', '.mjs'],
        { cwd: root, encoding: 'utf8' }
      );

      if (build.status !== 0) {
        throw new Error(
          `build failed with ${build.status}\n${build.stdout}\n${build.stderr}`
        );
      }

      const output = readFileSync(join(root, 'esm', 'index.mjs'), 'utf8');
      expect(output).toContain('"./helper.mjs"');

      const run = spawnSync(
        nodeBinary,
        [
          '--input-type=module',
          '-e',
          `import { answer } from ${JSON.stringify(
            join(root, 'esm', 'index.mjs')
          )}; if (answer !== 42) process.exit(1);`,
        ],
        { encoding: 'utf8' }
      );
      expect(run.status).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
