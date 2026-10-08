import fs from 'fs';
import os from 'os';
import path from 'path';

import * as actualShared from '@wyw-in-js/shared';

const transformMock = jest.fn();

// Keep the real pure helpers (request parsing, source map normalisation, CSS
// protocol constants) and stub only what the test controls.
const realShared = { ...actualShared };

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  ...realShared,
  logger: jest.fn(),
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  TransformCacheCollection: class TransformCacheCollection {},
  transform: (...args: unknown[]) => transformMock(...args),
}));

describe('turbopack-loader', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('writes CSS next to the module and injects an import after directives by default', async () => {
    const { default: turbopackLoader } = await import('../index');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-turbo-'));
    const resourcePath = path.join(tmpDir, 'entry.tsx');
    const configFile = path.join(tmpDir, 'wyw.config.js');
    fs.writeFileSync(resourcePath, "'use client'\\nexport const x = 1;\\n");
    fs.writeFileSync(configFile, 'module.exports = {};\\n');

    transformMock.mockImplementation(async (_services, code) => {
      return {
        code,
        sourceMap: null,
        cssText: '.a{color:red}',
        dependencies: [],
      };
    });

    const emitted: { code?: string } = {};

    await new Promise<void>((resolve, reject) => {
      turbopackLoader.call(
        {
          addDependency: jest.fn(),
          async: jest.fn(),
          callback: (err: Error | null, code?: string) => {
            if (err) reject(err);
            else {
              emitted.code = code;
              resolve();
            }
          },
          emitWarning: jest.fn(),
          getOptions: () => ({ configFile }),
          getResolve: () => async () => false,
          resourcePath,
        } as any,
        fs.readFileSync(resourcePath, 'utf8'),
        null
      );
    });

    const cssFilePath = path.join(tmpDir, 'entry.wyw-in-js.module.css');
    expect(fs.readFileSync(cssFilePath, 'utf8')).toBe(':global(.a){color:red}');

    expect(emitted.code).toContain("'use client'");
    expect(emitted.code).toContain('import "./entry.wyw-in-js.module.css";');
  });

  it('injects a CSS query import in query output mode without writing a sidecar file', async () => {
    const { default: turbopackLoader } = await import('../index');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-turbo-'));
    const resourcePath = path.join(tmpDir, 'entry.tsx');
    fs.writeFileSync(resourcePath, "'use client'\\nexport const x = 1;\\n");

    transformMock.mockImplementation(async (_services, code) => {
      return {
        code,
        sourceMap: null,
        cssText: '.a{color:red}',
        dependencies: [],
      };
    });

    const emitted: { code?: string } = {};

    await new Promise<void>((resolve, reject) => {
      turbopackLoader.call(
        {
          addDependency: jest.fn(),
          async: jest.fn(),
          callback: (err: Error | null, code?: string) => {
            if (err) reject(err);
            else {
              emitted.code = code;
              resolve();
            }
          },
          emitWarning: jest.fn(),
          getOptions: () => ({ cssOutputMode: 'query' }),
          getResolve: () => async () => false,
          resourcePath,
        } as any,
        fs.readFileSync(resourcePath, 'utf8'),
        null
      );
    });

    const cssFilePath = path.join(tmpDir, 'entry.wyw-in-js.module.css');
    expect(fs.existsSync(cssFilePath)).toBe(false);

    expect(emitted.code).toContain("'use client'");
    expect(emitted.code).toContain('import "./entry.tsx?__wyw_css";');
  });

  it('returns CSS for the CSS query loader branch', async () => {
    const { default: turbopackLoader } = await import('../index');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-turbo-'));
    const resourcePath = path.join(tmpDir, 'entry.tsx');
    fs.writeFileSync(resourcePath, 'export const x = 1;\n');

    transformMock.mockImplementation(async (_services, code) => {
      return {
        code,
        sourceMap: null,
        cssText: '.a{color:red}',
        dependencies: [],
      };
    });

    const emitted: { code?: string } = {};

    await new Promise<void>((resolve, reject) => {
      turbopackLoader.call(
        {
          addDependency: jest.fn(),
          async: jest.fn(),
          callback: (err: Error | null, code?: string) => {
            if (err) reject(err);
            else {
              emitted.code = code;
              resolve();
            }
          },
          emitWarning: jest.fn(),
          getOptions: () => ({ outputCss: true }),
          getResolve: () => async () => false,
          resourcePath,
        } as any,
        fs.readFileSync(resourcePath, 'utf8'),
        null
      );
    });

    expect(emitted.code).toBe(':global(.a){color:red}');
  });

  it('registers resolved transform dependencies without resolving them again', async () => {
    const { default: turbopackLoader } = await import('../index');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-turbo-'));
    const resourcePath = path.join(tmpDir, 'entry.tsx');
    const depPath = path.join(tmpDir, 'dep.tsx');
    const zodPath = path.join(tmpDir, 'node_modules', 'zod', 'index.js');
    const motionPath = path.join(tmpDir, 'node_modules', 'motion', 'react.js');
    fs.writeFileSync(resourcePath, 'export const x = 1;\n');
    fs.writeFileSync(depPath, 'export const y = 1;\n');

    transformMock.mockImplementation(async (_services, code) => {
      return {
        code,
        sourceMap: null,
        cssText: '.a{color:red}',
        dependencies: ['zod', 'motion/react', './dep'],
        dependencyResolutions: [
          { resolved: `${zodPath}?esm`, source: 'zod' },
          { resolved: motionPath, source: 'motion/react' },
        ],
      };
    });

    const addDependency = jest.fn();
    const resolveRequests: string[] = [];
    const emitted: { code?: string } = {};

    await new Promise<void>((resolve, reject) => {
      turbopackLoader.call(
        {
          addDependency,
          async: jest.fn(),
          callback: (err: Error | null, code?: string) => {
            if (err) reject(err);
            else {
              emitted.code = code;
              resolve();
            }
          },
          emitWarning: jest.fn(),
          getOptions: () => ({}),
          getResolve: () => async (_context: string, request: string) => {
            resolveRequests.push(request);

            if (request === './dep') {
              return `${depPath}?compiled`;
            }

            return false;
          },
          resourcePath,
        } as any,
        fs.readFileSync(resourcePath, 'utf8'),
        null
      );
    });

    expect(resolveRequests).toEqual(['./dep']);
    expect(addDependency).toHaveBeenCalledWith(zodPath);
    expect(addDependency).toHaveBeenCalledWith(motionPath);
    expect(addDependency).toHaveBeenCalledWith(depPath);
    expect(emitted.code).toContain('import "./entry.wyw-in-js.module.css";');
  });

  it('keeps resolution failures fatal when the transform has no resolved path', async () => {
    const { default: turbopackLoader } = await import('../index');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-turbo-'));
    const resourcePath = path.join(tmpDir, 'entry.tsx');
    const resolutionError = new Error(
      'Unable to resolve module "\'zod\'" in [project]/pages'
    );
    fs.writeFileSync(resourcePath, 'export const x = 1;\n');

    transformMock.mockImplementation(async (_services, code) => {
      return {
        code,
        sourceMap: null,
        cssText: '.a{color:red}',
        dependencies: ['zod'],
      };
    });

    const runLoader = new Promise<void>((resolve, reject) => {
      turbopackLoader.call(
        {
          addDependency: jest.fn(),
          async: jest.fn(),
          callback: (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          },
          emitWarning: jest.fn(),
          getOptions: () => ({}),
          getResolve: () => async () => {
            throw resolutionError;
          },
          resourcePath,
        } as any,
        fs.readFileSync(resourcePath, 'utf8'),
        null
      );
    });

    await expect(runLoader).rejects.toBe(resolutionError);
  });

  it('keeps concurrent same-path resolvers isolated across cleanup order', async () => {
    const { default: turbopackLoader } = await import('../index');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-turbo-'));
    const resourcePath = path.join(tmpDir, 'entry.tsx');
    fs.writeFileSync(resourcePath, 'export const x = 1;\n');

    type Resolver = (
      what: string,
      importer: string,
      stack: string[]
    ) => Promise<string>;
    const resolvers: Resolver[] = [];
    const releases: Array<() => void> = [];

    transformMock.mockImplementation(
      async (_services, code, resolver: Resolver) => {
        resolvers.push(resolver);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return { code, sourceMap: null, cssText: '', dependencies: [] };
      }
    );

    const runLoader = (target: 'server' | 'client') =>
      new Promise<void>((resolve, reject) => {
        turbopackLoader.call(
          {
            addDependency: jest.fn(),
            async: jest.fn(),
            callback: (err: Error | null) => {
              if (err) {
                reject(err);
                return;
              }
              resolve();
            },
            emitWarning: jest.fn(),
            getOptions: () => ({}),
            getResolve: () => async (_context: string, request: string) =>
              path.join(tmpDir, target, request),
            resourcePath,
          } as any,
          fs.readFileSync(resourcePath, 'utf8'),
          null
        );
      });

    const serverLoader = runLoader('server');
    const clientLoader = runLoader('client');

    expect(resolvers).toHaveLength(2);
    await expect(
      resolvers[0]('theme', resourcePath, [resourcePath])
    ).resolves.toBe(path.join(tmpDir, 'server', 'theme'));
    await expect(
      resolvers[1]('theme', resourcePath, [resourcePath])
    ).resolves.toBe(path.join(tmpDir, 'client', 'theme'));

    releases[1]();
    await clientLoader;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    await expect(
      resolvers[0]('theme', resourcePath, [resourcePath])
    ).resolves.toBe(path.join(tmpDir, 'server', 'theme'));

    releases[0]();
    await serverLoader;
  });

  it('isolates unkeyed invocations instead of assuming process-wide resolver semantics', async () => {
    const { default: turbopackLoader } = await import('../index');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-turbo-'));
    const resourcePath = path.join(tmpDir, 'entry.tsx');
    fs.writeFileSync(resourcePath, 'export const x = 1;\n');

    const services: Array<{
      asyncResolveKey: string;
      cache: unknown;
      evalBrokerScope: unknown;
    }> = [];
    const releases: Array<() => void> = [];

    transformMock.mockImplementation(async (transformServices, code) => {
      services.push(transformServices);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return { code, sourceMap: null, cssText: '', dependencies: [] };
    });

    const runLoader = () =>
      new Promise<void>((resolve, reject) => {
        turbopackLoader.call(
          {
            addDependency: jest.fn(),
            async: jest.fn(),
            callback: (err: Error | null) => {
              if (err) {
                reject(err);
                return;
              }
              resolve();
            },
            emitWarning: jest.fn(),
            getOptions: () => ({}),
            getResolve: () => async () => path.join(tmpDir, 'dep.ts'),
            resourcePath,
          } as any,
          fs.readFileSync(resourcePath, 'utf8'),
          null
        );
      });

    const first = runLoader();
    const second = runLoader();

    expect(services).toHaveLength(2);
    expect(services[0].asyncResolveKey).not.toBe(services[1].asyncResolveKey);
    expect(services[0].cache).not.toBe(services[1].cache);
    expect(services[0].evalBrokerScope).toBe(services[1].evalBrokerScope);

    releases.forEach((release) => release());
    await Promise.all([first, second]);
  });

  it('reuses cache keys only for an explicit resolver-semantics scope', async () => {
    const { default: turbopackLoader } = await import('../index');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-turbo-'));
    const resourcePath = path.join(tmpDir, 'entry.tsx');
    fs.writeFileSync(resourcePath, 'export const x = 1;\n');

    type Resolver = (
      what: string,
      importer: string,
      stack: string[]
    ) => Promise<string>;
    type Services = {
      asyncResolveKey: string;
      cache: unknown;
      evalBrokerScope: unknown;
    };
    const calls: Array<{
      resolver: Resolver;
      services: Services;
    }> = [];
    const releases: Array<() => void> = [];

    transformMock.mockImplementation(
      async (services: Services, code, resolver: Resolver) => {
        calls.push({ resolver, services });
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return { code, sourceMap: null, cssText: '', dependencies: [] };
      }
    );

    const runLoader = (resolverScopeKey: string, aliasTarget: string) =>
      new Promise<void>((resolve, reject) => {
        turbopackLoader.call(
          {
            addDependency: jest.fn(),
            async: jest.fn(),
            callback: (err: Error | null) => {
              if (err) {
                reject(err);
                return;
              }
              resolve();
            },
            emitWarning: jest.fn(),
            getOptions: () => ({ resolverScopeKey }),
            getResolve: () => async () => aliasTarget,
            resourcePath,
          } as any,
          fs.readFileSync(resourcePath, 'utf8'),
          null
        );
      });

    const server = runLoader('server-aliases-test', '/aliases/server.ts');
    expect(await calls[0].resolver('theme', resourcePath, [resourcePath])).toBe(
      '/aliases/server.ts'
    );
    releases[0]();
    await server;

    const client = runLoader('client-aliases-test', '/aliases/client.ts');
    expect(await calls[1].resolver('theme', resourcePath, [resourcePath])).toBe(
      '/aliases/client.ts'
    );
    expect(calls[1].services.asyncResolveKey).not.toBe(
      calls[0].services.asyncResolveKey
    );
    expect(calls[1].services.cache).not.toBe(calls[0].services.cache);
    expect(calls[1].services.evalBrokerScope).toBe(
      calls[0].services.evalBrokerScope
    );
    releases[1]();
    await client;

    const nextServer = runLoader('server-aliases-test', '/aliases/server.ts');
    expect(calls[2].services.asyncResolveKey).toBe(
      calls[0].services.asyncResolveKey
    );
    expect(calls[2].services.cache).toBe(calls[0].services.cache);
    releases[2]();
    await nextServer;
  });
});
