/* eslint-disable require-yield */
/* eslint-env jest */

import { join } from 'path';

import dedent from 'dedent';

import { oxcShaker } from '../shaker';
import { Entrypoint } from '../transform/Entrypoint';
import { asyncActionRunner } from '../transform/actions/actionRunner';
import {
  prepareCode,
  prepareCodeForEvalRuntime,
  transform as transformAction,
} from '../transform/generators/transform';
import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import { withDefaultServices } from '../transform/helpers/withDefaultServices';
import type {
  ActionQueueItem,
  Handlers,
  ICollectAction,
  IEvalAction,
  IExtractAction,
  IProcessEntrypointAction,
  IResolveImportsAction,
  ITransformAction,
  IWorkflowAction,
  Services,
  SyncScenarioForAction,
} from '../transform/types';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

const createServices = (filename: string, root: string) =>
  withDefaultServices({
    options: {
      filename,
      root,
      pluginOptions: loadWywOptions({
        configFile: false,
        eval: { strategy: 'hybrid' },
        rules: [
          {
            action: oxcShaker,
            test: () => true,
          },
        ],
        tagResolver: (source, tag) => {
          if (source === 'test-css-processor' && tag === 'css') {
            return processorFile;
          }

          return null;
        },
      }),
    },
  });

type SyncHandlers<TMode extends 'async' | 'sync'> = Handlers<TMode>;

// eslint-disable-next-line require-yield
function* emptyHandler<
  TAction extends ActionQueueItem,
>(): SyncScenarioForAction<TAction> {
  return undefined as never;
}

const getHandlers = <TMode extends 'async' | 'sync'>(
  partial: Partial<SyncHandlers<TMode>>
) => ({
  collect: jest.fn(emptyHandler<ICollectAction>),
  evalFile: jest.fn(emptyHandler<IEvalAction>),
  extract: jest.fn(emptyHandler<IExtractAction>),
  processEntrypoint: jest.fn(emptyHandler<IProcessEntrypointAction>),
  resolveImports: jest.fn(emptyHandler<IResolveImportsAction>),
  transform: jest.fn(emptyHandler<ITransformAction>),
  workflow: jest.fn(emptyHandler<IWorkflowAction>),
  ...partial,
});

