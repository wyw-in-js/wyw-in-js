import type { KnownBug, FreshnessScenario } from '../types';

import { fromCache, runtimeValue, staticValue, styled } from './sources';

const barrelRecovery = (
  description: string,
  intended: KnownBug['intended'] = {}
): KnownBug => ({
  impact: 'performance',
  description:
    `${description} Каждый повторный transform корня, чей импорт ` +
    'переписан на runtime-лист barrel, запускает fail-closed recovery ' +
    '(сброс всего кэша) и полный пересчёт — даже холостой, сразу после ' +
    'холодной сборки. Вероятная причина: eval исполняет barrel.ts, который ' +
    'никогда не публикуется как подготовленный модуль, и его граф считается ' +
    'неизвестным. Со статическими листьями recovery нет ' +
    '(barrel-static-leaf-edit).',
  intended: { reset: 'none', ...intended },
});

/** Barrel rewrites: named re-exports, `export *`, static re-export chains. */
export const barrelScenarios: FreshnessScenario[] = [
  {
    id: 'barrel-leaf-edit',
    title: 'правка листа barrel (именованные реэкспорты)',
    refs: ['#268', '#271'],
    files: {
      'root.ts': styled(
        ["import { primary } from './barrel';"],
        'color: ${primary};'
      ),
      'barrel.ts': [
        "export { primary } from './primary';",
        "export { secondary } from './secondary';",
        '',
      ].join('\n'),
      'primary.ts': runtimeValue('primary', 'blue'),
      'secondary.ts': runtimeValue('secondary', 'gray'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'импорт переписан на лист; barrel.ts исполняется, но не готовится',
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['primary.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'primary.ts', 'root.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['primary.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'primary.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery(
          'Холостой transform до любых правок.',
          fromCache
        ),
      },
      { do: 'write', files: { 'primary.ts': runtimeValue('primary', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['primary.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'primary.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery('Правка используемого листа.'),
      },
      {
        do: 'write',
        files: { 'secondary.ts': runtimeValue('secondary', 'black') },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['primary.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'primary.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery(
          'Правка неиспользуемого листа: вывод корня от неё не зависит.',
          fromCache
        ),
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['primary.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'primary.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery('Холостой transform.', fromCache),
      },
    ],
  },
  {
    id: 'barrel-retarget',
    title: 'barrel перенаправляет реэкспорт на другой лист',
    refs: ['#268'],
    files: {
      'root.ts': styled(
        ["import { tone } from './barrel';"],
        'color: ${tone};'
      ),
      'barrel.ts': "export { tone } from './light';\n",
      'light.ts': runtimeValue('tone', 'white'),
      'dark.ts': runtimeValue('tone', 'black'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:white;'] },
          prepared: ['light.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'light.ts', 'root.ts'],
        },
      },
      {
        do: 'write',
        files: { 'barrel.ts': "export { tone } from './dark';\n" },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: '#268: barrel — зависимость инвалидации переписанного импорта',
        expect: {
          css: { 'root.ts': ['color:black;'] },
          prepared: ['dark.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'dark.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery('Правка самого barrel.'),
      },
      { do: 'write', files: { 'light.ts': runtimeValue('tone', 'ivory') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:black;'] },
          prepared: ['dark.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'dark.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery(
          'Правка листа, на который barrel больше не ссылается.',
          fromCache
        ),
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:black;'] },
          prepared: ['dark.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'dark.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery('Холостой transform.', fromCache),
      },
    ],
  },
  {
    id: 'export-star-leaf-edit',
    title: 'правка листа за `export *`, дважды',
    refs: ['#271'],
    files: {
      'root.ts': styled(
        ["import { tone } from './barrel';"],
        'color: ${tone};'
      ),
      'barrel.ts': "export * from './leaf';\n",
      'leaf.ts': runtimeValue('tone', 'white'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:white;'] },
          prepared: ['leaf.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'leaf.ts', 'root.ts'],
        },
      },
      { do: 'write', files: { 'leaf.ts': runtimeValue('tone', 'black') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: '#271: кэш barrel-анализа зависит от листьев за `export *`',
        expect: {
          css: { 'root.ts': ['color:black;'] },
          prepared: ['leaf.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'leaf.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery('Правка листа за `export *`.'),
      },
      { do: 'write', files: { 'leaf.ts': runtimeValue('tone', 'gray') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:gray;'] },
          prepared: ['leaf.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'leaf.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery('Вторая правка листа за `export *`.'),
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:gray;'] },
          prepared: ['leaf.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'leaf.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery('Холостой transform.', fromCache),
      },
    ],
  },
  {
    id: 'barrel-static-leaf-edit',
    title: 'правка статического листа barrel',
    refs: ['#268', '#271'],
    files: {
      'root.ts': styled(
        ["import { primary } from './barrel';"],
        'color: ${primary};'
      ),
      'barrel.ts': [
        "export { primary } from './primary';",
        "export { secondary } from './secondary';",
        '',
      ].join('\n'),
      'primary.ts': staticValue('primary', 'blue'),
      'secondary.ts': staticValue('secondary', 'gray'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'значение разрешается статически через barrel',
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['root.ts'],
          evaluated: [],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fromCache },
      },
      { do: 'write', files: { 'primary.ts': staticValue('primary', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['root.ts'],
          evaluated: [],
        },
      },
      {
        do: 'write',
        files: { 'secondary.ts': staticValue('secondary', 'black') },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'правка неиспользуемого листа не пересчитывает корень',
        expect: { css: { 'root.ts': ['color:red;'] }, ...fromCache },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:red;'] }, ...fromCache },
      },
    ],
  },
  {
    id: 'static-reexport-chain',
    title: 'статическая цепочка реэкспортов (analysis roots)',
    refs: ['#423'],
    files: {
      'root.ts': styled(
        ["import { tokenA } from './tokens';"],
        'color: ${tokenA};'
      ),
      'tokens.ts': "export { red as tokenA } from './sub';\n",
      'sub.ts': "export { red } from './helpers';\n",
      'helpers.ts': staticValue('red', 'red'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'значение разрешается статически: eval-раннер не нужен',
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['root.ts'],
          evaluated: [],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: '#423: звенья цепочки — известный граф, а не recovery',
        expect: { css: { 'root.ts': ['color:red;'] }, ...fromCache },
      },
      { do: 'write', files: { 'helpers.ts': staticValue('red', 'blue') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['root.ts'],
          evaluated: [],
        },
      },
      { do: 'write', files: { 'helpers.ts': staticValue('red', 'green') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:green;'] },
          prepared: ['root.ts'],
          evaluated: [],
        },
      },
    ],
  },
];
