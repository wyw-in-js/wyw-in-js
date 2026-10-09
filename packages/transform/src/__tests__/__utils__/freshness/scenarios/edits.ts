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
    title: 'правка корня',
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
        note: 'зависимость не менялась: пересчитывается только корень',
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
    title: 'правка зависимости, дважды подряд',
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
        note: '#263: вторая правка подряд тоже должна дойти до корня',
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
    title: 'правка транзитивной зависимости (root → theme → palette), дважды',
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
            'Вторая правка транзитивной зависимости не доходит до корня: ' +
            'корень пересобирается, но theme.ts и palette.ts остаются ' +
            'закэшированными EvaluatedEntrypoint предыдущего поколения, ' +
            'eval берёт их старые значения, CSS устаревший (red вместо ' +
            'green). Первая правка той же цепочки работает — симптом ' +
            '#263 («первая правка работает, следующие нет») для ' +
            'runtime-зависимостей.',
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
            'Следствие предыдущего шага: пропущенная правка обнаруживается ' +
            'только на следующем холостом transform, и он пересчитывает ' +
            'всю цепочку.',
          intended: fromCache,
        },
      },
    ],
  },
  {
    id: 'transitive-static-dep-edit',
    title: 'правка транзитивной статической зависимости, дважды',
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
        note: 'вся цепочка разрешается статически при подготовке корня',
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
        note: 'в отличие от runtime-цепочки вторая правка доходит',
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
    title: 'правку зависимости видит другой корень, затем первый',
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
        note: '#279: закэшированная вычисленная зависимость сверяется с диском',
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
    title: 'переименование зависимости',
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
    title: 'удаление зависимости, которую корень перестал импортировать',
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
        note: '#278: удалённый файл из старого графа не роняет проверку',
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
    title: 'удаление импортируемой зависимости и её восстановление',
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
          'ошибку даёт резолвер eval-раннера: резолвер бандлера при ' +
          'подготовке корня не вызывается повторно',
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
          'корень подготовлен на прошлом шаге; dep.ts готовит eval-брокер ' +
          'по требованию, без публикации результата подготовки',
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
    title: 'циклические зависимости (a ↔ b)',
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
        note: '#148: проверка свежести не зацикливается и видит правку',
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
            'Холостой transform после правки внутри цикла снова ' +
            'пересчитывает корень (подготовка и eval), хотя ничего не ' +
            'менялось.',
          intended: fromCache,
        },
      },
    ],
  },
  {
    id: 'mtime-gate',
    title: 'touch без изменений и правка с сохранённым mtime',
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
        note: 'новый mtime при том же содержимом — не изменение',
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
        note: 'mtime и размер прежние, но отпечаток (ctime) другой',
        expect: {
          css: { 'root.ts': ['color:pink;'] },
          prepared: ['dep.ts', 'root.ts'],
          evaluated: ['dep.ts', 'root.ts'],
        },
      },
    ],
  },
];
