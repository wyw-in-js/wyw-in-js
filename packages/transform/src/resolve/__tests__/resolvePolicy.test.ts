/* eslint-disable no-await-in-loop */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import type { EvalResolverMode } from '@wyw-in-js/shared';

import {
  classifyResolvedId,
  getNativeFallbackPolicy,
  normalizeResolvedId,
  resolveWithPolicy,
  type BundlerResolverAdapter,
  type CustomResolverAdapter,
  type NativeResolverAdapter,
  type ResolvePolicySettings,
  type ResolveRequest,
  type ResolveTraceEvent,
} from '../resolvePolicy';

const importer = '/project/src/entry.ts';

const request = (
  specifier: string,
  overrides: Partial<ResolveRequest> = {}
): ResolveRequest => ({
  importer,
  kind: 'import',
  specifier,
  stack: [importer],
  ...overrides,
});

type Fakes = {
  bundler: jest.Mock<
    ReturnType<BundlerResolverAdapter>,
    Parameters<BundlerResolverAdapter>
  >;
  custom?: jest.Mock<
    ReturnType<CustomResolverAdapter>,
    Parameters<CustomResolverAdapter>
  >;
  native: jest.Mock<
    ReturnType<NativeResolverAdapter>,
    Parameters<NativeResolverAdapter>
  >;
};

const notResolvable = (specifier: string) => () => {
  throw new Error(`Cannot find module '${specifier}'`);
};

const fakes = ({
  bundler = async () => null,
  custom,
  native,
}: {
  bundler?: BundlerResolverAdapter;
  custom?: CustomResolverAdapter;
  native?: NativeResolverAdapter;
} = {}): Fakes => ({
  bundler: jest.fn(bundler),
  custom: custom ? jest.fn(custom) : undefined,
  native: jest.fn(native ?? notResolvable('fake')),
});

const prepare = (
  mode: EvalResolverMode | undefined,
  extra: Partial<ResolvePolicySettings> = {}
): ResolvePolicySettings => ({ mode, phase: 'prepare', ...extra });

const evalPhase = (
  mode: EvalResolverMode | undefined,
  extra: Partial<ResolvePolicySettings> = {}
): ResolvePolicySettings => ({
  extensions: ['.ts', '.js'],
  mode,
  phase: 'eval',
  require: 'warn-and-run',
  ...extra,
});

