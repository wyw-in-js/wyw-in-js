/* eslint-env jest */
import { runInNewContext } from 'vm';

import { emitOxcCommonJS, stripTypesAndJsxWithOxc } from '../utils/oxcEmit';
import { removeDangerousCodeWithOxc } from '../utils/dangerousCodeRemoval';
import {
  addRequireFallbackWithOxc,
  replaceImportMetaEnvWithOxc,
  rewriteDynamicImportsWithOxc,
} from '../utils/oxcPreevalTransforms';
import { shakeOxcToESM } from '../utils/oxcShaker';

const filename = '/test.ts';

const evaluateOut = (code: string): unknown => {
  const prepared = removeDangerousCodeWithOxc(code, filename);
  const shaken = shakeOxcToESM(prepared, filename, { onlyExports: ['out'] });
  const emitted = emitOxcCommonJS(shaken.code, filename);
  const exports: Record<string, unknown> = {};
  const module = { exports };
  runInNewContext(emitted.code, { exports, module }, { timeout: 100 });
  return module.exports.out;
};

describe('oxc preeval transforms', () => {
  describe('import.meta.env rewrite', () => {
    it('replaces Vite-style import.meta.env object access', () => {
      expect(
        replaceImportMetaEnvWithOxc(
          'const { MODE } = import.meta.env; const dev = import.meta.env.DEV;',
          filename
        )
      ).toBe(
        'const { MODE } = __wyw_import_meta_env; const dev = __wyw_import_meta_env.DEV;'
      );
    });

    it('does not replace computed import.meta access', () => {
      expect(
        replaceImportMetaEnvWithOxc('const env = import.meta["env"];', filename)
      ).toBe('const env = import.meta["env"];');
    });
  });

  describe('dynamic import rewrite', () => {
    it('unwraps TS assertion for string literal specifier', () => {
      expect(
        rewriteDynamicImportsWithOxc(
          'function foo() { import("./foo" as any).then(() => null); }',
          filename
        )
      ).toContain('__wyw_dynamic_import("./foo").then');
    });

    it('keeps TS assertion for non-string-like specifier', () => {
      expect(
        rewriteDynamicImportsWithOxc(
          'function foo(locale: unknown) { import(locale as any).then(() => null); }',
          filename
        )
      ).toContain('__wyw_dynamic_import(locale as any).then');
    });

    it('unwraps TS assertion for string concatenation', () => {
      expect(
        rewriteDynamicImportsWithOxc(
          'function foo(locale: unknown) { import(("./foo/" + locale) as any); }',
          filename
        )
      ).toContain('__wyw_dynamic_import("./foo/" + locale)');
    });

    it('unwraps TS assertion for concat call', () => {
      expect(
        rewriteDynamicImportsWithOxc(
          'function foo(locale: unknown) { import(("./foo/".concat(locale, ".json")) as any); }',
          filename
        )
      ).toContain('__wyw_dynamic_import("./foo/".concat(locale, ".json"))');
    });

    it('unwraps TS assertion for template literal', () => {
      expect(
        rewriteDynamicImportsWithOxc(
          'function foo(locale: unknown) { import((`./foo/${locale}` as any)); }',
          filename
        )
      ).toContain('__wyw_dynamic_import("./foo/" + locale)');
    });

    it('does not treat conditional expression as string-like', () => {
      expect(
        rewriteDynamicImportsWithOxc(
          'function foo() { import((Math.random() > 0.5 ? "a" : "b") as any); }',
          filename
        )
      ).toContain(
        '__wyw_dynamic_import((Math.random() > 0.5 ? "a" : "b") as any)'
      );
    });
  });

  describe('require fallback rewrite', () => {
    it('does not change literal require calls', () => {
      expect(addRequireFallbackWithOxc("require('./dep')", filename)).toBe(
        "require('./dep')"
      );
    });

    it('does not change no-expression template literal require calls', () => {
      expect(addRequireFallbackWithOxc('require(`./dep`)', filename)).toBe(
        'require(`./dep`)'
      );
    });

    it('adds fallback marker for non-literal require calls', () => {
      expect(addRequireFallbackWithOxc('require(dep)', filename)).toBe(
        'require(dep, true)'
      );
    });

    it('inlines statically evaluable string require calls', () => {
      expect(
        addRequireFallbackWithOxc(
          [
            'const url = "./__fixtures__/FOO";',
            'require(url.toLowerCase());',
          ].join('\n'),
          filename
        )
      ).toBe(
        [
          'const url = "./__fixtures__/FOO";',
          'require("./__fixtures__/foo");',
        ].join('\n')
      );
    });

    it('keeps fallback marker for statically evaluable bare package requires', () => {
      expect(
        addRequireFallbackWithOxc(
          ['const pkg = "fake";', 'require(pkg);'].join('\n'),
          filename
        )
      ).toBe(['const pkg = "fake";', 'require(pkg, true);'].join('\n'));
    });

    it('preserves local require shadowing', () => {
      expect(
        addRequireFallbackWithOxc(
          'function load() { const require = makeRequire(); require(dep); }',
          filename
        )
      ).toBe(
        'function load() { const require = makeRequire(); require(dep); }'
      );
    });
  });

  describe('dangerous code removal', () => {
    it('replaces SSR typeof checks with undefined literals', () => {
      expect(
        removeDangerousCodeWithOxc(
          'if (typeof window !== "undefined") { doBrowserWork(); }',
          filename
        )
      ).toContain('"undefined" !== "undefined"');
    });

    it('removes control statements whose bodies are stripped', () => {
      expect(
        removeDangerousCodeWithOxc(
          [
            'let idle = (cb) => setTimeout(cb, 500);',
            'if (typeof requestIdleCallback != "undefined")',
            '  idle = (cb) => requestIdleCallback(cb);',
            'while (a) fetch(a);',
            'if (b) {} else setTimeout(b);',
            'const keep = 1;',
          ].join('\n'),
          filename
        )
      ).toMatchInlineSnapshot(`
        "let idle = (cb) => setTimeout(cb, 500);



        const keep = 1;"
      `);
    });

    it('removes emptied control statements even when their headers mutate live bindings', () => {
      const preeval = removeDangerousCodeWithOxc(
        [
          'let idle = (cb) => setTimeout(cb, 500);',
          'let a = 1;',
          'let i = 0;',
          'if (typeof requestIdleCallback != "undefined")',
          '  idle = (cb) => requestIdleCallback(cb);',
          'while (a) fetch(a);',
          'do fetch(a); while (a);',
          'label: fetch(a);',
          'while (a--) fetch(a);',
          'for (; i < 3; i++) fetch(i);',
          'export const out = [a, i];',
          'export const get = () => idle;',
        ].join('\n'),
        filename
      );

      expect(
        shakeOxcToESM(preeval, filename, { onlyExports: ['out', 'get'] }).code
      ).toMatchInlineSnapshot(`
        "let idle = (cb) => setTimeout(cb, 500);
        let a = 1;
        let i = 0;






        export const out = [a, i];
        export const get = () => idle;"
      `);
    });

    it.each([
      'if (unknown) fetch();',
      'if (unknown) { fetch(); setTimeout(work); }',
      'if (unknown) fetch(); else clearTimeout(timer);',
      'if (unknown) { fetch(); } else { clearTimeout(timer); }',
      'while (unknown) fetch();',
      'while (unknown) { fetch(); clearTimeout(timer); }',
      'do fetch(); while (unknown);',
      'do { fetch(); } while (unknown);',
      'for (; unknown; update()) fetch();',
      'for (; unknown; update()) { fetch(); }',
      'for (const key in unknown) fetch(key);',
      'for (const key in unknown) { fetch(key); }',
      'for (const [key] of [null]) fetch(key);',
      'for (const [key] of [null]) { fetch(key); }',
      'label: fetch();',
      'label: { fetch(); }',
      'label: if (unknown) while (unknown) fetch();',
    ])('does not evaluate a removed control statement: %s', (statement) => {
      expect(evaluateOut(`${statement}\nexport const out = 1;`)).toBe(1);
    });

    it.each([
      'clearTimeout(timers.pop());',
      '{ clearTimeout(timers.pop()); }',
      '{ clearTimeout(timers.pop()); fetch("/cleanup"); }',
      'if (ready) clearTimeout(timers.pop()); else fetch("/cleanup");',
    ])('does not leave a nonterminating timer cleanup loop: %s', (body) => {
      expect(
        evaluateOut(
          [
            'const timers = [1, 2];',
            'let count = 0;',
            `while (timers.length && ++count) ${body}`,
            'export const out = count;',
          ].join('\n')
        )
      ).toBe(0);
    });

    it.each([
      'if (false) fetch(); else out = 2;',
      'if (true) out = 2; else fetch();',
      'if (false) while (++out) fetch(); else out = 2;',
      'if (false) label: while (++out) fetch(); else out = 2;',
      'if (false) { while (++out) { fetch(); } } else out = 2;',
    ])('preserves a surviving conditional branch: %s', (statement) => {
      expect(evaluateOut(`let out = 1; ${statement} export { out };`)).toBe(2);
    });

    it('preserves a loop when safe statements remain in its body', () => {
      expect(
        evaluateOut(
          'let out = 0; while (out < 3) { clearTimeout(out); out++; } export { out };'
        )
      ).toBe(3);
    });

    it('preserves an originally empty loop that computes a live value', () => {
      expect(
        evaluateOut('let out = 0; for (; out < 3; out++) {} export { out };')
      ).toBe(3);
    });

    it('removes browser-global statements', () => {
      const code = removeDangerousCodeWithOxc(
        'const first = fetch; const second = window.fetch; const keep = 1;',
        filename
      );

      expect(code).not.toContain('fetch');
      expect(code).not.toContain('first');
      expect(code).not.toContain('second');
      expect(code).toContain('keep');
    });

    it('removes queued globals when matching window members appear later', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'const first = fetch;',
          'const second = fetch;',
          'const third = window.fetch;',
        ].join('\n'),
        filename
      );

      expect(code).not.toContain('fetch');
      expect(code).not.toContain('first');
      expect(code).not.toContain('second');
      expect(code).not.toContain('third');
    });

    it('does not remove imported names from aliased import specifiers', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'import { Comment as CommentComponent, commentContentStyle } from "./comment";',
          'window.Comment;',
          'export const keep = CommentComponent ? commentContentStyle : "";',
        ].join('\n'),
        filename
      );

      expect(code).toContain(
        'import { Comment as CommentComponent, commentContentStyle } from "./comment";'
      );
      expect(code).not.toContain('import {  as CommentComponent');
      expect(code).not.toContain('window.Comment');
      expect(code).toContain('export const keep = CommentComponent');
    });

    it('preserves imported names in aliased import specifiers', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'import { jsx as _jsx } from "react/jsx-runtime";',
          'import { Range as RcRange } from "rc-slider";',
          'const Range = () => _jsx(RcRange, {});',
          'export default Range;',
        ].join('\n'),
        filename
      );

      expect(code).toContain('import { Range as RcRange } from "rc-slider";');
      expect(code).toContain('const Range = () => { return null; };');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('removes exported browser-global declarations without leaving dangling export syntax', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'export const isApple = /Mac|iPhone|iPad/.test(navigator.platform);',
          'export const isMac = navigator.platform.toLocaleLowerCase().includes("mac");',
          'export const keep = 1;',
        ].join('\n'),
        filename
      );

      expect(code).not.toContain('navigator');
      expect(code).not.toContain('export ;');
      expect(code).not.toContain('export \n');
      expect(code).toContain('export const keep = 1;');
    });

    it('removes class fields initialized from browser globals without leaving invalid member expressions', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'export class Model {',
          '  private readonly input = document.createElement("input");',
          '  readonly keep = 1;',
          '}',
        ].join('\n'),
        filename
      );

      expect(code).not.toContain('document.createElement');
      expect(code).not.toContain('= .createElement');
      expect(code).toContain('readonly keep = 1;');
    });

    it('preserves arrow function bodies that reference browser globals (deferred body)', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'export const removeLoader = () => {',
          '  const loader = document.getElementById("preloader");',
          '  if (loader) document.body.removeChild(loader);',
          '};',
        ].join('\n'),
        filename
      );

      expect(code).toContain('export const removeLoader = () =>');
      expect(code).toContain('document.getElementById');
      expect(code).toContain('removeChild(loader)');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('preserves valid default export syntax when a browser-bound component is sanitized', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'const InitialLoader = () => {',
          '  document.getElementById("preloader");',
          '  return <div />;',
          '};',
          'export default InitialLoader;',
        ].join('\n'),
        '/test.tsx'
      );

      expect(code).not.toContain('export default ;');
      expect(code).toContain('export default InitialLoader;');
      expect(() => stripTypesAndJsxWithOxc(code, '/test.tsx')).not.toThrow();
    });

    it('preserves generated processor helper closures that reference sanitized bindings', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'const CommonModal = () => {',
          '  document.body.style.overflowY = "hidden";',
          '  return <div />;',
          '};',
          'const _exp = () => CommonModal;',
          'export default { __wyw_meta: { extends: _exp() } };',
        ].join('\n'),
        '/test.tsx'
      );

      expect(code).toContain('const _exp = () => CommonModal;');
      expect(code).not.toContain('"extends": ()');
      expect(() => stripTypesAndJsxWithOxc(code, '/test.tsx')).not.toThrow();
    });

    it('preserves object-property references to sanitized local bindings', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'const Body = () => {',
          '  document.body.style.overflowY = "hidden";',
          '  return <div />;',
          '};',
          'export default { body: Body };',
        ].join('\n'),
        '/test.tsx'
      );

      expect(code).toContain('export default { body: Body };');
      expect(code).not.toContain('body: ,');
      expect(() => stripTypesAndJsxWithOxc(code, '/test.tsx')).not.toThrow();
    });

    it('replaces object spread references to removed local bindings with empty objects', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'const details = (() => {',
          '  document.body.style.overflowY = "hidden";',
          '  return { Panel: { body: 1 } };',
          '})();',
          'export default { ...details.Panel };',
        ].join('\n'),
        '/test.tsx'
      );

      expect(code).toContain('export default { ...{} };');
      expect(code).not.toContain('....Panel');
      expect(() => stripTypesAndJsxWithOxc(code, '/test.tsx')).not.toThrow();
    });

    it('preserves function declaration bodies that reference browser globals (deferred body)', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'function read(version) {',
          '  const raw = localStorage.getItem("key");',
          '  const parsed = JSON.parse(raw);',
          '  if (parsed.version !== version) {',
          '    return null;',
          '  }',
          '  return parsed.value;',
          '}',
        ].join('\n'),
        filename
      );

      expect(code).toContain('function read(version)');
      expect(code).toContain('localStorage.getItem');
      expect(code).toContain('parsed.version');
      expect(code).toContain('parsed.value');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('preserves loops inside function bodies that reference browser globals (deferred body)', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'function clear(prefix) {',
          '  for (let i = localStorage.length - 1; i >= 0; i--) {',
          '    const key = localStorage.key(i);',
          '    if (key && key.startsWith(prefix)) {',
          '      localStorage.removeItem(key);',
          '    }',
          '  }',
          '}',
        ].join('\n'),
        filename
      );

      expect(code).toContain('function clear(prefix)');
      expect(code).toContain('localStorage.length');
      expect(code).toContain('localStorage.removeItem');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('removes top-level React refresh helpers but preserves references inside deferred bodies', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'var _s = $RefreshSig$();',
          'function Component() { _s(); return null; }',
          '$RefreshReg$(Component, "Component");',
          'function $RefreshReg$(type, id) { return type; }',
          'function $RefreshSig$() { return () => () => {}; }',
        ].join('\n'),
        filename
      );

      // top-level $Refresh* declarations and call sites are gone…
      expect(code).not.toContain('var _s =');
      expect(code).not.toContain('function $RefreshReg$');
      expect(code).not.toContain('function $RefreshSig$');
      expect(code).not.toMatch(/^\$RefreshReg\$\(/m);
      // …but the callable Component body stays intact, even though it
      // references the now-removed `_s` helper. Component is never called
      // during preeval, so the dangling reference is harmless.
      expect(code).toContain('function Component()');
      expect(code).toContain('_s();');
    });

    it('preserves promise callbacks whose bodies touch forbidden globals (deferred body)', () => {
      const code = removeDangerousCodeWithOxc(
        [
          "const base = Promise.resolve('ok');",
          'base.then(() => setTimeout(() => {}));',
          'const keep = 1;',
        ].join('\n'),
        filename
      );

      expect(code).toContain('base.then(() => setTimeout(() => {}));');
      expect(code).toContain('keep');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('replaces JSX with null', () => {
      const code = removeDangerousCodeWithOxc(
        'const Component = () => <div>Children</div>;',
        '/test.tsx'
      );

      expect(code).toBe('const Component = () => { return null; };');
    });

    it('replaces React runtime component bodies with null-returning functions', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'import { jsx as _jsx } from "react/jsx-runtime";',
          'const Component = (props) => _jsx("div", props);',
        ].join('\n'),
        '/test.tsx'
      );

      expect(code).toContain('const Component = () => { return null; };');
    });

    it('replaces transpiled CommonJS React createElement component bodies with null-returning functions', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'var _interopRequireWildcard = require("@babel/runtime/helpers/interopRequireWildcard").default;',
          'var React = _interopRequireWildcard(require("react"));',
          'const Component = (props) => React.createElement("div", props);',
        ].join('\n'),
        filename
      );

      expect(code).toContain('const Component = () => { return null; };');
      expect(code).not.toContain('React.createElement');
    });

    it('replaces components matched by configured type imports', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'import type React from "react";',
          'import type { Cmp } from "some-other-lib";',
          'const First: React.FC<{ children: string }> = ({ children }) => children;',
          'const Second: Cmp<{ children: string }> = ({ children }) => children;',
          'const Third = ({ children }) => children;',
        ].join('\n'),
        '/test.tsx',
        {
          componentTypes: {
            react: ['...'],
            'some-other-lib': ['Cmp'],
          },
        }
      );

      expect(code).toContain(
        'const First: React.FC<{ children: string }> = () => null;'
      );
      expect(code).toContain(
        'const Second: Cmp<{ children: string }> = () => null;'
      );
      expect(code).toContain('const Third = ({ children }) => children;');
    });

    it('replaces configured HOC calls with null-returning functions', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'import { connect } from "redux";',
          'import Redux from "redux";',
          'const First = connect(mapStateToProps)(MyComponent);',
          'const Second = Redux.connect(mapStateToProps)(MyComponent);',
        ].join('\n'),
        filename,
        {
          hocs: {
            redux: ['connect'],
          },
        }
      );

      expect(code).toContain('const First = () => null;');
      expect(code).toContain('const Second = () => null;');
    });

    it('replaces default React HOC calls with null-returning functions', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'import React, { memo } from "react";',
          'const BareFirst = () => null;',
          'const BareSecond = () => null;',
          'const First = React.forwardRef(BareFirst);',
          'const Second = memo(BareSecond);',
        ].join('\n'),
        filename
      );

      expect(code).toContain('const First = () => null;');
      expect(code).toContain('const Second = () => null;');
    });

    it('keeps default React HOC bindings when arguments use forbidden globals', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'import React from "react";',
          'const InputFieldRender = () => {',
          '  setTimeout(() => {}, 1);',
          '  return null;',
          '};',
          'const BareInputField = React.forwardRef(InputFieldRender);',
          'const _exp = () => BareInputField;',
        ].join('\n'),
        filename
      );

      expect(code).toContain('const BareInputField = () => null;');
      expect(code).toContain('const _exp = () => BareInputField;');
    });

    it('replaces class render components with null-returning functions', () => {
      const code = removeDangerousCodeWithOxc(
        'class Component { render() { return <div />; } }',
        '/test.tsx'
      );

      expect(code).toBe('function Component() { return null; }');
    });

    it('preserves class methods whose name matches a forbidden global', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'export class Api {',
          '  fetch() { return 1; }',
          '  setTimeout() { return 2; }',
          '  keep() { return 3; }',
          '}',
        ].join('\n'),
        filename
      );

      expect(code).toContain('fetch() { return 1; }');
      expect(code).toContain('setTimeout() { return 2; }');
      expect(code).toContain('keep() { return 3; }');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('preserves class fields whose name matches a forbidden global', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'export class Api {',
          '  fetch = 1;',
          '  setTimeout = 2;',
          '  keep = 3;',
          '}',
        ].join('\n'),
        filename
      );

      expect(code).toContain('fetch = 1;');
      expect(code).toContain('setTimeout = 2;');
      expect(code).toContain('keep = 3;');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('preserves object property keys whose name matches a forbidden global', () => {
      const code = removeDangerousCodeWithOxc(
        'export default { fetch: 1, setTimeout: 2, keep: 3 };',
        filename
      );

      expect(code).toContain('fetch: 1');
      expect(code).toContain('setTimeout: 2');
      expect(code).toContain('keep: 3');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('does not skip computed property keys that reference forbidden globals', () => {
      const code = removeDangerousCodeWithOxc(
        ['const dangerous = { [fetch]: 1 };', 'const keep = 1;'].join('\n'),
        filename
      );

      expect(code).not.toContain('[fetch]');
      expect(code).not.toContain('dangerous');
      expect(code).toContain('const keep = 1;');
    });

    it('replaces shorthand object property values referencing forbidden globals with undefined', () => {
      const code = removeDangerousCodeWithOxc(
        'export default { fetch, keep: 1 };',
        filename
      );

      expect(code).toContain('fetch: undefined');
      expect(code).toContain('keep: 1');
      expect(code).not.toMatch(/\{\s*,/);
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('replaces explicit object property values referencing forbidden globals with undefined', () => {
      const code = removeDangerousCodeWithOxc(
        'export default { sub: setTimeout, keep: 1 };',
        filename
      );

      expect(code).toContain('sub: undefined');
      expect(code).toContain('keep: 1');
      expect(code).not.toMatch(/:\s*,/);
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('preserves shorthand re-exports of locally-bound helpers transitively touching forbidden globals', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'let initEventListener = () => {',
          '  window.addEventListener("message", (event) => {',
          '    setTimeout(() => notify(event.data), 50);',
          '  });',
          '  initEventListener = () => {};',
          '};',
          'const listeners = new Set();',
          'const subscribe = (fn) => { initEventListener(); listeners.add(fn); };',
          'const unsubscribe = (fn) => { listeners.delete(fn); };',
          'export default { subscribe, unsubscribe };',
        ].join('\n'),
        filename
      );

      expect(code).toContain('export default { subscribe, unsubscribe }');
      expect(code).not.toMatch(/\{\s*,/);
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('preserves an exported arrow function whose body references a forbidden global (deferred body)', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'export const isFlagPresent = (flag) =>',
          '  globalThis.window && new RegExp(`[?&]${flag}\\b`).test(window.location.search);',
        ].join('\n'),
        filename
      );

      expect(code).toContain('export const isFlagPresent = (flag) =>');
      expect(code).toContain('globalThis.window');
      expect(code).toContain('window.location.search');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('preserves an exported arrow whose body calls a forbidden identifier (deferred body)', () => {
      const code = removeDangerousCodeWithOxc(
        'export const fetchProxy = (...args) => fetch(...args);',
        filename
      );

      expect(code).toContain(
        'export const fetchProxy = (...args) => fetch(...args)'
      );
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('preserves an exported function declaration whose body references a forbidden global', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'export function isFlagPresent(flag) {',
          '  return Boolean(window.location.search.includes(flag));',
          '}',
        ].join('\n'),
        filename
      );

      expect(code).toContain('export function isFlagPresent(flag)');
      expect(code).toContain('window.location.search');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('preserves a detached named export whose backing function references a forbidden global', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'const isFlagPresent = (flag) => window.location.search.includes(flag);',
          'export { isFlagPresent };',
        ].join('\n'),
        filename
      );

      expect(code).toContain(
        'const isFlagPresent = (flag) => window.location.search.includes(flag)'
      );
      expect(code).toContain('export { isFlagPresent }');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('treats a same-module function declaration as a local binding for forbidden globals', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'const first = fetch("/api/first");',
          'function fetch(url) {',
          '  return url;',
          '}',
          'const second = fetch("/api/second");',
        ].join('\n'),
        filename
      );

      expect(code).toContain('const first = fetch("/api/first");');
      expect(code).toContain('function fetch(url)');
      expect(code).toContain('const second = fetch("/api/second");');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('preserves a class method body that references forbidden globals', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'export class Storage {',
          '  read(key) {',
          '    return localStorage.getItem(key);',
          '  }',
          '}',
        ].join('\n'),
        filename
      );

      expect(code).toContain('read(key)');
      expect(code).toContain('localStorage.getItem(key)');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('still strips immediately-invoked function expressions that touch forbidden globals', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'const details = (() => {',
          '  document.body.style.overflowY = "hidden";',
          '  return { panel: 1 };',
          '})();',
          'const keep = 1;',
        ].join('\n'),
        filename
      );

      expect(code).not.toContain('document.body.style.overflowY');
      expect(code).toContain('keep');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('does not leave a bare await when removing a top-level forbidden fetch call', () => {
      const code = removeDangerousCodeWithOxc(
        ['await fetch("/api");', 'const keep = 1;'].join('\n'),
        filename
      );

      expect(code).not.toContain('await fetch');
      expect(code).not.toMatch(/\bawait\b(?!\s*\()/);
      expect(code).toContain('const keep = 1;');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('preserves sibling declarators in the same exported declaration when one top-level initializer references a forbidden global', () => {
      const code = removeDangerousCodeWithOxc(
        'export const dangerous = window.location.search, keep = 1;',
        filename
      );

      expect(code).toContain('export');
      expect(code).toContain('dangerous = undefined');
      expect(code).toContain('keep = 1');
      expect(code).not.toContain('window.location');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('preserves a default-exported alias whose source transitively references a forbidden global', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'const Button_Button = (props) => {',
          '  window.setTimeout(() => {}, 100);',
          '  return props ?? null;',
          '};',
          'const Core_Button = Button_Button;',
          'export default Core_Button;',
        ].join('\n'),
        filename
      );

      expect(code).toContain('const Core_Button = undefined;');
      expect(code).toContain('export default Core_Button;');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it.each([
      ['detached named export', 'const Alias = Source;', 'export { Alias };'],
      [
        'detached default export',
        'const Alias = Source;',
        'export { Alias as default };',
      ],
      ['direct named export', 'export const Alias = Source;', ''],
    ])(
      'preserves an alias binding used by a %s',
      (_, declaration, exportStatement) => {
        const code = removeDangerousCodeWithOxc(
          [
            'const Source = window.location;',
            declaration,
            exportStatement,
          ].join('\n'),
          filename
        );

        expect(code).toContain('const Alias = undefined;');
        if (exportStatement) {
          expect(code).toContain(exportStatement);
        } else {
          expect(code).toContain('export const Alias = undefined;');
        }
        expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
      }
    );
  });
});
