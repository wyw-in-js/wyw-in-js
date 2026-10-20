import type { KnownBug, FreshnessScenario } from '../types';

import { fromCache, runtimeValue, staticValue, styled } from './sources';

const barrelRecovery = (
  description: string,
  intended: KnownBug['intended'] = {}
): KnownBug => ({
  impact: 'performance',
  description:
    `${description} Every repeated transform of a root whose import is ` +
    'rewritten to a runtime barrel leaf triggers the fail-closed recovery (a ' +
    'reset of the whole cache) and a full recomputation, even one with no ' +
    'changes right after the cold build. The likely cause: eval executes ' +
    'barrel.ts, which is never published as a prepared module, so its graph ' +
    'counts as unknown. Static leaves cause no recovery ' +
    '(barrel-static-leaf-edit).',
  intended: { reset: 'none', ...intended },
});

const accentOverPalette = [
  "import { base } from './palette';",
  '',
  'export const accent = (() => `${base}-accent`)();',
  '',
].join('\n');

/**
 * A styled module that re-exports `accent` from theme.ts with `reexport` and
 * uses it in its own style: a barrel for the re-exported name only.
 */
const reexportingStyled = (reexport: string): string =>
  styled(
    ["import { accent } from './theme';", reexport],
    'background: ${accent};'
  );

/** page.ts reads a value and the class of A.ts in its own style. */
const pageOverA = (value: string): string =>
  styled(
    [`import { ${value}, style as a } from './A';`],
    `color: \${${value}}; & .\${a} { color: \${${value}}; }`
  );

const reexportProject = (reexport: string, value = 'accent') => ({
  'page.ts': pageOverA(value),
  'A.ts': reexportingStyled(reexport),
  'theme.ts': accentOverPalette,
  'palette.ts': runtimeValue('base', 'blue'),
});

const pageCss = (color: string): string[] => [
  `color:${color}-accent;`,
  `color:${color}-accent;`,
];

const moduleCss = (color: string): string[] => [`background:${color}-accent;`];

const rootCopyNarrowed = (description: string): KnownBug => ({
  impact: 'performance',
  description:
    `${description} A.ts is prepared again although nothing changed: eval ` +
    'publishes an evaluated copy of A.ts with the accent export that page.ts ' +
    'requested in the same eval session, and the evaluatedOnly of the copy ' +
    'is overwritten with the list of serialized exports without __wywPreval. ' +
    'The next transform of A.ts cannot reuse such a copy.',
  intended: fromCache,
});

