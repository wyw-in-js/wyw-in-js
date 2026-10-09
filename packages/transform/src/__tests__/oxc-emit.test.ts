/* eslint-env jest */

import { join } from 'path';
import vm from 'vm';

import dedent from 'dedent';

import { emitOxcCommonJS, stripTypesAndJsxWithOxc } from '../utils/oxcEmit';

const tsFilename = join(__dirname, 'source.ts');
const tsxFilename = join(__dirname, 'source.tsx');

const executeCommonJS = (
  code: string,
  requireImpl: (id: string) => unknown = () => ({})
): Record<string, unknown> => {
  const exports: Record<string, unknown> = {};
  const module = { exports };
  vm.runInNewContext(code, {
    exports,
    module,
    require: requireImpl,
  });
  return module.exports;
};

describe('stripTypesAndJsxWithOxc', () => {
  it('strips TypeScript constructs and returns source maps when requested', () => {
    const result = stripTypesAndJsxWithOxc(
      dedent`
        export enum Flags {
          Dev = 1,
        }
        export const mode: number = Flags.Dev;
      `,
      tsFilename,
      { sourcemap: true }
    );

    expect(result.code).toContain('export let Flags');
    expect(result.code).toContain('export const mode = Flags.Dev');
    expect(result.code).not.toContain(': number');
    expect(result.map?.sources).toContain(tsFilename);
  });

  it('lowers JSX using the automatic runtime before CommonJS emission', () => {
    const result = stripTypesAndJsxWithOxc(
      dedent`
        export const view = <div data-id="x" />;
      `,
      tsxFilename
    );

    expect(result.code).toContain('react/jsx-runtime');
    expect(result.code).toContain('_jsx("div"');
  });

  it('uses the running Node major as the Oxc target when stripping TypeScript', () => {
    const originalNodeVersion = Object.getOwnPropertyDescriptor(
      process.versions,
      'node'
    );

    try {
      Object.defineProperty(process.versions, 'node', {
        configurable: true,
        value: '20.11.0',
      });

      const result = stripTypesAndJsxWithOxc(
        dedent`
          class Cache {
            #value = 1;
            get() {
              return this.#value;
            }
          }
          export const cache = new Cache();
        `,
        tsFilename
      );

      expect(result.code).toContain('#value');
      expect(result.code).not.toContain('@oxc-project/runtime');
    } finally {
      if (originalNodeVersion) {
        Object.defineProperty(process.versions, 'node', originalNodeVersion);
      }
    }
  });
});

describe('emitOxcCommonJS', () => {
  it('emits executable CommonJS for TypeScript exports', () => {
    const result = emitOxcCommonJS(
      dedent`
        export enum Flags {
          Dev = 1,
        }
        export const mode: number = Flags.Dev;
      `,
      tsFilename
    );
    const exports = executeCommonJS(result.code);

    expect(result.code).toContain(
      'Object.defineProperty(exports, "__esModule"'
    );
    expect(result.code).toContain('let Flags = exports.Flags =');
    expect(result.code).toContain('const mode = exports.mode = Flags.Dev');
    expect((exports.Flags as { Dev: number }).Dev).toBe(1);
    expect(exports.mode).toBe(1);
  });

  it('emits named, default, namespace, and side-effect imports without Babel', () => {
    const result = emitOxcCommonJS(
      dedent`
        import defaultValue, { named as alias } from 'dep';
        import * as ns from 'ns';
        import 'side';

        export const value = defaultValue + alias + ns.extra;
        export { alias as renamed };
        export default value;
      `,
      tsFilename
    );
    const seen: string[] = [];
    const exports = executeCommonJS(result.code, (id) => {
      seen.push(id);
      if (id === 'dep') {
        return { __esModule: true, default: 1, named: 2 };
      }
      if (id === 'ns') {
        return { extra: 3 };
      }
      return {};
    });

    expect(seen).toEqual(['dep', 'ns', 'side']);
    expect(exports.value).toBe(6);
    expect(exports.renamed).toBe(2);
    expect(exports.default).toBe(6);
    expect(result.code).not.toContain('import ');
    expect(result.code).not.toContain('export ');
  });

  it('emits function and class exports as local declarations plus export assignments', () => {
    const result = emitOxcCommonJS(
      dedent`
        export function spring() {
          return 'spring';
        }

        export class Task {
          static nameOf() {
            return spring();
          }
        }
      `,
      tsFilename
    );
    const exports = executeCommonJS(result.code) as {
      Task: { nameOf(): string };
      spring(): string;
    };

    expect(exports.spring()).toBe('spring');
    expect(exports.Task.nameOf()).toBe('spring');
    expect(result.code).toContain('exports.spring = spring');
    expect(result.code).toContain('exports.Task = Task');
  });

  it('preserves local named export specifiers declared later in the module', () => {
    const result = emitOxcCommonJS(
      dedent`
        export { theme };
        const theme = 1;
      `,
      tsFilename
    );
    const exports = executeCommonJS(result.code);

    expect(exports.theme).toBe(1);
    expect(result.code).toContain('Object.defineProperty(exports, "theme"');
  });

  it('preserves live bindings for local named export specifiers', () => {
    const result = emitOxcCommonJS(
      dedent`
        let theme = 1;
        export { theme };
        theme = 2;
      `,
      tsFilename
    );
    const exports = executeCommonJS(result.code);

    expect(exports.theme).toBe(2);
    expect(result.code).toContain('Object.defineProperty(exports, "theme"');
  });

  it('keeps template literal contents that look like trailing commas', () => {
    const literal = ['a,', '}', '', 'const b,', '  }'].join('\n');
    const result = emitOxcCommonJS(
      [
        `const local = \`${literal}\`;`,
        `export const value = \`${literal}\`;`,
        'export const object = {',
        '  local,',
        '};',
      ].join('\n'),
      tsFilename
    );
    const exports = executeCommonJS(result.code) as {
      object: { local: string };
      value: string;
    };

    expect(exports.value).toBe(literal);
    expect(exports.object.local).toBe(literal);
  });
});
