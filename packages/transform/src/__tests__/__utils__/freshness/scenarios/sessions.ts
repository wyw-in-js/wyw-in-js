import type { FreshnessScenario, KnownBug } from '../types';

import { fromCache, rootWithDep, runtimeValue, styled } from './sources';

const fullRecompute = {
  prepared: ['dep.ts', 'root.ts'],
  evaluated: ['dep.ts', 'root.ts'],
};

const loaderRootRecompute: KnownBug = {
  impact: 'performance',
  description:
    'After an edit of a dependency that comes from loadDependencyCode, the ' +
    'next repeated transform of the root prepares and evaluates the root ' +
    'once more (the dependency itself comes from the cache): the new loader ' +
    'code is reported as a second change after the root has already taken ' +
    'the disk edit into account.',
  intended: fromCache,
};

/**
 * page.ts → card.ts → image.ts. The bundler hands the image.ts root code that
 * a loader before wyw changed (like Storybook's react-docgen-loader), so its
 * own CSS shows `-loaded`; its exports keep their values.
 */
const loaderChain = (size: string): Record<string, string> => ({
  'image.ts': styled(
    [`export const size = (() => '${size}')();`],
    'width: ${size}; outline: none-disk;'
  ),
  'card.ts': styled(
    [
      "import { size } from './image';",
      '',
      'export const cardSize = (() => `${size}-card`)();',
    ],
    'height: ${cardSize};'
  ),
  'page.ts': styled(
    ["import { cardSize } from './card';"],
    'min-height: ${cardSize};'
  ),
});

const chainRecompute = {
  prepared: ['card.ts', 'image.ts', 'page.ts'],
  evaluated: ['card.ts', 'image.ts', 'page.ts'],
};

/**
 * page.ts and page2.ts read `accent` and the class of A.ts, which re-exports
 * `accent` from theme.ts and uses it in its own style. palette.ts carries a
 * `-disk` marker in a comment only: a loader that rewrites it changes the
 * code, not the value.
 */
const reexportOverLoadedPalette = (base: string): Record<string, string> => ({
  'palette.ts': `${runtimeValue('base', base)}// none-disk\n`,
  'theme.ts': [
    "import { base } from './palette';",
    '',
    'export const accent = (() => `${base}-accent`)();',
    '',
  ].join('\n'),
  'A.ts': styled(
    ["import { accent } from './theme';", "export { accent } from './theme';"],
    'background: ${accent};'
  ),
  'page.ts': styled(
    ["import { accent, style as a } from './A';"],
    'color: ${accent}; & .${a} { margin: 0; }'
  ),
  'page2.ts': styled(
    ["import { accent, style as a } from './A';"],
    'border-color: ${accent}; & .${a} { margin: 0; }'
  ),
});

/**
 * What a transform runs with: the cache salt (resolver, options), the
 * bundler-provided code of roots and dependencies, request variants and
 * explicit invalidation.
 */
