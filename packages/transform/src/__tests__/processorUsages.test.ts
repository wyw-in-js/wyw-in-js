import { createRequire } from 'module';

import type { ProcessorClass } from '../processors/processorLookup';
import {
  addProcessorDeclaration,
  collectProcessorUsages,
} from '../utils/applyOxcProcessors/processorUsages';
import type { DefinedProcessor } from '../utils/applyOxcProcessors/types';
import { parseOxc } from '../utils/collectOxcTemplateDependencies/scopeAnalysis';

const processor: ProcessorClass = createRequire(import.meta.url)(
  './__fixtures__/test-css-processor.js'
).default;
const processors = new Map<string, DefinedProcessor>([
  ['css', [processor, { imported: 'css', source: 'test-package' }]],
]);

const collect = (body: string) => {
  const code = `import { css } from 'test-package';\n${body}`;
  const program = parseOxc(code, 'usages.js');
  const declarations = new Map<string, number[]>();
  addProcessorDeclaration(declarations, 'css', code.indexOf('css'));
  const usages = collectProcessorUsages(program, processors, declarations);
  return {
    sources: usages.map(({ target }) => code.slice(target.start, target.end)),
    usages,
  };
};

it('keeps usages when only other names are declared', () => {
  expect(
    collect(`
      const unrelated = 1;
      export const first = css\`color: red;\`;
      export function render(value, { item }) {
        return css\`color: blue;\`;
      }
    `).sources
  ).toEqual(['css`color: red;`', 'css`color: blue;`']);
});

it.each([
  ['a parameter', 'export const render = (css) => css`color: blue;`;'],
  [
    'a parameter with a default',
    'export const render = (css = String.raw) => css`color: blue;`;',
  ],
  [
    'a destructured variable',
    'export function render(theme) { const { css } = theme; return css`color: blue;`; }',
  ],
  [
    'a local variable',
    'export function render() { const css = String.raw; return css`color: blue;`; }',
  ],
  [
    'a function declaration',
    "export function render() { function css() { return ''; } return css`color: blue;`; }",
  ],
  [
    'a named function expression',
    'export const render = function css() { return css`color: blue;`; };',
  ],
  [
    'a class declaration',
    'export function render() { class css {} return css`color: blue;`; }',
  ],
  ['a catch parameter', 'try { run(); } catch (css) { css`color: blue;`; }'],
  [
    'a parameter called as a function',
    "export const render = (css) => css({ color: 'blue' });",
  ],
])('drops usages of the processor name redeclared by %s', (_, body) => {
  expect(
    collect(`export const first = css\`color: red;\`;\n${body}`).sources
  ).toEqual(['css`color: red;`']);
});

it('retains independent ancestor snapshots across sibling and nested usages', () => {
  const { usages } = collect(`
    export const first = css\`color: red;\`;
    export function render() {
      return css\`color: blue;\`;
    }
  `);
  expect(
    usages.map(({ ancestors }) => ancestors.map((node) => node.type))
  ).toEqual([
    [
      'Program',
      'ExportNamedDeclaration',
      'VariableDeclaration',
      'VariableDeclarator',
    ],
    [
      'Program',
      'ExportNamedDeclaration',
      'FunctionDeclaration',
      'BlockStatement',
      'ReturnStatement',
    ],
  ]);
  expect(usages[0].ancestors).not.toBe(usages[1].ancestors);
});