/** Barrel rewrites: named re-exports, `export *`, static re-export chains. */
export const barrelScenarios: FreshnessScenario[] = [
  {
    id: 'barrel-leaf-edit',
    title: 'barrel leaf edit (named re-exports)',
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
        note:
          'the import is rewritten to the leaf; barrel.ts is evaluated but ' +
          'not prepared',
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
          'Transform with no changes, before any edit.',
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
        knownBug: barrelRecovery('Edit of the used leaf.'),
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
          'Edit of an unused leaf: the root output does not depend on it.',
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
        knownBug: barrelRecovery('Transform with no changes.', fromCache),
      },
    ],
  },
  {
    id: 'barrel-retarget',
    title: 'the barrel points the re-export to another leaf',
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
        note:
          '#268: the barrel is an invalidation dependency of the rewritten ' +
          'import',
        expect: {
          css: { 'root.ts': ['color:black;'] },
          prepared: ['dark.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'dark.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery('Edit of the barrel itself.'),
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
          'Edit of a leaf the barrel no longer points to.',
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
        knownBug: barrelRecovery('Transform with no changes.', fromCache),
      },
    ],
  },
  {
    id: 'export-star-leaf-edit',
    title: 'edit of a leaf behind `export *`, twice',
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
        note:
          '#271: the barrel analysis cache depends on the leaves behind ' +
          '`export *`',
        expect: {
          css: { 'root.ts': ['color:black;'] },
          prepared: ['leaf.ts', 'root.ts'],
          evaluated: ['barrel.ts', 'leaf.ts', 'root.ts'],
          reset: 'recovery',
        },
        knownBug: barrelRecovery('Edit of the leaf behind `export *`.'),
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
        knownBug: barrelRecovery('Second edit of the leaf behind `export *`.'),
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
        knownBug: barrelRecovery('Transform with no changes.', fromCache),
      },
    ],
  },
  {
    id: 'barrel-static-leaf-edit',
    title: 'edit of a static barrel leaf',
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
        note: 'the value is resolved statically through the barrel',
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
        note: 'an edit of an unused leaf does not recompute the root',
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
    title: 'static re-export chain (analysis roots)',
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
        note: 'the value is resolved statically: the eval runner is not needed',
        expect: {
          css: { 'root.ts': ['color:red;'] },
          prepared: ['root.ts'],
          evaluated: [],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'root.ts' }],
        note: '#423: the links of the chain are a known graph, not a recovery',
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
  {
    id: 'reexported-value-used-importer-first',
    title: 'a module re-exports a value and uses it itself; importer first',
    refs: [],
    files: reexportProject("export { accent } from './theme';"),
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        note:
          'loading A.ts from the eval of page.ts carries __wywPreval: A.ts ' +
          'is prepared from its own code, no re-export proxy is built',
        expect: {
          css: { 'page.ts': pageCss('blue') },
          prepared: ['page.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'A.ts' }],
        note: 'the eval of A.ts takes the module prepared for page.ts',
        expect: {
          css: { 'A.ts': moduleCss('blue') },
          prepared: ['A.ts'],
          evaluated: [],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }, { file: 'A.ts' }],
        expect: {
          css: { 'page.ts': pageCss('blue'), 'A.ts': moduleCss('blue') },
          ...fromCache,
        },
      },
      { do: 'write', files: { 'palette.ts': runtimeValue('base', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': pageCss('red') },
          prepared: ['page.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'A.ts' }],
        expect: {
          css: { 'A.ts': moduleCss('red') },
          prepared: ['A.ts'],
          evaluated: ['A.ts'],
        },
        knownBug: {
          impact: 'performance',
          description:
            'The code of A.ts goes to the eval runner again, although the ' +
            'eval of page.ts on the previous step already evaluated the ' +
            'fresh A.ts. While preparing A.ts for the eval of page.ts, the ' +
            'broker creates the A.ts entrypoint anew; the freshness check ' +
            'finds its pre-edit publication stale and marks A.ts invalidated ' +
            'again, after this load has already taken the previous mark. ' +
            'Loading the root A.ts takes the remaining mark and resets the ' +
            'module in the runner.',
          intended: { evaluated: [] },
        },
      },
    ],
  },
  {
    id: 'reexported-value-renamed-importer-first',
    title: 'the same with a rename in the re-export',
    refs: [],
    files: reexportProject("export { accent as tone } from './theme';", 'tone'),
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': pageCss('blue') },
          prepared: ['page.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'A.ts' }],
        expect: {
          css: { 'A.ts': moduleCss('blue') },
          prepared: ['A.ts'],
          evaluated: [],
        },
      },
    ],
  },
  {
    id: 'reexported-value-used-concurrently',
    title: 'the same, importer and module in parallel',
    refs: [],
    files: reexportProject("export { accent } from './theme';"),
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }, { file: 'A.ts' }],
        expect: {
          css: { 'page.ts': pageCss('blue'), 'A.ts': moduleCss('blue') },
          prepared: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
        },
      },
      { do: 'write', files: { 'palette.ts': runtimeValue('base', 'red') } },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }, { file: 'A.ts' }],
        expect: {
          css: { 'page.ts': pageCss('red'), 'A.ts': moduleCss('red') },
          prepared: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
        },
      },
    ],
  },
  {
    id: 'reexported-star-value-used-importer-first',
    title: 'the same through `export *`, importer first',
    refs: [],
    files: reexportProject("export * from './theme';"),
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        note: 'no proxy behind `export *`: A.ts is evaluated as a whole',
        expect: {
          css: { 'page.ts': pageCss('blue') },
          prepared: ['page.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'page.ts', 'palette.ts', 'theme.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'A.ts' }],
        expect: {
          css: { 'A.ts': moduleCss('blue') },
          prepared: ['A.ts'],
          evaluated: [],
        },
      },
    ],
  },
  {
    id: 'reexported-value-used-module-first',
    title: 'a module re-exports a value and uses it itself; module first',
    refs: [],
    files: reexportProject("export { accent } from './theme';"),
    steps: [
      {
        do: 'transform',
        calls: [{ file: 'A.ts' }],
        expect: {
          css: { 'A.ts': moduleCss('blue') },
          prepared: ['A.ts', 'palette.ts', 'theme.ts'],
          evaluated: ['A.ts', 'palette.ts', 'theme.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'page.ts' }],
        expect: {
          css: { 'page.ts': pageCss('blue') },
          prepared: ['page.ts'],
          evaluated: ['A.ts', 'page.ts'],
        },
      },
      {
        do: 'transform',
        calls: [{ file: 'A.ts' }],
        note: 'repeated transform of A.ts in the same eval session as page.ts',
        expect: {
          css: { 'A.ts': moduleCss('blue') },
          prepared: ['A.ts'],
          evaluated: [],
        },
        knownBug: rootCopyNarrowed('Transform with no changes.'),
      },
    ],
  },
];