export const sessionScenarios: FreshnessScenario[] = [
  {
    id: 'salt-resolver-key',
    title: 'salt change: another resolver key and back to the previous one',
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
        note:
          'the cache holds one salt at a time: going back to the previous ' +
          'one resets everything again',
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
    title: 'salt change: plugin options',
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
        note:
          'the salt is computed from the content of the options, not from ' +
          'the object identity',
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
    title:
      'without asyncResolveKey the salt depends on the identity of the ' +
      'resolver function',
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
        note: 'API contract: a new keyless resolver function is a new salt',
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
    title: 'dependency code from loadDependencyCode differs from the disk',
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
        note: 'the loader code is evaluated, not the bytes on disk',
        expect: {
          css: { 'root.ts': ['color:blue-loaded;'] },
          ...fullRecompute,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note:
          '#234, #422: the "loader ≠ disk" mismatch neither invalidates ' +
          'dep.ts nor recomputes the root',
        expect: { css: { 'root.ts': ['color:blue-loaded;'] }, ...fromCache },
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
    title: 'dependency first from the loader, then from the disk and back',
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
          '#427: the bytes on disk did not change, so the previous loader ' +
          'code is reused',
        expect: { css: { 'root.ts': ['color:blue-loaded;'] }, ...fromCache },
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
          'the revision on disk is the same: the root comes from the cache, ' +
          'the loader is not asked, and the evaluated disk code stays (the ' +
          'same loadDependencyCodeKey promises the same semantics)',
        expect: { css: { 'root.ts': ['color:red-disk;'] }, ...fromCache },
      },
    ],
  },
  {
    id: 'root-loaded-source',
    title: 'root code from the bundler differs from the disk',
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
    id: 'loaded-root-after-importers',
    title:
      'root with loader code (≠ disk) after importers that read it from the ' +
      'disk',
    refs: ['#422', '#427'],
    files: loaderChain('16px'),
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': ['min-height:16px-card;'] },
          ...chainRecompute,
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'image.ts', source: 'loaded' }],
        note: 'the root evaluates the loader code, not the bytes on disk',
        expect: {
          css: { 'image.ts': ['width:16px;outline:none-loaded;'] },
          prepared: ['image.ts'],
          evaluated: ['image.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        note:
          '#422: the disk did not change, so the loader code is no news to ' +
          'the importers: no eviction cascade and no recovery',
        expect: { css: { 'page.ts': ['min-height:16px-card;'] }, ...fromCache },
      },
    ],
  },
  {
    id: 'loaded-root-importer-in-flight',
    title:
      'root with loader code (≠ disk) while an importer root waits for eval',
    refs: ['#422', '#427'],
    files: loaderChain('16px'),
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': ['min-height:16px-card;'] },
          ...chainRecompute,
        },
      },
      {
        do: 'start',
        id: 'card',
        call: { file: 'card.ts' },
        hold: { at: 'eval' },
      },
      {
        do: 'transform',
        calls: [{ file: 'image.ts', source: 'loaded' }],
        note: 'includes the preparation of the held root card.ts',
        expect: {
          css: { 'image.ts': ['width:16px;outline:none-loaded;'] },
          prepared: ['card.ts', 'image.ts'],
          evaluated: ['image.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        note:
          '#422: the freshness check of page.ts does not evict the held root ' +
          'card.ts',
        expect: { css: { 'page.ts': ['min-height:16px-card;'] }, ...fromCache },
      },
      { do: 'release', id: 'card' },
      {
        do: 'join',
        note: 'the root card.ts is not restarted',
        expect: { css: { card: ['height:16px-card;'] }, ...fromCache },
      },
    ],
  },
  {
    id: 'loaded-root-after-edit',
    title:
      'file edit between an importer reading it from the disk and the ' +
      'arrival of the root with loader code',
    refs: ['#422', '#427'],
    files: loaderChain('16px'),
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': ['min-height:16px-card;'] },
          ...chainRecompute,
        },
      },
      { do: 'write', files: { 'image.ts': loaderChain('20px')['image.ts'] } },
      {
        do: 'transform',
        calls: [{ file: 'image.ts', source: 'loaded' }],
        expect: {
          css: { 'image.ts': ['width:20px;outline:none-loaded;'] },
          prepared: ['image.ts'],
          evaluated: ['image.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        note:
          'the disk no longer matches what the importers read: the edit ' +
          'reaches them, even though the root check saw it first',
        expect: {
          css: { 'page.ts': ['min-height:20px-card;'] },
          prepared: ['card.ts', 'page.ts'],
          evaluated: ['card.ts', 'page.ts'],
        },
      },
    ],
  },
  {
    id: 'loaded-root-after-edit-and-invalidation',
    title:
      'edit and invalidateForFile of a file, another importer reads its new ' +
      'bytes, then the root with loader code',
    refs: ['#422', '#427'],
    files: {
      ...loaderChain('16px'),
      'card2.ts': styled(
        ["import { size } from './image';"],
        'max-height: ${size};'
      ),
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': ['min-height:16px-card;'] },
          ...chainRecompute,
        },
      },
      { do: 'write', files: { 'image.ts': loaderChain('20px')['image.ts'] } },
      { do: 'invalidate', files: ['image.ts'] },
      {
        do: 'transform',
        calls: [{ file: 'card2.ts' }],
        note: 'records the new image.ts byte hash without a change version',
        expect: {
          css: { 'card2.ts': ['max-height:20px;'] },
          prepared: ['card2.ts', 'image.ts'],
          evaluated: ['card2.ts', 'image.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'image.ts', source: 'loaded' }],
        expect: {
          css: { 'image.ts': ['width:20px;outline:none-loaded;'] },
          prepared: ['image.ts'],
          evaluated: ['image.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        note:
          'the disk matches what was read last, but page.ts and card.ts read ' +
          'the previous bytes: after invalidateForFile the loader code is ' +
          'still reported as a change',
        expect: {
          css: { 'page.ts': ['min-height:20px-card;'] },
          prepared: ['card.ts', 'page.ts'],
          evaluated: ['card.ts', 'page.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'card.ts' }],
        expect: {
          css: { 'card.ts': ['height:20px-card;'] },
          prepared: ['card.ts'],
          evaluated: [],
        },
      },
    ],
  },
  {
    id: 'loaded-dependency-reexport-second-edit',
    title:
      'second edit of a transitive dependency from loadDependencyCode behind ' +
      'a re-export of a styled module, with another importer built between ' +
      'the edits',
    refs: ['#263', '#422'],
    files: reexportOverLoadedPalette('blue'),
    sessions: {
      default: { loader: { key: 'loader', files: { 'palette.ts': 'loaded' } } },
    },
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': ['color:blue-accent;', 'margin:0;'] },
          prepared: ['page.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'page2.ts' }],
        expect: {
          css: { 'page2.ts': ['border-color:blue-accent;', 'margin:0;'] },
          prepared: ['page2.ts'],
          evaluated: ['page2.ts'],
        },
      },
      {
        do: 'write',
        files: { 'palette.ts': reexportOverLoadedPalette('red')['palette.ts'] },
      },
      {
        do: 'transform',
        calls: [{ file: 'page2.ts' }],
        expect: {
          css: { 'page2.ts': ['border-color:red-accent;', 'margin:0;'] },
          prepared: ['page2.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page2.ts', 'palette.ts', 'theme.ts'],
          reset: 'recovery',
        },
        knownBug: {
          impact: 'performance',
          description:
            'Rebuilding page2.ts after the palette.ts edit triggers the ' +
            'fail-closed recovery (a reset of the whole cache). The same ' +
            'happens without the loader; the cause has not been investigated ' +
            'in this row.',
          intended: { reset: 'none' },
        },
      },
      {
        do: 'write',
        files: {
          'palette.ts': reexportOverLoadedPalette('green')['palette.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': ['color:red-accent;', 'margin:0;'] },
          prepared: ['page.ts'],
          evaluated: ['page.ts'],
        },
        knownBug: {
          impact: 'correctness',
          description:
            'The second edit of a transitive dependency does not reach ' +
            'page.ts if only page2.ts saw the first one: page.ts is rebuilt, ' +
            'but palette.ts, theme.ts and A.ts do not reach the eval runner ' +
            'again, and it takes their values after the first edit (red ' +
            'instead of green). A loader that returns the bytes on disk and ' +
            'a build without a loader go stale here the same way, including ' +
            'before the #422 fix. With loader code that differs from the ' +
            'disk, the row was fresh before #422: that code was reported as ' +
            'a change of palette.ts and evicted its importers.',
          intended: {
            css: { 'page.ts': ['color:green-accent;', 'margin:0;'] },
            evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
          },
        },
      },
    ],
  },
  {
    id: 'query-variants',
    title: 'variants of one file with ?query / #hash',
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
        note: 'each variant is a separate cache node',
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
            'Two variants of the root, rebuilt in parallel after an edit of ' +
            'a shared dependency, trigger the fail-closed recovery (a reset ' +
            'of the whole cache).',
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
    title: 'explicit invalidation (invalidateForFile, as in Vite HMR)',
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
        note: 'an eviction without a content change forces no recomputation',
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
