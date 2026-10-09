/* eslint-env jest */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import dedent from 'dedent';

import { getEvalBroker } from '../eval/broker';
import { prepareModuleOnDemand } from '../eval/prepareModuleOnDemand';
import evaluate from '../evaluators';
import { oxcShaker } from '../shaker';
import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import { withDefaultServices } from '../transform/helpers/withDefaultServices';
import { Entrypoint } from '../transform/Entrypoint';
import { transform as transformFile } from '../transform';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');
const linariaStyledProcessorFile = join(
  __dirname,
  '__fixtures__',
  'test-styled-processor.js'
);

const resolveWithExtensions = (candidate: string) => {
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs'];
  for (const ext of extensions) {
    const withExt = `${candidate}${ext}`;
    if (existsSync(withExt) && statSync(withExt).isFile()) {
      return withExt;
    }
  }

  return null;
};

describe('explicit Oxc workflow', () => {
  const createPluginOptions = (extra: Record<string, unknown> = {}) => ({
    configFile: false,
    features: {
      globalCache: false,
    },
    rules: [
      {
        action: oxcShaker,
        test: () => true,
      },
    ],
    tagResolver: (source: string, tag: string) => {
      if (source === 'test-css-processor' && tag === 'css') {
        return processorFile;
      }

      if (source === '@linaria/react' && tag === 'styled') {
        return linariaStyledProcessorFile;
      }

      return null;
    },
    ...extra,
  });

  const createWorkflowServices = (
    root: string,
    filename: string,
    asyncResolve: (
      what: string,
      importer: string,
      stack: string[]
    ) => Promise<string | null>,
    extra: Record<string, unknown> = {}
  ) => {
    const pluginOptions = loadWywOptions(createPluginOptions(extra));
    const services = withDefaultServices({
      options: {
        filename,
        preprocessor: 'none',
        root,
        pluginOptions,
      },
    });

    services.asyncResolve = asyncResolve;
    services.evalBroker = getEvalBroker(
      services,
      asyncResolve,
      `${filename}:workflow-test`
    );

    return services;
  };

  it('runs prepare, eval, collect, and extract through the existing workflow', async () => {
    const filename = join(__dirname, 'source.js');
    const result = await transformFile(
      {
        options: {
          filename,
          preprocessor: 'none',
          root: __dirname,
          pluginOptions: createPluginOptions(),
        },
      },
      dedent`
        import { css } from 'test-css-processor';

        const color = 'red';
        export const className = css\`
          color: ${'${color}'};
        \`;
      `,
      async () => null
    );

    expect(result.code).not.toContain('css`');
    expect(result.code).toContain('export const className =');
    expect(result.cssText).toContain('color: red');
    expect(result.rules).toBeTruthy();
    expect(result.sourceMap?.sources).toContain(filename);
    expect(result.sourceMap?.sourcesContent?.[0]).toContain('css`');
  });

  it('handles JSX syntax in .js files before downstream JSX transforms run', async () => {
    const filename = join(__dirname, 'source-with-jsx.js');
    const result = await transformFile(
      {
        options: {
          filename,
          preprocessor: 'none',
          root: __dirname,
          pluginOptions: createPluginOptions(),
        },
      },
      dedent`
        import { css } from 'test-css-processor';

        const color = 'red';
        export const className = css\`
          color: ${'${color}'};
        \`;
        export const element = <div className={className} />;
      `,
      async () => null
    );

    expect(result.code).not.toContain('css`');
    expect(result.code).toContain('<div className={className} />');
    expect(result.cssText).toContain('color: red');
  });

  it('keeps JSX parsing restricted to .js compatibility fallback', async () => {
    const filename = join(__dirname, 'source-with-jsx.mjs');
    await expect(
      transformFile(
        {
          options: {
            filename,
            preprocessor: 'none',
            root: __dirname,
            pluginOptions: createPluginOptions(),
          },
        },
        dedent`
          import { css } from 'test-css-processor';

          export const className = css\`
            color: red;
          \`;
          export const element = <div className={className} />;
        `,
        async () => null
      )
    ).rejects.toThrow('Unexpected JSX expression');
  });

  it('evaluates .js dependencies with JSX through the eval broker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-oxc-workflow-jsx-dep-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'dep.js');

    writeFileSync(
      depFile,
      dedent`
        export const color = ['gr', 'een'].join('');
        export const Badge = () => <span className="badge" />;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './dep';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    const asyncResolve = async (what: string, importer: string) => {
      if (what === 'test-css-processor') {
        return processorFile;
      }

      if (what.startsWith('.')) {
        return resolveWithExtensions(join(importer, '..', what));
      }

      return null;
    };

    try {
      const result = await transformFile(
        {
          emitWarning: () => {},
          options: {
            filename: entryFile,
            preprocessor: 'none',
            root,
            pluginOptions: createPluginOptions(),
          },
        },
        readFileSync(entryFile, 'utf8'),
        asyncResolve
      );

      expect(result.cssText).toContain('color: green');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('keeps non-JSX syntax errors fatal in .js files', async () => {
    const filename = join(__dirname, 'invalid-source.js');
    await expect(
      transformFile(
        {
          options: {
            filename,
            preprocessor: 'none',
            root: __dirname,
            pluginOptions: createPluginOptions(),
          },
        },
        dedent`
          import { css } from 'test-css-processor';

          export const className = css\`
            color: red;
          \`;
          export const broken = ;
        `,
        async () => null
      )
    ).rejects.toThrow();
  });

  it('does not resolve imports for __wywPreval-only modules without metadata', async () => {
    const filename = join(__dirname, 'no-metadata-source.js');
    const source = dedent`
      import { child } from './child';
      export const value = child;
    `;
    const asyncResolve = jest.fn(async () => {
      throw new Error('should not resolve imports');
    });

    const result = await transformFile(
      {
        options: {
          filename,
          root: __dirname,
          pluginOptions: createPluginOptions(),
        },
      },
      source,
      asyncResolve
    );

    expect(result.code).toBe(source);
    expect(result.cssText).toBeUndefined();
    expect(asyncResolve).not.toHaveBeenCalled();
  });

  it('emits normalized public metadata when outputMetadata is enabled', async () => {
    const filename = join(__dirname, 'metadata-source.js');
    const result = await transformFile(
      {
        options: {
          filename,
          preprocessor: 'none',
          root: __dirname,
          pluginOptions: createPluginOptions({
            outputMetadata: true,
          }),
        },
      },
      dedent`
        import { css } from 'test-css-processor';

        export const className = css\`
          color: red;
        \`;
      `,
      async () => null
    );

    expect(result.metadata?.processors).toHaveLength(1);
    expect(result.metadata?.processors[0]).toMatchObject({
      className: expect.any(String),
      displayName: 'className',
      start: {
        column: 25,
        line: 3,
      },
    });
    expect(Object.values(result.rules ?? {})).toContainEqual(
      expect.objectContaining({
        cssText: expect.stringContaining('color: red'),
      })
    );
    expect(result.metadata?.rules).toEqual(result.rules);
  });

  it('loads imported interpolation dependencies through the Oxc prepare path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-oxc-workflow-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'dep.js');

    writeFileSync(depFile, `export const color = 'green';`);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './dep';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what === 'test-css-processor') {
        return processorFile;
      }

      if (what.startsWith('.')) {
        return resolveWithExtensions(join(importer, '..', what));
      }

      return null;
    });

    try {
      const result = await transformFile(
        {
          emitWarning: () => {},
          options: {
            filename: entryFile,
            preprocessor: 'none',
            root,
            pluginOptions: createPluginOptions(),
          },
        },
        readFileSync(entryFile, 'utf8'),
        asyncResolve
      );

      expect(result.cssText).toContain('color: green');
      expect(asyncResolve).toHaveBeenCalledWith('./dep', entryFile, [
        entryFile,
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('keeps composed selectors when wrapping imported styled components', async () => {
    const root = mkdtempSync(join(__dirname, 'wyw-oxc-workflow-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');

    writeFileSync(
      baseFile,
      dedent`
        import { styled } from '@linaria/react';

        export default styled.div\`
          color: red;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from '@linaria/react';
        import Base from './base';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolveWithExtensions(join(importer, '..', what));
      }

      return null;
    });

    try {
      const result = await transformFile(
        {
          emitWarning: () => {},
          options: {
            filename: entryFile,
            preprocessor: 'none',
            root,
            pluginOptions: createPluginOptions(),
          },
        },
        readFileSync(entryFile, 'utf8'),
        asyncResolve
      );

      expect(result.cssText).toContain('font-size: 12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size: 12px;[^}]*\}/s
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('preserves imported styled metadata in __wywPreval values', async () => {
    const root = mkdtempSync(join(__dirname, 'wyw-oxc-workflow-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');

    writeFileSync(
      baseFile,
      dedent`
        import { styled } from '@linaria/react';

        export default styled.div\`
          color: red;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from '@linaria/react';
        import Base from './base';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolveWithExtensions(join(importer, '..', what));
      }

      return null;
    });

    const services = createWorkflowServices(root, entryFile, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entryFile,
      ['__wywPreval'],
      readFileSync(entryFile, 'utf8')
    );

    try {
      const preparedEntry = prepareModuleOnDemand(services, entryFile, [
        '__wywPreval',
      ]);
      const preparedBase = prepareModuleOnDemand(services, baseFile, [
        'default',
        '__wywPreval',
      ]);
      const result = await evaluate(services, entrypoint);
      const base = result.values?.get('_exp');

      expect(preparedEntry.code).toContain('var _exp = () => Base;');
      expect(preparedEntry.code).toContain(
        'export const __wywPreval = { _exp };'
      );
      expect(preparedBase.code).toContain('__wyw_meta');
      expect(base).toMatchObject({
        __wyw_meta: {
          className: expect.any(String),
          extends: null,
        },
      });
    } finally {
      services.evalBroker?.dispose();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('keeps composed selectors for alias-imported styled components inside a package root', async () => {
    const root = mkdtempSync(join(__dirname, 'wyw-oxc-workflow-portal-'));
    const baseFile = join(
      root,
      'js',
      'components',
      'Details',
      'CredentialValue.tsx'
    );
    const entryFile = join(
      root,
      'js',
      'sections',
      '@cloud-storage',
      '@info',
      'components',
      'credentials',
      'CredentialsBlock.tsx'
    );

    mkdirSync(join(root, 'js', 'components', 'Details'), { recursive: true });
    mkdirSync(
      join(
        root,
        'js',
        'sections',
        '@cloud-storage',
        '@info',
        'components',
        'credentials'
      ),
      { recursive: true }
    );
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'portal-app' })
    );
    writeFileSync(
      baseFile,
      dedent`
        import { styled } from '@linaria/react';

        export default styled.div\`
          max-width: 390px;
          background-color: transparent;
          border: 1px solid var(--fields-border);
          padding: 0 8px;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from '@linaria/react';

        import CredentialValue from "_/components/Details/CredentialValue";

        export const CredentialText = styled(CredentialValue)\`
          max-width: initial;
          background-color: var(--readonly-bg);
        \`;
      `
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('_/')) {
        return resolveWithExtensions(join(root, 'js', what.slice(2)));
      }

      if (what.startsWith('.')) {
        return resolveWithExtensions(join(importer, '..', what));
      }

      return null;
    });

    try {
      const result = await transformFile(
        {
          emitWarning: () => {},
          options: {
            filename: entryFile,
            preprocessor: 'none',
            root,
            pluginOptions: createPluginOptions(),
          },
        },
        readFileSync(entryFile, 'utf8'),
        asyncResolve
      );

      expect(result.cssText).toContain('background-color: var(--readonly-bg);');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*max-width: initial;[^}]*background-color: var\(--readonly-bg\);[^}]*\}/s
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('keeps composed selectors when an alias-imported wrapper shares a file with other styled tags', async () => {
    const root = mkdtempSync(join(__dirname, 'wyw-oxc-workflow-portal-'));
    const baseFile = join(
      root,
      'js',
      'components',
      'Details',
      'CredentialValue.tsx'
    );
    const entryFile = join(
      root,
      'js',
      'sections',
      '@cloud-storage',
      '@info',
      'components',
      'credentials',
      'CredentialsBlock.tsx'
    );

    mkdirSync(join(root, 'js', 'components', 'Details'), { recursive: true });
    mkdirSync(
      join(
        root,
        'js',
        'sections',
        '@cloud-storage',
        '@info',
        'components',
        'credentials'
      ),
      { recursive: true }
    );
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'portal-app' })
    );
    writeFileSync(
      baseFile,
      dedent`
        import { styled } from '@linaria/react';

        export default styled.div\`
          max-width: 390px;
          white-space: nowrap;
          overflow-x: auto;
          background-color: transparent;
          border: 1px solid var(--fields-border);
          min-height: 32px;
          border-radius: 7px;
          padding: 0 8px;
          color: var(--text-secondary-color);
          display: flex;
          align-items: center;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from '@linaria/react';

        import CredentialValue from "_/components/Details/CredentialValue";

        const CredentialsBlock = styled.div\`
          & > div {
            display: flex;
            align-items: center;

            & > div:last-of-type {
              padding-left: 20px;
            }
          }
        \`;

        export const CredentialText = styled(CredentialValue)\`
          max-width: initial;
          background-color: var(--readonly-bg);
        \`;

        export default CredentialsBlock;
      `
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('_/')) {
        return resolveWithExtensions(join(root, 'js', what.slice(2)));
      }

      if (what.startsWith('.')) {
        return resolveWithExtensions(join(importer, '..', what));
      }

      return null;
    });

    try {
      const result = await transformFile(
        {
          emitWarning: () => {},
          options: {
            filename: entryFile,
            preprocessor: 'none',
            root,
            pluginOptions: createPluginOptions(),
          },
        },
        readFileSync(entryFile, 'utf8'),
        asyncResolve
      );

      expect(result.cssText).toContain('padding-left: 20px;');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*max-width: initial;[^}]*background-color: var\(--readonly-bg\);[^}]*\}/s
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('keeps composed selectors for portal-like wrappers with surrounding runtime imports', async () => {
    const root = mkdtempSync(join(__dirname, 'wyw-oxc-workflow-portal-'));
    const baseFile = join(
      root,
      'js',
      'components',
      'Details',
      'CredentialValue.tsx'
    );
    const entryFile = join(
      root,
      'js',
      'sections',
      '@cloud-computing',
      'components',
      'PrivateKey',
      'Key.tsx'
    );
    const roleFile = join(
      root,
      'node_modules',
      '@portal',
      'shared',
      'components',
      'Role.js'
    );
    const reactFile = join(root, 'node_modules', 'react', 'index.js');
    const animatedScrollToFile = join(
      root,
      'node_modules',
      'animated-scroll-to',
      'index.js'
    );

    mkdirSync(join(root, 'js', 'components', 'Details'), { recursive: true });
    mkdirSync(
      join(
        root,
        'js',
        'sections',
        '@cloud-computing',
        'components',
        'PrivateKey'
      ),
      { recursive: true }
    );
    mkdirSync(join(root, 'node_modules', '@portal', 'shared', 'components'), {
      recursive: true,
    });
    mkdirSync(join(root, 'node_modules', 'react'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'animated-scroll-to'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'portal-app' })
    );
    writeFileSync(
      baseFile,
      dedent`
        import { styled } from '@linaria/react';

        export default styled.div\`
          max-width: 390px;
          white-space: nowrap;
          overflow-x: auto;
          background-color: transparent;
          border: 1px solid var(--fields-border);
          min-height: 32px;
          border-radius: 7px;
          padding: 0 8px;
          color: var(--text-secondary-color);
          display: flex;
          align-items: center;
        \`;
      `
    );
    writeFileSync(
      roleFile,
      'export default function Role(props) { return props.children ?? null; }'
    );
    writeFileSync(
      reactFile,
      [
        'export const useRef = () => ({ current: null });',
        'export const useEffect = () => {};',
        'const React = { useRef, useEffect };',
        'export default React;',
      ].join('\n')
    );
    writeFileSync(
      animatedScrollToFile,
      'export default function animatedScrollTo() { return Promise.resolve(); }'
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from '@linaria/react';
        import animatedScrollTo from 'animated-scroll-to';
        import React from 'react';

        import Role from '@portal/shared/components/Role';

        import CredentialValue from "_/components/Details/CredentialValue";

        export const TextArea = styled(CredentialValue)\`
          max-width: initial;
          background-color: var(--readonly-bg);
          border: 1px solid var(--fields-border);
          padding: 0;

          & > pre {
            border: 0;
            max-height: 200px;
            background: var(--readonly-bg);
            padding: 10px 16px;
            margin-bottom: 0;
          }
        \`;

        const Key = ({ privateKey }) => {
          const textAreaRef = React.useRef(null);

          React.useEffect(() => {
            if (!textAreaRef.current) {
              return;
            }

            void animatedScrollTo(textAreaRef.current, {
              minDuration: 500,
              verticalOffset: -100,
            });
          }, []);

          return (
            <TextArea>
              <Role as="pre" name=":value" ref={textAreaRef}>
                {privateKey}
              </Role>
            </TextArea>
          );
        };

        export default Key;
      `
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('_/')) {
        return resolveWithExtensions(join(root, 'js', what.slice(2)));
      }

      if (what === '@portal/shared/components/Role') {
        return roleFile;
      }

      if (what === 'react') {
        return reactFile;
      }

      if (what === 'animated-scroll-to') {
        return animatedScrollToFile;
      }

      if (what.startsWith('.')) {
        return resolveWithExtensions(join(importer, '..', what));
      }

      return null;
    });

    try {
      const result = await transformFile(
        {
          emitWarning: () => {},
          options: {
            filename: entryFile,
            preprocessor: 'none',
            root,
            pluginOptions: createPluginOptions(),
          },
        },
        readFileSync(entryFile, 'utf8'),
        asyncResolve
      );

      expect(result.cssText).toContain('padding: 10px 16px;');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*max-width: initial;[^}]*background-color: var\(--readonly-bg\);[^}]*border: 1px solid var\(--fields-border\);[^}]*padding: 0;[^}]*\}/s
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('evaluates Vite-style import.meta.env through the Oxc workflow', async () => {
    const filename = join(__dirname, 'import-meta-env-source.js');
    const result = await transformFile(
      {
        options: {
          filename,
          preprocessor: 'none',
          root: __dirname,
          pluginOptions: createPluginOptions({
            overrideContext: (context: Record<string, unknown>) => ({
              ...context,
              __wyw_import_meta_env: {
                DEV: true,
                MODE: 'development',
              },
            }),
          }),
        },
      },
      dedent`
        import { css } from 'test-css-processor';

        const { MODE } = import.meta.env;

        export const className = css\`
          content: ${'${MODE}'};
          color: ${"${import.meta.env.DEV ? 'red' : 'blue'}"};
        \`;
      `,
      async () => null
    );

    expect(result.cssText).toContain('development');
    expect(result.cssText).toContain('red');
    expect(result.cssText).not.toContain('blue');
  });
});