describe('resolveWithPolicy', () => {
  describe('custom resolver', () => {
    it('wins over native and bundler resolvers in every mode', async () => {
      const modes: EvalResolverMode[] = [
        'bundler',
        'hybrid',
        'native',
        'custom',
      ];

      for (const mode of modes) {
        for (const settings of [prepare(mode), evalPhase(mode)]) {
          const adapters = fakes({
            custom: async () => ({ id: '/project/src/custom.ts' }),
            native: () => '/project/src/native.ts',
            bundler: async () => '/project/src/bundler.ts',
          });

          await expect(
            resolveWithPolicy(request('./dep'), settings, adapters)
          ).resolves.toEqual({
            id: '/project/src/custom.ts',
            kind: 'file',
            via: 'custom',
          });
          expect(adapters.custom).toHaveBeenCalledWith(
            './dep',
            importer,
            'import'
          );
          expect(adapters.native).not.toHaveBeenCalled();
          expect(adapters.bundler).not.toHaveBeenCalled();
        }
      }
    });

    it('reports external results as an explicit external outcome', async () => {
      const adapters = fakes({
        custom: async () => ({ id: 'react', external: true }),
      });

      await expect(
        resolveWithPolicy(request('react'), prepare('bundler'), adapters)
      ).resolves.toEqual({ id: 'react', kind: 'external', via: 'custom' });
      expect(adapters.bundler).not.toHaveBeenCalled();
    });

    it('stops with not-found when custom mode misses', async () => {
      for (const settings of [prepare('custom'), evalPhase('custom')]) {
        const adapters = fakes({
          custom: async () => null,
          native: () => '/project/src/native.ts',
          bundler: async () => '/project/src/bundler.ts',
        });

        await expect(
          resolveWithPolicy(request('./dep'), settings, adapters)
        ).resolves.toEqual({ kind: 'not-found' });
        expect(adapters.native).not.toHaveBeenCalled();
        expect(adapters.bundler).not.toHaveBeenCalled();
      }
    });

    it('continues with the configured mode when a non-custom mode misses', async () => {
      const adapters = fakes({
        custom: async () => null,
        bundler: async () => '/project/src/bundler.ts',
      });

      await expect(
        resolveWithPolicy(request('./dep'), prepare('bundler'), adapters)
      ).resolves.toEqual({
        id: '/project/src/bundler.ts',
        kind: 'file',
        via: 'bundler',
      });
    });

    it('reads a custom result once, id before external', async () => {
      const reads: string[] = [];
      const adapters = fakes({
        custom: async () => ({
          get id() {
            reads.push('id');
            return 'pkg';
          },
          get external() {
            reads.push('external');
            return true;
          },
        }),
      });

      await resolveWithPolicy(request('pkg'), evalPhase('bundler'), adapters);

      expect(reads).toEqual(['id', 'external']);
    });
  });

  describe('hybrid mode', () => {
    it('prefers the native resolver over the bundler', async () => {
      const adapters = fakes({
        native: () => '/project/node_modules/dep/index.js',
        bundler: async () => '/project/src/bundler.ts',
      });

      await expect(
        resolveWithPolicy(request('dep'), prepare('hybrid'), adapters)
      ).resolves.toEqual({
        id: '/project/node_modules/dep/index.js',
        kind: 'file',
        via: 'native',
      });
      expect(adapters.native).toHaveBeenCalledWith({
        importer,
        kind: 'import',
        specifier: 'dep',
      });
      expect(adapters.bundler).not.toHaveBeenCalled();
    });

    it('lets the bundler handle what the native resolver cannot', async () => {
      const trace = jest.fn();
      const adapters = fakes({
        native: notResolvable('~alias/dep'),
        bundler: async () => '/project/src/aliased.ts',
      });

      await expect(
        resolveWithPolicy(
          request('~alias/dep'),
          evalPhase('hybrid', { trace }),
          adapters
        )
      ).resolves.toEqual({
        id: '/project/src/aliased.ts',
        kind: 'file',
        via: 'bundler',
      });
      expect(adapters.bundler).toHaveBeenCalledWith(request('~alias/dep'));
      expect(trace).toHaveBeenCalledWith(
        expect.objectContaining({ specifier: '~alias/dep' }),
        expect.objectContaining({
          step: 'native-miss',
          error: expect.objectContaining({
            message: expect.stringContaining(
              'Native resolver failed during eval'
            ),
          }),
        })
      );
    });

    it('never falls back to native after a bundler miss', async () => {
      const adapters = fakes({ bundler: async () => null });

      await expect(
        resolveWithPolicy(request('dep'), evalPhase('hybrid'), adapters)
      ).resolves.toEqual({ kind: 'not-found' });
      expect(adapters.native).toHaveBeenCalledTimes(1);
    });
  });

  describe('native mode', () => {
    it('uses only the native resolver', async () => {
      const adapters = fakes({ native: () => '/project/src/dep.ts' });

      await expect(
        resolveWithPolicy(request('./dep'), prepare('native'), adapters)
      ).resolves.toEqual({
        id: '/project/src/dep.ts',
        kind: 'file',
        via: 'native',
      });
      expect(adapters.bundler).not.toHaveBeenCalled();
    });

    it('surfaces the raw native error during prepare', async () => {
      const adapters = fakes({ native: notResolvable('./missing') });

      await expect(
        resolveWithPolicy(request('./missing'), prepare('native'), adapters)
      ).rejects.toThrow("Cannot find module './missing'");
      expect(adapters.bundler).not.toHaveBeenCalled();
    });

    it('wraps the native error with the import site during eval', async () => {
      const adapters = fakes({ native: notResolvable('./missing') });

      await expect(
        resolveWithPolicy(request('./missing'), evalPhase('native'), adapters)
      ).rejects.toThrow(
        [
          `[wyw-in-js] Native resolver failed during eval.`,
          ``,
          `importer: ${importer}`,
          `source:   ./missing`,
          ``,
          `error: Cannot find module './missing'`,
        ].join('\n')
      );
    });
  });

  describe('bundler mode', () => {
    it('treats a bundler miss as not-found during prepare', async () => {
      const adapters = fakes({ native: () => '/project/src/dep.ts' });

      await expect(
        resolveWithPolicy(request('./dep'), prepare('bundler'), adapters)
      ).resolves.toEqual({ kind: 'not-found' });
      expect(adapters.native).not.toHaveBeenCalled();
    });

    it('falls back to the native resolver during eval', async () => {
      const adapters = fakes({ native: () => '/project/src/dep.ts' });

      await expect(
        resolveWithPolicy(request('./dep'), evalPhase('bundler'), adapters)
      ).resolves.toEqual({
        id: '/project/src/dep.ts',
        kind: 'file',
        via: 'native-fallback',
      });
    });

    it('does not fall back when eval.require is off', async () => {
      const adapters = fakes({ native: () => '/project/src/dep.ts' });

      await expect(
        resolveWithPolicy(
          request('./dep'),
          evalPhase('bundler', { require: 'off' }),
          adapters
        )
      ).resolves.toEqual({ kind: 'not-found' });
      expect(adapters.native).not.toHaveBeenCalled();
    });

    it('treats an empty bundler id as a miss', async () => {
      const adapters = fakes({ bundler: async () => '' });

      await expect(
        resolveWithPolicy(request('./dep'), prepare('bundler'), adapters)
      ).resolves.toEqual({ kind: 'not-found' });
    });

    it('leaves bundler errors to the adapter owner', async () => {
      const adapters = fakes({
        bundler: async () => {
          throw new Error('bundler exploded');
        },
      });

      await expect(
        resolveWithPolicy(request('./dep'), evalPhase('bundler'), adapters)
      ).rejects.toThrow('bundler exploded');
      expect(adapters.native).not.toHaveBeenCalled();
    });

    it('passes the importer stack to the bundler', async () => {
      const adapters = fakes({ bundler: async () => '/project/src/dep.ts' });
      const stacked = request('./dep', {
        importer: '/project/src/child.ts',
        stack: ['/project/src/child.ts', importer],
      });

      await resolveWithPolicy(stacked, prepare('bundler'), adapters);

      expect(adapters.bundler).toHaveBeenCalledWith(stacked);
    });
  });

  describe('custom mode without a custom resolver', () => {
    it('keeps the prepare-stage bundler fallback', async () => {
      const adapters = fakes({ bundler: async () => '/project/src/dep.ts' });

      await expect(
        resolveWithPolicy(request('./dep'), prepare('custom'), adapters)
      ).resolves.toEqual({
        id: '/project/src/dep.ts',
        kind: 'file',
        via: 'bundler',
      });
    });

    it('resolves nothing during eval', async () => {
      const adapters = fakes({ bundler: async () => '/project/src/dep.ts' });

      await expect(
        resolveWithPolicy(request('./dep'), evalPhase('custom'), adapters)
      ).resolves.toEqual({ kind: 'not-found' });
      expect(adapters.bundler).not.toHaveBeenCalled();
    });
  });

  describe('outcome kinds', () => {
    it('classifies bundler-owned ids as virtual', async () => {
      const adapters = fakes({ bundler: async () => '\0virtual:theme' });

      await expect(
        resolveWithPolicy(
          request('virtual:theme'),
          prepare('bundler'),
          adapters
        )
      ).resolves.toEqual({
        id: '\0virtual:theme',
        kind: 'virtual',
        via: 'bundler',
      });
    });
  });

  describe('eval-phase id normalization', () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(path.join(tmpdir(), 'wyw-resolve-policy-'));
      mkdirSync(path.join(root, 'src'), { recursive: true });
      writeFileSync(path.join(root, 'src', 'dep.ts'), 'export {};');
    });

    afterEach(() => {
      rmSync(root, { force: true, recursive: true });
    });

    it('normalizes every resolved id during eval only', async () => {
      const extensionless = path.join(root, 'src', 'dep');
      const steps: Array<{
        mode: EvalResolverMode;
        adapters: () => Fakes;
      }> = [
        {
          mode: 'custom',
          adapters: () =>
            fakes({ custom: async () => ({ id: extensionless }) }),
        },
        {
          mode: 'native',
          adapters: () => fakes({ native: () => extensionless }),
        },
        {
          mode: 'bundler',
          adapters: () => fakes({ bundler: async () => extensionless }),
        },
      ];

      for (const { mode, adapters } of steps) {
        const entry = path.join(root, 'src', 'entry.ts');
        const evalOutcome = await resolveWithPolicy(
          request('./dep', { importer: entry, stack: [entry] }),
          evalPhase(mode),
          adapters()
        );
        const prepareOutcome = await resolveWithPolicy(
          request('./dep', { importer: entry, stack: [entry] }),
          prepare(mode),
          adapters()
        );

        expect(evalOutcome).toMatchObject({
          id: `${extensionless}.ts`,
          kind: 'file',
        });
        expect(prepareOutcome).toMatchObject({ id: extensionless });
      }
    });

    it('traces each eval step with raw and normalized ids', async () => {
      const trace = jest.fn<void, [ResolveRequest, ResolveTraceEvent]>();
      const entry = path.join(root, 'src', 'entry.ts');
      const extensionless = path.join(root, 'src', 'dep');

      await resolveWithPolicy(
        request('./dep', { importer: entry, stack: [entry] }),
        evalPhase('bundler', { trace }),
        fakes({ bundler: async () => extensionless })
      );

      expect(trace.mock.calls.map(([, event]) => event)).toEqual([
        {
          step: 'bundler',
          id: extensionless,
          normalized: `${extensionless}.ts`,
        },
      ]);
    });

    it('traces the end of an empty cascade', async () => {
      const trace = jest.fn<void, [ResolveRequest, ResolveTraceEvent]>();

      await resolveWithPolicy(
        request('./dep'),
        evalPhase('hybrid', { trace }),
        fakes()
      );

      expect(trace.mock.calls.map(([, event]) => event.step)).toEqual([
        'native-miss',
        'none',
      ]);
    });
  });
});

