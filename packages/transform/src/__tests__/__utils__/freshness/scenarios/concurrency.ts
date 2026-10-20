import type { FreshnessScenario, KnownBug } from '../types';

import { fromCache, rootWithDep, runtimeValue, styled } from './sources';

const concurrentRecovery: KnownBug = {
  impact: 'performance',
  description:
    'Parallel transforms after an ordinary edit of a shared dependency ' +
    'trigger the fail-closed recovery: the whole cache is reset although the ' +
    'output is correct. Bundlers always transform modules in parallel.',
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

/** A styled module whose value export needs the eval runner. */
const styledWithRuntimeAccent = (color: string): string =>
  styled(
    [`export const accent = (() => '${color}')();`],
    'background: ${accent};'
  );

/** Concurrent transforms, supersede, the watch loop and shared caches. */
export const concurrencyScenarios: FreshnessScenario[] = [
  {
    id: 'concurrent-same-root',
    title: 'concurrent transforms of one file',
    refs: ['#427'],
    files: { 'root.ts': rootWithDep, 'dep.ts': runtimeValue('color', 'blue') },
    steps: [
      {
        do: 'transform',
        calls: [
          { file: 'root.ts', id: 'first' },
          { file: 'root.ts', id: 'second' },
        ],
        note: 'the two calls share one preparation and one eval',
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
    title: 'parallel roots with a shared dependency',
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
        note: '#423: a rebuild without edits does not trigger recovery',
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
    title: 'watch loop: parallel rebuild of all changed modules',
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
        note: 'the bundler rebuilds the changed file and all its importers',
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
          'unlike transitive-dep-edit, the second edit gets through: the ' +
          'intermediate modules are transformed too',
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
    title: 'root edit while its transform waits for eval (supersede)',
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
        note: 'includes the preparation of the held call up to the hold point',
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
            'A superseded transform call with the old code returns the CSS ' +
            'of the new revision of the file: the workflow restarts on ' +
            'supersededWith. This breaks the contract "the output matches ' +
            'the code passed in": a bundler with a persistent cache keyed by ' +
            'the input hash would store the output of the new revision under ' +
            'the old content. Debatable: the supersede mechanism is designed ' +
            'this way.',
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
      'a root is held in resolve while another root takes it as a dependency',
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
          'shared.ts is prepared as a root once more: its root publication ' +
          'was replaced by the evaluated dependency copy from entry.ts (one ' +
          'cache node per file)',
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
    title: 'a file is first a dependency, then a root',
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
        note: 'the root needs other exports: prepared again, no eval',
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
        note: 'the root and the dependency no longer evict each other',
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
    id: 'root-after-importer-evaluated-all',
    title: 'a root after an importer that evaluated all of its exports',
    refs: ['#427'],
    files: {
      'A.ts': styledWithRuntimeAccent('blue'),
      'page.ts': styled(
        ["import { accent, style as a } from './A';"],
        'color: ${accent}; & .${a} { color: ${accent}; }'
      ),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        note: 'page.ts publishes an evaluated copy of A.ts with all exports',
        expect: {
          css: { 'page.ts': ['color:blue;', 'color:blue;'] },
          prepared: ['A.ts', 'page.ts'],
          evaluated: ['A.ts', 'page.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'A.ts' }],
        note: 'the root A.ts reuses this copy instead of being prepared again',
        expect: {
          css: { 'A.ts': ['background:blue;'] },
          prepared: [],
          evaluated: [],
        },
      },
      { do: 'write', files: { 'A.ts': styledWithRuntimeAccent('red') } },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': ['color:red;', 'color:red;'] },
          prepared: ['A.ts', 'page.ts'],
          evaluated: ['A.ts', 'page.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'A.ts' }],
        expect: {
          css: { 'A.ts': ['background:red;'] },
          prepared: [],
          evaluated: [],
        },
      },
    ],
  },
  {
    id: 'root-and-importer-together-after-dependency-edit',
    title: 'a module and its importer in one round after a dependency edit',
    refs: ['#442'],
    files: {
      'A.ts': styled(
        ["import { theme } from './theme';", '', 'export { theme };'],
        'background: ${theme};'
      ),
      'page.ts': styled(
        ["import { theme, style as a } from './A';"],
        'color: ${theme}; & .${a} { margin: 0; }'
      ),
      'theme.ts': [
        "import { base } from './palette';",
        '',
        'export const theme = (() => `${base}-theme`)();',
        '',
      ].join('\n'),
      'palette.ts': runtimeValue('base', 'blue'),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': ['color:blue-theme;', 'margin:0;'] },
          prepared: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'A.ts' }],
        expect: { css: { 'A.ts': ['background:blue-theme;'] }, ...fromCache },
      },
      { do: 'write', files: { 'palette.ts': runtimeValue('base', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'A.ts' }, { file: 'page.ts' }],
        note:
          'the freshness check of page.ts evicts the new root A.ts and ' +
          'publishes A.ts again for its own import; the root restarts',
        expect: {
          css: {
            'A.ts': ['background:red-theme;'],
            'page.ts': ['color:red-theme;', 'margin:0;'],
          },
          prepared: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
        },
      },
    ],
  },
  {
    id: 'invalidation-cursor-api',
    title: 'shared consumeInvalidation cursor: two consumers of one file',
    refs: ['#411'],
    files: { 'dep.ts': runtimeValue('color', 'blue') },
    steps: [
      { do: 'invalidate', files: ['dep.ts'] },
      {
        do: 'consumeInvalidation',
        file: 'dep.ts',
        note: 'first consumer',
        expect: { consumed: true },
      },
      {
        do: 'consumeInvalidation',
        file: 'dep.ts',
        note: 'second consumer of the same file',
        expect: { consumed: false },
        knownBug: {
          impact: 'correctness',
          description:
            'There is one cursor per file name, not per consumer: the second ' +
            'consumer (a second eval broker on the same cache, module.ts) ' +
            'does not learn about an invalidation that the first one has ' +
            'already taken. See invalidation-cursor-two-brokers.',
          intended: { consumed: true },
        },
      },
      {
        do: 'consumeInvalidation',
        file: 'dep.ts?raw',
        note: 'every ?query variant has its own cursor',
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
    title: 'shared consumeInvalidation cursor: two eval brokers on one cache',
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
        note: 'preparation is shared (cache), eval runs in its own runner',
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
            'Broker b returns a cached eval result with the old value: the ' +
            'root in the shared cache is already fresh (broker a rebuilt ' +
            'it), and broker a took the dep.ts invalidation through the ' +
            'shared consumeInvalidation cursor. Stale CSS.',
          intended: {
            css: { 'root.ts': ['color:red;'] },
            evaluated: ['dep.ts', 'root.ts'],
          },
        },
      },
    ],
  },
];
