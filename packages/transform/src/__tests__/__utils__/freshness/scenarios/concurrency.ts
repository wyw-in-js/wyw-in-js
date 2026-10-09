import type { FreshnessScenario, KnownBug } from '../types';

import { fromCache, rootWithDep, runtimeValue, styled } from './sources';

const concurrentRecovery: KnownBug = {
  impact: 'performance',
  description:
    'Параллельные transform после обычной правки общей зависимости ' +
    'запускают fail-closed recovery: сбрасывается весь кэш, хотя вывод ' +
    'верный. Бандлеры всегда трансформируют модули параллельно.',
  intended: { reset: 'none' },
};

const sharedWithAccent = (color: string): Record<string, string> => ({
  'shared.ts': styled(
    [
      "import { colors } from './tokens';",
      '',
      'export const accent = (() => `${colors.red}-accent`)();',
    ],
    'color: ${accent};'
  ),
  'entry.ts': styled(
    ["import { accent } from './shared';"],
    'background: ${accent};'
  ),
  'tokens.ts': `export const colors = { red: '${color}' };\n`,
});

/** Concurrent transforms, supersede, the watch loop and shared caches. */
export const concurrencyScenarios: FreshnessScenario[] = [
  {
    id: 'concurrent-same-root',
    title: 'конкурентные transform одного файла',
    refs: ['#427'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    steps: [
      {
        do: 'transform',
        calls: [
          { file: 'root.ts', id: 'first' },
          { file: 'root.ts', id: 'second' },
        ],
        note: 'два вызова делят одну подготовку и один eval',
        expect: {
          css: { first: ['color:blue;'], second: ['color:blue;'] },
          prepared: ['dep.ts', 'root.ts'],
          evaluated: ['dep.ts', 'root.ts'],
        },
      },
      { do: 'write', files: { 'dep.ts': runtimeValue('color', 'red') } },
      {
        do: 'transform',
        calls: [
          { file: 'root.ts', id: 'first' },
          { file: 'root.ts', id: 'second' },
        ],
        expect: {
          css: { first: ['color:red;'], second: ['color:red;'] },
          prepared: ['dep.ts', 'root.ts'],
          evaluated: ['dep.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: concurrentRecovery,
      },
    ],
  },
  {
    id: 'concurrent-roots-shared-dep',
    title: 'параллельные корни с общей зависимостью',
    refs: ['#423', '#427'],
    files: {
      'a.ts': styled(["import { color } from './theme';"], 'color: ${color};'),
      'b.ts': styled(
        ["import { color } from './theme';"],
        'background: ${color};'
      ),
      'c.ts': styled(
        ["import { color } from './theme';"],
        'border-color: ${color};'
      ),
      'theme.ts': runtimeValue('color', 'blue'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'a.ts' }, { file: 'b.ts' }, { file: 'c.ts' }],
        expect: {
          css: {
            'a.ts': ['color:blue;'],
            'b.ts': ['background:blue;'],
            'c.ts': ['border-color:blue;'],
          },
          prepared: ['a.ts', 'b.ts', 'c.ts', 'theme.ts'],
          evaluated: ['a.ts', 'b.ts', 'c.ts', 'theme.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'a.ts' }, { file: 'b.ts' }, { file: 'c.ts' }],
        note: '#423: повторная сборка без правок не запускает recovery',
        expect: {
          css: {
            'a.ts': ['color:blue;'],
            'b.ts': ['background:blue;'],
            'c.ts': ['border-color:blue;'],
          },
          ...fromCache,
        },
      },
      { do: 'write', files: { 'theme.ts': runtimeValue('color', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'a.ts' }, { file: 'b.ts' }, { file: 'c.ts' }],
        expect: {
          css: {
            'a.ts': ['color:red;'],
            'b.ts': ['background:red;'],
            'c.ts': ['border-color:red;'],
          },
          prepared: ['a.ts', 'b.ts', 'c.ts', 'theme.ts'],
          evaluated: ['a.ts', 'b.ts', 'c.ts', 'theme.ts'],
          reset: 'recovery',
        },
        knownBug: concurrentRecovery,
      },
    ],
  },
  {
    id: 'watch-rebuild-cycle',
    title: 'watch-цикл: параллельная пересборка всех изменённых модулей',
    refs: ['#263', '#279', '#283'],
    files: {
      'a.ts': styled(
        ["import { accent } from './theme';"],
        'color: ${accent};'
      ),
      'b.ts': styled(
        ["import { base } from './palette';"],
        'background: ${base};'
      ),
      'theme.ts': [
        "import { base } from './palette';",
        '',
        'export const accent = (() => `${base}-accent`)();',
        '',
      ].join('\n'),
      'palette.ts': runtimeValue('base', 'blue'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'a.ts' }, { file: 'b.ts' }],
        expect: {
          css: { 'a.ts': ['color:blue-accent;'], 'b.ts': ['background:blue;'] },
          prepared: ['a.ts', 'b.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['a.ts', 'b.ts', 'palette.ts', 'theme.ts'],
        },
      },
      { do: 'write', files: { 'palette.ts': runtimeValue('base', 'red') } },
      {
        do: 'transform',
        calls: [
          { file: 'palette.ts' },
          { file: 'theme.ts' },
          { file: 'a.ts' },
          { file: 'b.ts' },
        ],
        note: 'бандлер пересобирает изменённый файл и всех его импортёров',
        expect: {
          css: {
            'palette.ts': [],
            'theme.ts': [],
            'a.ts': ['color:red-accent;'],
            'b.ts': ['background:red;'],
          },
          prepared: ['a.ts', 'b.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['a.ts', 'b.ts', 'palette.ts', 'theme.ts'],
          reset: 'recovery',
        },
        knownBug: concurrentRecovery,
      },
      { do: 'write', files: { 'palette.ts': runtimeValue('base', 'green') } },
      {
        do: 'transform',
        calls: [
          { file: 'palette.ts' },
          { file: 'theme.ts' },
          { file: 'a.ts' },
          { file: 'b.ts' },
        ],
        note:
          'в отличие от transitive-dep-edit вторая правка доходит: ' +
          'промежуточные модули тоже трансформируются',
        expect: {
          css: {
            'palette.ts': [],
            'theme.ts': [],
            'a.ts': ['color:green-accent;'],
            'b.ts': ['background:green;'],
          },
          prepared: ['a.ts', 'b.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['a.ts', 'b.ts', 'palette.ts', 'theme.ts'],
          reset: 'recovery',
        },
        knownBug: concurrentRecovery,
      },
      {
        do: 'transform',
        calls: [{ file: 'a.ts' }, { file: 'b.ts' }],
        expect: {
          css: {
            'a.ts': ['color:green-accent;'],
            'b.ts': ['background:green;'],
          },
          ...fromCache,
        },
      },
    ],
  },
  {
    id: 'supersede-root-during-eval',
    title: 'правка корня, пока его transform ждёт eval (supersede)',
    refs: ['#427'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    steps: [
      {
        do: 'start',
        id: 'stale',
        call: { file: 'root.ts' },
        hold: { at: 'eval' },
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
        note: 'включает подготовку удержанного вызова до точки удержания',
        expect: {
          css: { 'root.ts': ['background:blue;'] },
          prepared: ['dep.ts', 'root.ts'],
          evaluated: ['dep.ts', 'root.ts'],
        },
      },
      { do: 'release', id: 'stale' },
      {
        do: 'join',
        expect: { css: { stale: ['background:blue;'] }, ...fromCache },
        knownBug: {
          impact: 'correctness',
          description:
            'Вытесненный (superseded) вызов transform со старым кодом ' +
            'возвращает CSS новой ревизии файла: workflow перезапускается на ' +
            'supersededWith. Это нарушает контракт «вывод соответствует ' +
            'переданному коду»: бандлер с персистентным кэшем по хэшу входа ' +
            'сохранит чужой вывод под старым содержимым. Спорно — так ' +
            'задуман механизм supersede.',
          intended: {
            css: { stale: ['color:blue;'] },
            prepared: undefined,
            evaluated: undefined,
          },
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        expect: { css: { 'root.ts': ['background:blue;'] }, ...fromCache },
      },
    ],
  },
  {
    id: 'supersede-dependency-in-resolve',
    title:
      'корень удерживается в resolve, другой корень берёт его как зависимость',
    refs: ['#427'],
    files: sharedWithAccent('red'),
    steps: [
      {
        do: 'start',
        id: 'shared',
        call: { file: 'shared.ts' },
        hold: { at: 'resolve', importer: 'shared.ts', request: './tokens' },
      },
      { do: 'start', id: 'entry', call: { file: 'entry.ts' } },
      { do: 'release', id: 'shared' },
      {
        do: 'join',
        expect: {
          css: {
            shared: ['color:red-accent;'],
            entry: ['background:red-accent;'],
          },
          prepared: ['entry.ts', 'shared.ts', 'tokens.ts'],
          evaluated: ['entry.ts', 'shared.ts', 'tokens.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'shared.ts' }, { file: 'entry.ts' }],
        note:
          'shared.ts готовится как корень ещё раз: его корневую публикацию ' +
          'заменила вычисленная копия-зависимость от entry.ts (один узел ' +
          'кэша на файл)',
        expect: {
          css: {
            'shared.ts': ['color:red-accent;'],
            'entry.ts': ['background:red-accent;'],
          },
          prepared: ['shared.ts'],
          evaluated: [],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'shared.ts' }, { file: 'entry.ts' }],
        expect: {
          css: {
            'shared.ts': ['color:red-accent;'],
            'entry.ts': ['background:red-accent;'],
          },
          ...fromCache,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'shared.ts' }],
        expect: { css: { 'shared.ts': ['color:red-accent;'] }, ...fromCache },
      },
      {
        do: 'write',
        files: { 'tokens.ts': "export const colors = { red: 'crimson' };\n" },
      },
      {
        do: 'transform',
        calls: [{ file: 'shared.ts' }, { file: 'entry.ts' }],
        expect: {
          css: {
            'shared.ts': ['color:crimson-accent;'],
            'entry.ts': ['background:crimson-accent;'],
          },
          prepared: ['entry.ts', 'shared.ts', 'tokens.ts'],
          evaluated: ['entry.ts', 'shared.ts', 'tokens.ts'],
        },
      },
    ],
  },
  {
    id: 'dependency-then-root',
    title: 'файл сначала зависимость, затем корень',
    refs: ['#427'],
    files: {
      'shared.ts': styled(
        [
          "import { colors } from './tokens';",
          '',
          'const mix = (color: string) => `${color}-mixed`;',
          'export const accent = mix(colors.red);',
        ],
        'color: ${accent};'
      ),
      'entry.ts': styled(
        ["import { accent } from './shared';"],
        'background: ${accent};'
      ),
      'tokens.ts': "export const colors = { red: 'red' };\n",
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'entry.ts' }],
        expect: {
          css: { 'entry.ts': ['background:red-mixed;'] },
          prepared: ['entry.ts', 'shared.ts', 'tokens.ts'],
          evaluated: ['entry.ts', 'shared.ts', 'tokens.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'shared.ts' }],
        note: 'корню нужен другой набор экспортов: подготовка заново, eval нет',
        expect: {
          css: { 'shared.ts': ['color:red-mixed;'] },
          prepared: ['shared.ts'],
          evaluated: [],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'entry.ts' }],
        expect: {
          css: { 'entry.ts': ['background:red-mixed;'] },
          ...fromCache,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'shared.ts' }],
        note: 'корень и зависимость больше не вытесняют друг друга',
        expect: { css: { 'shared.ts': ['color:red-mixed;'] }, ...fromCache },
      },
      {
        do: 'transform',
        calls: [{ file: 'entry.ts' }],
        expect: {
          css: { 'entry.ts': ['background:red-mixed;'] },
          ...fromCache,
        },
      },
      {
        do: 'write',
        files: { 'tokens.ts': "export const colors = { red: 'crimson' };\n" },
      },
      {
        do: 'transform',
        calls: [{ file: 'shared.ts' }],
        expect: {
          css: { 'shared.ts': ['color:crimson-mixed;'] },
          prepared: ['shared.ts', 'tokens.ts'],
          evaluated: ['shared.ts', 'tokens.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'entry.ts' }],
        expect: {
          css: { 'entry.ts': ['background:crimson-mixed;'] },
          prepared: ['entry.ts'],
          evaluated: ['entry.ts'],
        },
      },
    ],
  },
  {
    id: 'invalidation-cursor-api',
    title: 'общий курсор consumeInvalidation: два потребителя одного файла',
    refs: ['#411'],
    files: { 'dep.ts': runtimeValue('color', 'blue') },
    steps: [
      { do: 'invalidate', files: ['dep.ts'] },
      {
        do: 'consumeInvalidation',
        file: 'dep.ts',
        note: 'первый потребитель',
        expect: { consumed: true },
      },
      {
        do: 'consumeInvalidation',
        file: 'dep.ts',
        note: 'второй потребитель того же файла',
        expect: { consumed: false },
        knownBug: {
          impact: 'correctness',
          description:
            'Курсор один на имя файла, а не на потребителя: второй ' +
            'потребитель (второй eval-брокер на том же кэше, module.ts) не ' +
            'узнаёт об инвалидации, которую уже забрал первый. См. ' +
            'invalidation-cursor-two-brokers.',
          intended: { consumed: true },
        },
      },
      {
        do: 'consumeInvalidation',
        file: 'dep.ts?raw',
        note: 'у каждого ?query-варианта свой курсор',
        expect: { consumed: true },
      },
      { do: 'invalidate', files: ['dep.ts'] },
      {
        do: 'consumeInvalidation',
        file: 'dep.ts',
        expect: { consumed: true },
      },
    ],
  },
  {
    id: 'invalidation-cursor-two-brokers',
    title: 'общий курсор consumeInvalidation: два eval-брокера на одном кэше',
    refs: ['#411', '#427'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    sessions: {
      a: { evalBrokerScope: 'a' },
      b: { evalBrokerScope: 'b' },
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'a' }],
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: ['dep.ts', 'root.ts'],
          evaluated: ['dep.ts', 'root.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'b' }],
        note: 'подготовка общая (кэш), eval — в своём раннере',
        expect: {
          css: { 'root.ts': ['color:blue;'] },
          prepared: [],
          evaluated: ['dep.ts', 'root.ts'],
        },
      },
      { do: 'write', files: { 'dep.ts': runtimeValue('color', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'a' }],
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['dep.ts', 'root.ts'],
          evaluated: ['dep.ts', 'root.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts', session: 'b' }],
        expect: { css: { 'root.ts': ['color:blue;'] }, ...fromCache },
        knownBug: {
          impact: 'correctness',
          description:
            'Брокер b отдаёт закэшированный результат eval со старым ' +
            'значением: корень в общем кэше уже свежий (его пересобрал ' +
            'брокер a), а инвалидацию dep.ts забрал брокер a через общий ' +
            'курсор consumeInvalidation. Устаревший CSS.',
          intended: {
            css: { 'root.ts': ['color:red;'] },
            evaluated: ['dep.ts', 'root.ts'],
          },
        },
      },
    ],
  },
];