describe('normalizeResolvedId', () => {
  let root: string;
  let entry: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wyw-resolve-normalize-'));
    mkdirSync(path.join(root, 'src', 'folder'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'dep.ts'), 'export {};');
    writeFileSync(path.join(root, 'src', 'folder', 'index.js'), 'export {};');
    entry = path.join(root, 'src', 'entry.ts');
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  const context = (native: NativeResolverAdapter = notResolvable('x')) => ({
    extensions: ['.ts', '.js'],
    native: jest.fn(native),
  });

  it('keeps ids that already have an extension', () => {
    const ctx = context();

    expect(
      normalizeResolvedId(
        '/somewhere/dep.ts?raw',
        { importer: entry, kind: 'import', specifier: './dep' },
        ctx
      )
    ).toBe('/somewhere/dep.ts?raw');
    expect(ctx.native).not.toHaveBeenCalled();
  });

  it('probes configured extensions and index files, keeping the suffix', () => {
    const ctx = context();

    expect(
      normalizeResolvedId(
        './dep?inline',
        { importer: entry, kind: 'import', specifier: './dep?inline' },
        ctx
      )
    ).toBe(`${path.join(root, 'src', 'dep.ts')}?inline`);
    expect(
      normalizeResolvedId(
        path.join(root, 'src', 'folder'),
        { importer: entry, kind: 'import', specifier: './folder' },
        ctx
      )
    ).toBe(path.join(root, 'src', 'folder', 'index.js'));
  });

  it('asks the native adapter when probing finds nothing', () => {
    const ctx = context(() => '/elsewhere/real.mjs');

    expect(
      normalizeResolvedId(
        path.join(root, 'src', 'missing'),
        { importer: `${entry}?query`, kind: 'require', specifier: './missing' },
        ctx
      )
    ).toBe('/elsewhere/real.mjs');
    expect(ctx.native).toHaveBeenCalledWith({
      importer: entry,
      kind: 'require',
      specifier: path.join(root, 'src', 'missing'),
    });
  });

  it('keeps the id and traces when the native adapter misses', () => {
    const ctx = context();
    const trace = jest.fn();
    const missing = path.join(root, 'src', 'missing');

    expect(
      normalizeResolvedId(
        missing,
        { importer: entry, kind: 'import', specifier: './missing' },
        { ...ctx, trace }
      )
    ).toBe(missing);
    expect(trace).toHaveBeenCalledWith(
      { importer: entry, kind: 'import', specifier: './missing' },
      expect.objectContaining({ step: 'normalize-miss' })
    );
  });

  it('keeps package ids untouched', () => {
    const ctx = context();

    expect(
      normalizeResolvedId(
        'react',
        { importer: entry, kind: 'import', specifier: 'react' },
        ctx
      )
    ).toBe('react');
    expect(ctx.native).not.toHaveBeenCalled();
  });
});

