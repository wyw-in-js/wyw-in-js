import type { FreshnessScenario, KnownBug } from '../types';

import { fromCache, rootWithDep, runtimeValue, styled } from './sources';

const fullRecompute = {
  prepared: ['dep.ts', 'root.ts'],
  evaluated: ['dep.ts', 'root.ts'],
};

const loaderRootRecompute: KnownBug = {
  impact: 'performance',
  description:
    'Если зависимость пришла из loadDependencyCode, каждый повторный ' +
    'transform корня заново готовит и исполняет корень, хотя ни диск, ни ' +
    'код загрузчика не менялись (сама зависимость из кэша).',
  intended: fromCache,
};

/**
 * What a transform runs with: the cache salt (resolver, options), the
 * bundler-provided code of roots and dependencies, request variants and
 * explicit invalidation.
 */
export const sessionScenarios: FreshnessScenario[] = [
  {
    id: 'salt-resolver-key',
    title: 'смена соли: другой ключ резолвера и возврат к прежнему',
    refs: ['#234'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    sessions: { other: { resolverKey: 'freshness-other' } },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fullRecompute },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'other' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          ...fullRecompute,
          reset: 'salt',
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'кэш одной соли за раз: возврат к прежней снова всё сбрасывает',
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          ...fullRecompute,
          reset: 'salt',
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
    id: 'salt-plugin-options',
    title: 'смена соли: опции плагина',
    refs: ['#234'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    sessions: {
      sameOptionsNewObject: { freshPluginOptionsPerCall: true },
      noHappyDom: { pluginOptions: { features: { happyDOM: false } } },
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fullRecompute },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'sameOptionsNewObject' }],
        note: 'соль считается по содержимому опций, а не по identity объекта',
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fromCache },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'noHappyDom' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          ...fullRecompute,
          reset: 'salt',
        },
      },
    ],
  },
  {
    id: 'resolver-identity-salt',
    title: 'без asyncResolveKey соль зависит от identity функции резолвера',
    refs: ['#234'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    sessions: {
      default: { resolverKey: null, freshResolverPerCall: true },
      stableResolver: { resolverKey: null },
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fullRecompute },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'контракт API: новая функция резолвера без ключа — новая соль',
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          ...fullRecompute,
          reset: 'salt',
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'stableResolver' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          ...fullRecompute,
          reset: 'salt',
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'stableResolver' }],
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fromCache },
      },
    ],
  },
  {
    id: 'loaded-dependency-code',
    title: 'код зависимости из loadDependencyCode отличается от диска',
    refs: ['#234', '#238'],
    files: {
      'root.ts': rootWithDep,
      'dep.ts': runtimeValue('color', 'blue-disk'),
    },
    sessions: {
      default: { loader: { key: 'loader', files: { 'dep.ts': 'loaded' } } },
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'исполняется код загрузчика, а не байты с диска',
        expect: {
          css: { 'root.ts': ['color:blue-loaded;'] },
          ...fullRecompute,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: '#234: расхождение «загрузчик ≠ диск» не инвалидирует dep.ts',
        expect: {
          css: { 'root.ts': ['color:blue-loaded;'] },
          prepared: ['root.ts'],
          evaluated: ['root.ts'],
        },
        knownBug: loaderRootRecompute,
      },
      { do: 'write', files: { 'dep.ts': runtimeValue('color', 'red-disk') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red-loaded;'] },
          ...fullRecompute,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red-loaded;'] },
          prepared: ['root.ts'],
          evaluated: ['root.ts'],
        },
        knownBug: loaderRootRecompute,
      },
    ],
  },
  {
    id: 'loaded-then-disk',
    title: 'зависимость сначала из загрузчика, затем с диска и обратно',
    refs: ['#423', '#427'],
    files: {
      'root.ts': rootWithDep,
      'dep.ts': runtimeValue('color', 'blue-disk'),
    },
    sessions: {
      default: { loader: { key: 'loader', files: { 'dep.ts': 'loaded' } } },
      disk: { loader: { key: 'loader', files: { 'dep.ts': 'none' } } },
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue-loaded;'] },
          ...fullRecompute,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'disk' }],
        note:
          '#427: байты на диске не менялись — повторно используется ' +
          'прежний код загрузчика',
        expect: {
          css: { 'root.ts': ['color:blue-loaded;'] },
          prepared: ['root.ts'],
          evaluated: ['root.ts'],
        },
        knownBug: loaderRootRecompute,
      },
      { do: 'write', files: { 'dep.ts': runtimeValue('color', 'red-disk') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'disk' }],
        expect: {
          css: { 'root.ts': ['color:red-disk;'] },
          ...fullRecompute,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note:
          'ревизия на диске та же: корень из кэша, загрузчик не ' +
          'спрашивается, остаётся исполненный дисковый код (одинаковый ' +
          'loadDependencyCodeKey обещает одинаковую семантику)',
        expect: { css: { 'root.ts': ['color:red-disk;'] }, ...fromCache },
      },
    ],
  },
  {
    id: 'root-loaded-source',
    title: 'код корня от бандлера отличается от диска',
    refs: ['#234', '#427'],
    files: {
      'root.ts': styled(
        ["import { color } from './dep';"],
        'color: ${color}; outline: none-disk;'
      ),
      'dep.ts': runtimeValue('color', 'blue'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts', source: 'loaded' }],
        expect: {
          css: { 'root.ts': ['color:blue;outline:none-loaded;'] },
          ...fullRecompute,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', source: 'loaded' }],
        expect: {
          css: { 'root.ts': ['color:blue;outline:none-loaded;'] },
          ...fromCache,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue;outline:none-disk;'] },
          prepared: ['root.ts'],
          evaluated: ['root.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', source: 'loaded' }],
        expect: {
          css: { 'root.ts': ['color:blue;outline:none-loaded;'] },
          prepared: ['root.ts'],
          evaluated: ['root.ts'],
        },
      },
    ],
  },
  {
    id: 'query-variants',
    title: 'варианты одного файла с ?query / #hash',
    refs: ['#234', '#278'],
    files: {
      'root.ts': styled(
        ["import { color } from './dep?inline';"],
        'color: ${color};'
      ),
      'dep.ts': runtimeValue('color', 'blue'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts?variant=a' }, { file: 'root.ts#b' }],
        note: 'каждый вариант — отдельный узел кэша',
        expect: {
          css: {
            'root.ts?variant=a': ['color:blue;'],
            'root.ts#b': ['color:blue;'],
          },
          prepared: ['dep.ts?inline', 'root.ts#b', 'root.ts?variant=a'],
          evaluated: ['dep.ts?inline', 'root.ts#b', 'root.ts?variant=a'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['root.ts'],
          evaluated: ['root.ts'],
        },
      },
      { do: 'write', files: { 'dep.ts': runtimeValue('color', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts?variant=a' }, { file: 'root.ts#b' }],
        expect: {
          css: {
            'root.ts?variant=a': ['color:red;'],
            'root.ts#b': ['color:red;'],
          },
          prepared: ['dep.ts?inline', 'root.ts#b', 'root.ts?variant=a'],
          evaluated: ['dep.ts?inline', 'root.ts#b', 'root.ts?variant=a'],
          reset: 'recovery',
        },
        knownBug: {
          impact: 'performance',
          description:
            'Два варианта корня, параллельно пересобираемые после правки ' +
            'общей зависимости, запускают fail-closed recovery (сброс ' +
            'всего кэша).',
          intended: { reset: 'none' },
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['root.ts'],
          evaluated: ['root.ts'],
        },
      },
    ],
  },
  {
    id: 'explicit-invalidate',
    title: 'явная инвалидация (invalidateForFile, как в Vite HMR)',
    refs: ['#411', '#423'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fullRecompute },
      },
      { do: 'invalidate', files: ['dep.ts'] },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: 'вытеснение без изменения содержимого не заставляет пересчитывать',
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fromCache },
      },
      {
        do: 'write',
        files: { 'dep.ts': runtimeValue('color', 'cyan') },
        mtime: 'preserve',
      },
      { do: 'invalidate', files: ['dep.ts', 'root.ts'] },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['color:cyan;'] }, ...fullRecompute },
      },
    ],
  },
];
