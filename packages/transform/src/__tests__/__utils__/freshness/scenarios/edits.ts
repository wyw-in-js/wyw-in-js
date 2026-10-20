import type { FreshnessScenario } from '../types';

import {
  fromCache,
  rootWithDep,
  runtimeValue,
  staticValue,
  styled,
} from './sources';

const themeOverPalette = (expression: string): string =>
  [
    "import { base } from './palette';",
    '',
    `export const accent = ${expression};`,
    '',
  ].join('\n');

const cyclicB = (value: string): string =>
  [
    "import { a } from './a';",
    '',
    `export const b = (() => '${value}')();`,
    'export const readA = () => a;',
    '',
  ].join('\n');

/** Edits, deletions and renames of a root and of its dependencies. */
export const editScenarios: FreshnessScenario[] = [
  {
    id: 'root-edit',
    title: 'root edit',
    refs: ['#135'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['dep.ts', 'root.ts'],
          evaluated: ['dep.ts', 'root.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fromCache },
      },
      {
        do: 'write',
        files: {
          'root.ts': styled(
            ["import { color } from './dep';"],
            'background: ${color};'
          ),
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'the dependency did not change: only the root is recomputed',
        expect: {
          css: { 'root.ts': ['background:blue;'] },
          prepared: ['root.ts'],
          evaluated: ['root.ts'],
        },
      },
    ],
  },
  {
    id: 'dep-edit-repeated',
    title: 'dependency edit, twice in a row',
    refs: ['#135', '#263'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['dep.ts', 'root.ts'],
          evaluated: ['dep.ts', 'root.ts'],
        },
      },
      { do: 'write', files: { 'dep.ts': runtimeValue('color', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['dep.ts', 'root.ts'],
          evaluated: ['dep.ts', 'root.ts'],
        },
      },
      { do: 'write', files: { 'dep.ts': runtimeValue('color', 'green') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: '#263: the second edit in a row must reach the root too',
        expect: {
          css: { 'root.ts': ['color:green;'] },
          prepared: ['dep.ts', 'root.ts'],
          evaluated: ['dep.ts', 'root.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:green;'] }, ...fromCache },
      },
    ],
  },
  {
    id: 'transitive-dep-edit',
    title: 'transitive dependency edit (root → theme → palette), twice',
    refs: ['#263'],
    files: {
      'root.ts': styled(
        ["import { accent } from './theme';"],
        'color: ${accent};'
      ),
      'theme.ts': themeOverPalette('(() => `${base}-accent`)()'),
      'palette.ts': runtimeValue('base', 'blue'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue-accent;'] },
          prepared: ['palette.ts', 'root.ts', 'theme.ts'],
          evaluated: ['palette.ts', 'root.ts', 'theme.ts'],
        },
      },
      { do: 'write', files: { 'palette.ts': runtimeValue('base', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red-accent;'] },
          prepared: ['palette.ts', 'root.ts', 'theme.ts'],
          evaluated: ['palette.ts', 'root.ts', 'theme.ts'],
        },
      },
      { do: 'write', files: { 'palette.ts': runtimeValue('base', 'green') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red-accent;'] },
          prepared: ['root.ts'],
          evaluated: ['root.ts'],
        },
        knownBug: {
          impact: 'correctness',
          description:
            'The second edit of a transitive dependency does not reach the ' +
            'root: the root is rebuilt, but theme.ts and palette.ts stay ' +
            'cached EvaluatedEntrypoints of the previous generation, eval ' +
            'takes their old values, and the CSS is stale (red instead of ' +
            'green). The first edit of the same chain works: the #263 ' +
            'symptom ("the first edit works, the next ones do not") for ' +
            'runtime dependencies.',
          intended: {
            css: { 'root.ts': ['color:green-accent;'] },
            prepared: ['palette.ts', 'root.ts', 'theme.ts'],
            evaluated: ['palette.ts', 'root.ts', 'theme.ts'],
          },
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:green-accent;'] },
          prepared: ['palette.ts', 'root.ts', 'theme.ts'],
          evaluated: ['palette.ts', 'root.ts', 'theme.ts'],
        },
        knownBug: {
          impact: 'performance',
          description:
            'A consequence of the previous step: the missed edit is detected ' +
            'only on the next transform with no changes, and that transform ' +
            'recomputes the whole chain.',
          intended: fromCache,
        },
      },
    ],
  },
  {
    id: 'transitive-static-dep-edit',
    title: 'transitive static dependency edit, twice',
    refs: ['#263'],
    files: {
      'root.ts': styled(
        ["import { accent } from './theme';"],
        'color: ${accent};'
      ),
      'theme.ts': themeOverPalette('base'),
      'palette.ts': staticValue('base', 'blue'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'the whole chain is resolved statically while preparing the root',
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['root.ts'],
          evaluated: [],
        },
      },
      { do: 'write', files: { 'palette.ts': staticValue('base', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['root.ts'],
          evaluated: [],
        },
      },
      { do: 'write', files: { 'palette.ts': staticValue('base', 'green') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'unlike the runtime chain, the second edit gets through',
        expect: {
          css: { 'root.ts': ['color:green;'] },
          prepared: ['root.ts'],
          evaluated: [],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:green;'] }, ...fromCache },
      },
    ],
  },
  {
    id: 'other-root-after-dep-edit',
    title: 'a dependency edit is seen by another root, then by the first one',
    refs: ['#279'],
    files: {
      'a.ts': styled(["import { color } from './dep';"], 'color: ${color};'),
      'b.ts': styled(
        ["import { color } from './dep';"],
        'background: ${color};'
      ),
      'dep.ts': runtimeValue('color', 'blue'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'a.ts' }],
        expect: {
          css: { 'a.ts': ['color:blue;'] },
          prepared: ['a.ts', 'dep.ts'],
          evaluated: ['a.ts', 'dep.ts'],
        },
      },
      { do: 'write', files: { 'dep.ts': runtimeValue('color', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'b.ts' }],
        note: '#279: a cached evaluated dependency is checked against the disk',
        expect: {
          css: { 'b.ts': ['background:red;'] },
          prepared: ['b.ts', 'dep.ts'],
          evaluated: ['b.ts', 'dep.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'a.ts' }],
        expect: {
          css: { 'a.ts': ['color:red;'] },
          prepared: ['a.ts'],
          evaluated: ['a.ts'],
        },
      },
    ],
  },
  {
    id: 'dep-rename',
    title: 'dependency rename',
    refs: ['#278'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['dep.ts', 'root.ts'],
          evaluated: ['dep.ts', 'root.ts'],
        },
      },
      { do: 'rename', from: 'dep.ts', to: 'tokens.ts' },
      {
        do: 'write',
        files: {
          'root.ts': styled(
            ["import { color } from './tokens';"],
            'color: ${color};'
          ),
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['root.ts', 'tokens.ts'],
          evaluated: ['root.ts', 'tokens.ts'],
        },
      },
      { do: 'write', files: { 'tokens.ts': runtimeValue('color', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['root.ts', 'tokens.ts'],
          evaluated: ['root.ts', 'tokens.ts'],
        },
      },
    ],
  },
  {
    id: 'dep-delete-unused',
    title: 'deletion of a dependency the root no longer imports',
    refs: ['#278'],
    files: {
      'root.ts': styled(
        ["import { color } from './dep';", "import { size } from './size';"],
        'color: ${color}; width: ${size};'
      ),
      'dep.ts': runtimeValue('color', 'blue'),
      'size.ts': runtimeValue('size', '10px'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue;width:10px;'] },
          prepared: ['dep.ts', 'root.ts', 'size.ts'],
          evaluated: ['dep.ts', 'root.ts', 'size.ts'],
        },
      },
      { do: 'write', files: { 'root.ts': rootWithDep } },
      { do: 'remove', files: ['size.ts'] },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: '#278: a deleted file of the old graph does not break the check',
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['root.ts'],
          evaluated: ['root.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fromCache },
      },
    ],
  },
  {
    id: 'dep-delete-imported',
    title: 'deletion of an imported dependency and its restoration',
    refs: ['#278'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['dep.ts', 'root.ts'],
          evaluated: ['dep.ts', 'root.ts'],
        },
      },
      { do: 'remove', files: ['dep.ts'] },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note:
          'the error comes from the eval runner resolver: the bundler ' +
          'resolver is not called again while preparing the root',
        expect: {
          error: { 'root.ts': "Cannot find module './dep'" },
          prepared: ['root.ts'],
          evaluated: [],
        },
      },
      { do: 'write', files: { 'dep.ts': runtimeValue('color', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note:
          'the root was prepared on the previous step; the eval broker ' +
          'prepares dep.ts on demand, without publishing the preparation ' +
          'result',
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: [],
          evaluated: ['dep.ts', 'root.ts'],
        },
      },
    ],
  },
  {
    id: 'cyclic-deps-edit',
    title: 'cyclic dependencies (a ↔ b)',
    refs: ['#148'],
    files: {
      'root.ts': styled(["import { a } from './a';"], 'color: ${a};'),
      'a.ts': [
        "import { b } from './b';",
        '',
        'export const a = (() => `a-${b}`)();',
        '',
      ].join('\n'),
      'b.ts': cyclicB('b1'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:a-b1;'] },
          prepared: ['a.ts', 'b.ts', 'root.ts'],
          evaluated: ['a.ts', 'b.ts', 'root.ts'],
        },
      },
      { do: 'write', files: { 'b.ts': cyclicB('b2') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: '#148: the freshness check does not loop and sees the edit',
        expect: {
          css: { 'root.ts': ['color:a-b2;'] },
          prepared: ['a.ts', 'b.ts', 'root.ts'],
          evaluated: ['a.ts', 'b.ts', 'root.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:a-b2;'] },
          prepared: ['root.ts'],
          evaluated: ['root.ts'],
        },
        knownBug: {
          impact: 'performance',
          description:
            'A transform with no changes after an edit inside the cycle ' +
            'recomputes the root again (preparation and eval), although ' +
            'nothing changed.',
          intended: fromCache,
        },
      },
    ],
  },
  {
    id: 'mtime-gate',
    title: 'touch without changes and an edit with a preserved mtime',
    refs: ['#283'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['dep.ts', 'root.ts'],
          evaluated: ['dep.ts', 'root.ts'],
        },
      },
      { do: 'touch', files: ['dep.ts'] },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'a new mtime with the same content is not a change',
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fromCache },
      },
      {
        do: 'write',
        files: { 'dep.ts': runtimeValue('color', 'pink') },
        mtime: 'preserve',
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'same mtime and size, but the fingerprint (ctime) differs',
        expect: {
          css: { 'root.ts': ['color:pink;'] },
          prepared: ['dep.ts', 'root.ts'],
          evaluated: ['dep.ts', 'root.ts'],
        },
      },
    ],
  },
];