describe('classifyResolvedId', () => {
  it.each([
    ['/project/src/dep.ts', 'file'],
    ['/project/src/dep.ts?raw#hash', 'file'],
    ['\0virtual-id', 'virtual'],
    ['virtual:theme', 'virtual'],
    ['/@id/__x00__virtual', 'virtual'],
    ['node:fs', 'virtual'],
  ])('%s is %s', (id, kind) => {
    expect(classifyResolvedId(id)).toBe(kind);
  });
});

describe('getNativeFallbackPolicy', () => {
  it('derives the policy from eval.require', () => {
    expect(getNativeFallbackPolicy('warn-and-run', undefined)).toBe('warn');
    expect(getNativeFallbackPolicy('error', undefined)).toBe('error');
    expect(getNativeFallbackPolicy('off', undefined)).toBe('error');
  });

  it('allows imports covered by an override without an unknown policy', () => {
    expect(getNativeFallbackPolicy('error', { noShake: true })).toBe('allow');
    expect(getNativeFallbackPolicy('warn-and-run', { mock: './m' })).toBe(
      'allow'
    );
  });

  it('lets the override choose, except that require: off always errors', () => {
    expect(getNativeFallbackPolicy('error', { unknown: 'warn' })).toBe('warn');
    expect(getNativeFallbackPolicy('warn-and-run', { unknown: 'allow' })).toBe(
      'allow'
    );
    expect(getNativeFallbackPolicy('off', { unknown: 'allow' })).toBe('error');
  });
});
