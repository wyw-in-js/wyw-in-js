import type { HostSession } from '../hostSession/types';
import { createHostSession } from '../index';

import { createFakeHostEngine } from './__utils__/fakeHostEngine';

// Bundlers hand the session ids with a query: a root may carry one, and so may
// what their resolver returns. The session matches files without the query,
// gives the watcher files on disk, and hands roots back as it got them.

const RESOLUTIONS: Readonly<Record<string, string | null>> = {
  './icon.svg?inline': '/p/icon.svg?inline',
  './icon.svg?raw': '/p/icon.svg?raw',
  './missing.svg?url': null,
  './theme.ts': '/p/theme.ts',
};

const FIRST_ROOT = '/p/root.ts?variant=1';
const SECOND_ROOT = '/p/root.ts?variant=2';

const engine = createFakeHostEngine({
  [FIRST_ROOT]: {
    result: () => ({
      code: 'export const root = "r1";\n',
      cssText: '.r1{color:red;}\n',
      dependencies: [
        './icon.svg?inline',
        './icon.svg?raw',
        './theme.ts',
        './missing.svg?url',
      ],
    }),
  },
  [SECOND_ROOT]: {
    result: () => ({
      code: 'export const root = "r2";\n',
      cssText: '.r2{color:blue;}\n',
      dependencies: ['./theme.ts'],
    }),
  },
});

let session: HostSession;

beforeEach(() => {
  session = createHostSession({
    bundler: {
      resolve: async ({ specifier }) => RESOLUTIONS[specifier] ?? null,
      root: '/p',
    },
    engine,
    onWarning: () => {},
    options: { configFile: false },
  });
});

afterEach(async () => {
  await session.close();
});

const transformRoot = (filename: string) =>
  session.transform({ code: 'export {};\n', filename });

describe('host session file names with a query', () => {
  it('lists each dependency once as a file on disk', async () => {
    const output = await transformRoot(FIRST_ROOT);

    expect(output.dependencies).toEqual(['/p/icon.svg', '/p/theme.ts']);
  });

  it('keeps the query of an unresolved specifier', async () => {
    const output = await transformRoot(FIRST_ROOT);

    expect(output.unresolved).toEqual(['./missing.svg?url']);
  });

  it('suggests a CSS id from the root without its query', async () => {
    const output = await transformRoot(FIRST_ROOT);

    expect(output.css?.suggestedId).toBe('/p/root.wyw-in-js.css');
  });

  it('matches changed files without the query and returns roots as given', async () => {
    await transformRoot(FIRST_ROOT);

    expect(session.invalidate(['/p/icon.svg'])).toEqual([FIRST_ROOT]);
    expect(session.invalidate(['/p/root.ts'])).toEqual([FIRST_ROOT]);
    expect(session.invalidate(['/p/other.ts'])).toEqual([]);
  });

  it('keeps two variants of one file as two roots', async () => {
    await transformRoot(FIRST_ROOT);
    await transformRoot(SECOND_ROOT);

    expect([...session.invalidate(['/p/theme.ts'])].sort()).toEqual([
      FIRST_ROOT,
      SECOND_ROOT,
    ]);
    expect(session.invalidate(['/p/icon.svg'])).toEqual([FIRST_ROOT]);
  });
});
