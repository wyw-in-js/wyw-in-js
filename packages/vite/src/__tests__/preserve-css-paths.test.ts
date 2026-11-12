const transformMock = jest.fn();

const loadWywInJS = () => import('../index?preserve-css-paths-test');

const createLogger = () => {
  const log = (() => undefined) as unknown as ((...args: unknown[]) => void) & {
    extend: (...args: unknown[]) => unknown;
  };

  log.extend = () => log;
  return log;
};

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  asyncResolverFactory: jest.fn(() => jest.fn()),
  logger: createLogger(),
  mergeOxcResolverAlias: (oxcOptions: any) => oxcOptions,
  syncResolve: jest.fn(),
  toNativeResolverAlias: jest.fn(() => ({})),
}));

jest.mock('vite', () => require('./viteMock').createViteMock());

jest.mock('@wyw-in-js/transform', () =>
  require('./transformMock').createTransformMock({
    transform: (...args: unknown[]) => transformMock(...args),
  })
);

describe('vite preserveCssPaths', () => {
  beforeEach(() => {
    transformMock.mockReset();
    transformMock.mockResolvedValue({
      code: 'export {}',
      sourceMap: null,
      cssText: undefined,
      dependencies: [],
    });
  });

  it('rewrites wyw css assets to preserve directories', async () => {
    const { default: wywInJS } = await loadWywInJS();

    const outputOptions = {
      preserveModules: true,
      preserveModulesRoot: '/project/src',
      assetFileNames: 'assets/[name].[hash].[ext]',
    };

    const plugin = wywInJS({ preserveCssPaths: true });
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: { rollupOptions: { output: outputOptions } },
    } as any);

    expect(typeof outputOptions.assetFileNames).toBe('function');

    expect(
      (outputOptions.assetFileNames as any)({
        name: 'src/components/button.wyw-in-js.css',
        type: 'asset',
      })
    ).toBe('assets/components/[name].[hash].[ext]');

    expect(
      (outputOptions.assetFileNames as any)({
        name: '/project/src/components/button.wyw-in-js.css',
        type: 'asset',
      })
    ).toBe('assets/components/[name].[hash].[ext]');

    expect(
      (outputOptions.assetFileNames as any)({
        name: 'src/styles/app.css',
        type: 'asset',
      })
    ).toBe('assets/[name].[hash].[ext]');
  });

  it('preserves hash-only assetFileNames templates', async () => {
    const { default: wywInJS } = await loadWywInJS();

    const outputOptions = {
      preserveModules: true,
      preserveModulesRoot: '/project/src',
      assetFileNames: 'assets/[hash].css',
    };

    const plugin = wywInJS({ preserveCssPaths: true });
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: { rollupOptions: { output: outputOptions } },
    } as any);

    expect(typeof outputOptions.assetFileNames).toBe('function');

    expect(
      (outputOptions.assetFileNames as any)({
        name: 'src/components/button.wyw-in-js.css',
        type: 'asset',
      })
    ).toBe('assets/components/[hash].css');

    expect(
      (outputOptions.assetFileNames as any)({
        name: 'src/styles/app.css',
        type: 'asset',
      })
    ).toBe('assets/[hash].css');
  });

  it('keeps fixed assetFileNames values intact', async () => {
    const { default: wywInJS } = await loadWywInJS();

    const outputOptions = {
      preserveModules: true,
      preserveModulesRoot: '/project/src',
      assetFileNames: 'assets/fixed.css',
    };

    const plugin = wywInJS({ preserveCssPaths: true });
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: { rollupOptions: { output: outputOptions } },
    } as any);

    expect(typeof outputOptions.assetFileNames).toBe('function');

    expect(
      (outputOptions.assetFileNames as any)({
        name: 'src/components/button.wyw-in-js.css',
        type: 'asset',
      })
    ).toBe('assets/fixed.css');
  });

  it('does not change output naming when preserveCssPaths is disabled', async () => {
    const { default: wywInJS } = await loadWywInJS();

    const outputOptions = {
      preserveModules: true,
      preserveModulesRoot: '/project/src',
      assetFileNames: 'assets/[name].[hash].[ext]',
    };

    const plugin = wywInJS();
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: { rollupOptions: { output: outputOptions } },
    } as any);

    expect(outputOptions.assetFileNames).toBe('assets/[name].[hash].[ext]');
  });

  it('restores root-level css imports for preserveModules library chunks', async () => {
    const { default: wywInJS } = await loadWywInJS();

    const outputOptions = {
      format: 'es',
      preserveModules: true,
      preserveModulesRoot: '/project/src',
    };

    const plugin = wywInJS({ preserveCssPaths: true });
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: {
        lib: { entry: '/project/src/index.ts', formats: ['es'] },
        cssCodeSplit: true,
        rollupOptions: { output: outputOptions },
      },
    } as any);

    transformMock.mockResolvedValueOnce({
      code: 'export const root = "root";',
      sourceMap: null,
      cssText: '.root { color: red; }',
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn(), warn: jest.fn() } as any,
      'export const root = "root";',
      '/project/src/index.ts'
    );

    const bundle = {
      'index.js': {
        type: 'chunk',
        fileName: 'index.js',
        code: '/* empty css */\nexport const root = "root";\n',
        facadeModuleId: '/project/src/index.ts',
      },
      'index.wyw-in-js.css': {
        type: 'asset',
        fileName: 'index.wyw-in-js.css',
        name: '/project/src/index.wyw-in-js.css',
        source: '.root { color: red; }',
      },
    };

    plugin.generateBundle?.(
      outputOptions as any,
      bundle as any,
      false as never
    );

    expect((bundle['index.js'] as any).code).toContain(
      'import "./index.wyw-in-js.css";'
    );
  });

  it('restores renamed root-level css imports for preserveModules chunks without build.lib', async () => {
    const { default: wywInJS } = await loadWywInJS();

    const outputOptions = {
      format: 'es',
      preserveModules: true,
      preserveModulesRoot: '/project/src',
    };

    const plugin = wywInJS({ preserveCssPaths: true });
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: {
        cssCodeSplit: true,
        rollupOptions: { output: outputOptions },
      },
    } as any);

    transformMock.mockResolvedValueOnce({
      code: 'export const root = "root";',
      sourceMap: null,
      cssText: '.root { color: red; }',
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn(), warn: jest.fn() } as any,
      'export const root = "root";',
      '/project/src/index.ts'
    );

    const bundle = {
      'index.js': {
        type: 'chunk',
        fileName: 'index.js',
        code: '/* empty css */\nexport const root = "root";\n',
        facadeModuleId: '/project/src/index.ts',
      },
      'index.css': {
        type: 'asset',
        fileName: 'index.css',
        name: '/project/src/index.wyw-in-js.css',
        source: '.root { color: red; }',
      },
    };

    plugin.generateBundle?.(
      outputOptions as any,
      bundle as any,
      false as never
    );

    expect((bundle['index.js'] as any).code).toContain('import "./index.css";');
  });

  it('does not inject css imports when preserveModules is disabled', async () => {
    const { default: wywInJS } = await loadWywInJS();

    const outputOptions = {
      format: 'es',
      preserveModules: false,
      preserveModulesRoot: '/project/src',
    };

    const plugin = wywInJS({ preserveCssPaths: true });
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: {
        cssCodeSplit: true,
        rollupOptions: { output: outputOptions },
      },
    } as any);

    transformMock.mockResolvedValueOnce({
      code: 'export const root = "root";',
      sourceMap: null,
      cssText: '.root { color: red; }',
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn(), warn: jest.fn() } as any,
      'export const root = "root";',
      '/project/src/index.ts'
    );

    const bundle = {
      'index.js': {
        type: 'chunk',
        fileName: 'index.js',
        code: '/* empty css */\nexport const root = "root";\n',
        facadeModuleId: '/project/src/index.ts',
      },
      'index.css': {
        type: 'asset',
        fileName: 'index.css',
        name: '/project/src/index.wyw-in-js.css',
        source: '.root { color: red; }',
      },
    };

    plugin.generateBundle?.(
      outputOptions as any,
      bundle as any,
      false as never
    );

    expect((bundle['index.js'] as any).code).not.toContain(
      'import "./index.css";'
    );
  });

  it('restores nested css imports for preserveModules library chunks', async () => {
    const { default: wywInJS } = await loadWywInJS();

    const outputOptions = {
      format: 'es',
      preserveModules: true,
      preserveModulesRoot: '/project/src',
    };

    const plugin = wywInJS({ preserveCssPaths: true });
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: {
        lib: { entry: '/project/src/index.ts', formats: ['es'] },
        cssCodeSplit: true,
        rollupOptions: { output: outputOptions },
      },
    } as any);

    transformMock.mockResolvedValueOnce({
      code: 'export const button = "button";',
      sourceMap: null,
      cssText: '.button { color: blue; }',
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn(), warn: jest.fn() } as any,
      'export const button = "button";',
      '/project/src/nested/button.ts'
    );

    const bundle = {
      'nested/button.js': {
        type: 'chunk',
        fileName: 'nested/button.js',
        code: 'export const button = "button";\n',
        facadeModuleId: '/project/src/nested/button.ts',
      },
      'nested/button.wyw-in-js.css': {
        type: 'asset',
        fileName: 'nested/button.wyw-in-js.css',
        name: 'src/nested/button.wyw-in-js.css',
        source: '.button { color: blue; }',
      },
    };

    plugin.generateBundle?.(
      outputOptions as any,
      bundle as any,
      false as never
    );

    expect((bundle['nested/button.js'] as any).code).toContain(
      'import "./button.wyw-in-js.css";'
    );
  });

  it('does not inject css imports when no wyw css asset is emitted', async () => {
    const { default: wywInJS } = await loadWywInJS();

    const outputOptions = {
      format: 'es',
      preserveModules: true,
      preserveModulesRoot: '/project/src',
    };

    const plugin = wywInJS({ preserveCssPaths: true });
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: {
        lib: { entry: '/project/src/index.ts', formats: ['es'] },
        cssCodeSplit: true,
        rollupOptions: { output: outputOptions },
      },
    } as any);

    transformMock.mockResolvedValueOnce({
      code: 'export const plain = "plain";',
      sourceMap: null,
      cssText: '.plain { color: inherit; }',
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn(), warn: jest.fn() } as any,
      'export const plain = "plain";',
      '/project/src/plain.ts'
    );

    const bundle = {
      'plain.js': {
        type: 'chunk',
        fileName: 'plain.js',
        code: 'export const plain = "plain";\n',
        facadeModuleId: '/project/src/plain.ts',
      },
    };

    plugin.generateBundle?.(
      outputOptions as any,
      bundle as any,
      false as never
    );

    expect((bundle['plain.js'] as any).code).toBe(
      'export const plain = "plain";\n'
    );
  });

  it('restores root-level css requires for preserveModules CommonJS chunks', async () => {
    const { default: wywInJS } = await loadWywInJS();

    const outputOptions = {
      format: 'cjs',
      preserveModules: true,
      preserveModulesRoot: '/project/src',
    };

    const plugin = wywInJS({ preserveCssPaths: true });
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: {
        lib: { entry: '/project/src/index.ts', formats: ['cjs'] },
        cssCodeSplit: true,
        rollupOptions: { output: outputOptions },
      },
    } as any);

    transformMock.mockResolvedValueOnce({
      code: 'exports.root = "root";',
      sourceMap: null,
      cssText: '.root { color: red; }',
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn(), warn: jest.fn() } as any,
      'exports.root = "root";',
      '/project/src/index.ts'
    );

    const bundle = {
      'index.js': {
        type: 'chunk',
        fileName: 'index.js',
        code: '"use strict";Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});exports.root = "root";\n',
        facadeModuleId: '/project/src/index.ts',
      },
      'index.wyw-in-js.css': {
        type: 'asset',
        fileName: 'index.wyw-in-js.css',
        name: '/project/src/index.wyw-in-js.css',
        source: '.root { color: red; }',
      },
    };

    plugin.generateBundle?.(
      outputOptions as any,
      bundle as any,
      false as never
    );

    expect((bundle['index.js'] as any).code).toContain(
      '"use strict";require("./index.wyw-in-js.css");'
    );
  });

  it('restores renamed root-level css requires for preserveModules CommonJS chunks without build.lib', async () => {
    const { default: wywInJS } = await loadWywInJS();

    const outputOptions = {
      format: 'cjs',
      preserveModules: true,
      preserveModulesRoot: '/project/src',
    };

    const plugin = wywInJS({ preserveCssPaths: true });
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: {
        cssCodeSplit: true,
        rollupOptions: { output: outputOptions },
      },
    } as any);

    transformMock.mockResolvedValueOnce({
      code: 'exports.root = "root";',
      sourceMap: null,
      cssText: '.root { color: red; }',
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn(), warn: jest.fn() } as any,
      'exports.root = "root";',
      '/project/src/index.ts'
    );

    const bundle = {
      'index.js': {
        type: 'chunk',
        fileName: 'index.js',
        code: '"use strict";Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});exports.root = "root";\n',
        facadeModuleId: '/project/src/index.ts',
      },
      'index.css': {
        type: 'asset',
        fileName: 'index.css',
        name: '/project/src/index.wyw-in-js.css',
        source: '.root { color: red; }',
      },
    };

    plugin.generateBundle?.(
      outputOptions as any,
      bundle as any,
      false as never
    );

    expect((bundle['index.js'] as any).code).toContain(
      '"use strict";require("./index.css");'
    );
  });

  it('restores nested css requires for preserveModules CommonJS chunks', async () => {
    const { default: wywInJS } = await loadWywInJS();

    const outputOptions = {
      format: 'cjs',
      preserveModules: true,
      preserveModulesRoot: '/project/src',
    };

    const plugin = wywInJS({ preserveCssPaths: true });
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: {
        lib: { entry: '/project/src/index.ts', formats: ['cjs'] },
        cssCodeSplit: true,
        rollupOptions: { output: outputOptions },
      },
    } as any);

    transformMock.mockResolvedValueOnce({
      code: 'exports.button = "button";',
      sourceMap: null,
      cssText: '.button { color: blue; }',
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn(), warn: jest.fn() } as any,
      'exports.button = "button";',
      '/project/src/nested/button.ts'
    );

    const bundle = {
      'nested/button.js': {
        type: 'chunk',
        fileName: 'nested/button.js',
        code: '"use strict";exports.button = "button";\n',
        facadeModuleId: '/project/src/nested/button.ts',
      },
      'nested/button.wyw-in-js.css': {
        type: 'asset',
        fileName: 'nested/button.wyw-in-js.css',
        name: 'src/nested/button.wyw-in-js.css',
        source: '.button { color: blue; }',
      },
    };

    plugin.generateBundle?.(
      outputOptions as any,
      bundle as any,
      false as never
    );

    expect((bundle['nested/button.js'] as any).code).toContain(
      'require("./button.wyw-in-js.css");'
    );
  });

  it('does not inject css requires when no wyw css asset is emitted for CommonJS chunks', async () => {
    const { default: wywInJS } = await loadWywInJS();

    const outputOptions = {
      format: 'cjs',
      preserveModules: true,
      preserveModulesRoot: '/project/src',
    };

    const plugin = wywInJS({ preserveCssPaths: true });
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: {
        lib: { entry: '/project/src/index.ts', formats: ['cjs'] },
        cssCodeSplit: true,
        rollupOptions: { output: outputOptions },
      },
    } as any);

    transformMock.mockResolvedValueOnce({
      code: 'exports.plain = "plain";',
      sourceMap: null,
      cssText: '.plain { color: inherit; }',
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn(), warn: jest.fn() } as any,
      'exports.plain = "plain";',
      '/project/src/plain.ts'
    );

    const bundle = {
      'plain.js': {
        type: 'chunk',
        fileName: 'plain.js',
        code: '"use strict";exports.plain = "plain";\n',
        facadeModuleId: '/project/src/plain.ts',
      },
    };

    plugin.generateBundle?.(
      outputOptions as any,
      bundle as any,
      false as never
    );

    expect((bundle['plain.js'] as any).code).toBe(
      '"use strict";exports.plain = "plain";\n'
    );
  });
});