describe('prepareCode with explicit oxcShaker action', () => {
  it('runs Oxc preeval and shaker while preserving prepareCode ESM output', () => {
    const root = __dirname;
    const filename = join(root, 'source.tsx');
    const source = dedent`
      import { css } from 'test-css-processor';
      import runtimeOnly from 'runtime-only';

      const color = 'red';
      export const className = css\`
        color: ${'${color}'};
      \`;
      export const runtime = runtimeOnly;
    `;
    const services = createServices(filename, root);
    const entrypoint = Entrypoint.createRoot(
      services,
      filename,
      ['__wywPreval'],
      source
    );

    if (entrypoint.ignored) {
      throw new Error('Ignored');
    }

    const [code, imports, metadata] = prepareCode(services, entrypoint, null);

    expect(code).toContain('export const __wywPreval =');
    expect(code).toContain('export const __wywPreval = {};');
    expect(code).not.toContain('var _exp =');
    expect(code).not.toContain('runtime-only');
    expect(code).not.toContain('test-css-processor');
    expect(imports?.size).toBe(0);
    expect(metadata?.processors).toHaveLength(1);
  });

  it('preserves CommonJS __wywPreval prepare output for transpiled React inputs', () => {
    const root = __dirname;
    const filename = join(root, 'transpiled-react.cjs');
    const source = dedent`
      var _interopRequireWildcard = require("@babel/runtime/helpers/interopRequireWildcard").default;
      var React = _interopRequireWildcard(require("react"));
      var css = require('test-css-processor').css;
      var constant = require('./broken-dependency').default;

      const A = () => React.createElement('div', {}, constant);
      const C = () => React.createElement(A, {}, constant);

      exports.D = css\`
        color: red;
      \`;
    `;
    const services = createServices(filename, root);
    const entrypoint = Entrypoint.createRoot(
      services,
      filename,
      ['__wywPreval'],
      source
    );

    if (entrypoint.ignored) {
      throw new Error('Ignored');
    }

    const [code, imports, metadata] = prepareCode(services, entrypoint, null);

    expect(code).toContain('__wywPreval');
    expect(code).not.toContain('styled(');
    expect(code).not.toContain("require('./broken-dependency')");
    expect(imports?.size).toBe(0);
    expect(metadata?.processors).toHaveLength(1);
  });

  it('feeds Oxc import metadata into the existing resolve/process actions', async () => {
    const root = __dirname;
    const filename = join(root, 'side-effect-source.js');
    const source = dedent`
      import './side-effect.js';
      export const unused = 1;
    `;
    const services = withDefaultServices({
      options: {
        filename,
        root,
        pluginOptions: loadWywOptions({
          configFile: false,
          rules: [
            {
              action: oxcShaker,
              test: () => true,
            },
          ],
        }),
      } as Services['options'],
    });
    services.loadAndParseFn = jest.fn(() => ({
      get ast() {
        throw new Error('Babel AST should not be read by oxcShaker path');
      },
      code: source,
      evalConfig: {
        filename,
      },
      evaluator: oxcShaker,
    }));
    const entrypoint = Entrypoint.createRoot(
      services,
      filename,
      ['side-effect'],
      source
    );

    if (entrypoint.ignored) {
      throw new Error('Ignored');
    }

    const resolveImports: SyncHandlers<'sync'>['resolveImports'] = jest.fn(
      function* resolveOxcImports(
        this: IResolveImportsAction
      ): ReturnType<SyncHandlers<'sync'>['resolveImports']> {
        expect(this.data.imports?.get('./side-effect.js')).toEqual([
          'side-effect',
        ]);

        return [
          {
            only: ['side-effect'],
            resolved: join(root, 'side-effect.js'),
            source: './side-effect.js',
          },
        ];
      }
    );
    const handlers = getHandlers<'sync'>({
      processImports: jest.fn(function* processOxcImports() {
        return undefined as never;
      }),
      resolveImports,
      transform: transformAction,
    });

    const result = await asyncActionRunner(
      entrypoint.createAction('transform', undefined, null),
      handlers
    );

    expect(result.code).toContain('require("./side-effect.js")');
    expect(resolveImports).toHaveBeenCalledTimes(1);
    expect(handlers.processImports).toHaveBeenCalledTimes(1);
  });

  it('strips TypeScript when eval runtime short-circuits modules without metadata', () => {
    const root = __dirname;
    const filename = join(root, 'typed-helper.ts');
    const source = dedent`
      import type { ReactNode } from 'react';

      type Props = { children?: ReactNode };
      export const helper = (props: Props): string => String(props.children);
    `;
    const services = createServices(filename, root);
    const entrypoint = Entrypoint.createRoot(
      services,
      filename,
      ['__wywPreval'],
      source
    );

    if (entrypoint.ignored) {
      throw new Error('Ignored');
    }

    const [code, imports, metadata] = prepareCodeForEvalRuntime(
      services,
      entrypoint
    );

    expect(code).toContain('export const helper =');
    expect(code).not.toContain('type Props');
    expect(code).not.toContain(': Props');
    expect(code).not.toContain(': string');
    expect(imports?.size).toBe(0);
    expect(metadata).toBeNull();
  });

  it('shakes no-metadata eval runtime modules that already export __wywPreval', () => {
    const root = __dirname;
    const filename = join(root, 'prepared-preval.tsx');
    const source = dedent`
      import { themeVars } from '@fibery/ui-kit/src/design-system';
      import { memo } from 'react';

      var _exp = () => themeVars.inputBorderHoverColor;
      var Comment = memo(function Comment() {
        return null;
      });

      export const __wywPreval = {
        _exp,
      };
    `;
    const services = createServices(filename, root);
    const entrypoint = Entrypoint.createRoot(
      services,
      filename,
      ['__wywPreval'],
      source
    );

    if (entrypoint.ignored) {
      throw new Error('Ignored');
    }

    const [code, imports, metadata] = prepareCodeForEvalRuntime(
      services,
      entrypoint
    );

    expect(code).toContain('export const __wywPreval');
    expect(code).toContain('_exp');
    expect(code).not.toContain('memo');
    expect(code).not.toContain('Comment');
    expect(imports?.get('@fibery/ui-kit/src/design-system')).toEqual([
      'themeVars',
    ]);
    expect(imports?.has('react')).toBe(false);
    expect(metadata).toBeNull();
  });

  it('strips TypeScript from metadata-bearing eval runtime modules', () => {
    const root = __dirname;
    const filename = join(root, 'typed-styles.ts');
    const source = dedent`
      import type { ReactNode } from 'react';
      import { css } from 'test-css-processor';

      type Props = { children?: ReactNode };
      const color: string = 'red';
      export const className: string = css\`
        color: ${'${color}'};
      \`;
      export const helper = (props: Props): string => String(props.children);
    `;
    const services = createServices(filename, root);
    const entrypoint = Entrypoint.createRoot(
      services,
      filename,
      ['__wywPreval'],
      source
    );

    if (entrypoint.ignored) {
      throw new Error('Ignored');
    }

    const [code, imports, metadata] = prepareCodeForEvalRuntime(
      services,
      entrypoint
    );

    expect(code).toContain('export const __wywPreval =');
    expect(code).not.toContain('import type');
    expect(code).not.toContain('type Props');
    expect(code).not.toContain(': string');
    expect(code).not.toContain(': Props');
    expect(imports?.size).toBe(0);
    expect(metadata?.processors).toHaveLength(1);
  });
});
