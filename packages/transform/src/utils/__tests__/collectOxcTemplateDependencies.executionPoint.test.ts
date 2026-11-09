/* eslint-env jest */
import dedent from 'dedent';

import { collectOxcTemplateDependencies } from '../collectOxcTemplateDependencies';

const filename = '/source.tsx';

const collect = (code: string) =>
  collectOxcTemplateDependencies(code, filename, true);

// Template interpolations are evaluated lazily at the end of the module, while
// the initializer of a module binding runs at its declaration. A `var` read
// before its declaration has the value of the place where the read runs, not
// the value of the place where it stands in the source.
describe('the execution point of a static evaluation', () => {
  it.each([
    ['a nullish fallback', "color ?? 'blue'", 'red'],
    ['a logical or', "color || 'blue'", 'red'],
    ['a logical and', "color && 'green'", 'green'],
    ['typeof', 'typeof color', 'string'],
    ['a comparison', "color === undefined ? 'blue' : color", 'red'],
    ['a plain read', 'color', 'red'],
  ])(
    'reads a later var in %s of an interpolation at the end of the module',
    (_description, expression, expected) => {
      const result = collect(dedent`
        const template = tag\`${`\${${expression}}`}\`;

        var color = 'red';
      `);

      expect(result.staticValues).toEqual([{ name: '_exp', value: expected }]);
    }
  );

  it.each([
    ['returns the var', "return color ?? 'blue';"],
    [
      'reads the var into a local',
      "const value = color;\nreturn value ?? 'blue';",
    ],
  ])(
    'reads a later var in a function that %s, called from an interpolation, at the end of the module',
    (_description, body) => {
      const result = collect(dedent`
        function pick() {
          ${body}
        }

        const template = tag\`${'${pick()}'}\`;

        var color = 'red';
      `);

      expect(result.staticValues).toEqual([{ name: '_exp', value: 'red' }]);
    }
  );

  it.each([
    ['reads the var', "const c = color ?? 'blue';"],
    [
      'calls a function that reads the var',
      "function pick() {\n  return color ?? 'blue';\n}\nconst c = pick();",
    ],
  ])(
    'reads a var in an initializer that %s at its declaration, not at the end of the module',
    (_description, declaration) => {
      const result = collect(dedent`
        ${declaration}

        var color = 'red';

        const template = tag\`${'${c}'}\`;
      `);

      expect(result.staticValues).toEqual([{ name: '_exp', value: 'blue' }]);
    }
  );

  it.each([
    ['a reassignment', "var color = 'red';\ncolor = 'green';"],
    [
      'a conditional assignment',
      "var color;\nif (Date.now() > 0) {\n  color = 'red';\n}",
    ],
  ])(
    'leaves an interpolation to eval when the value of the var at the end of the module is unknown after %s',
    (_description, declaration) => {
      const result = collect(dedent`
        const template = tag\`${"${color ?? 'blue'}"}\`;

        ${declaration}
      `);

      expect(result.staticValues).toEqual([]);
      expect(result.dependencyNames).toEqual(['color']);
    }
  );
});
