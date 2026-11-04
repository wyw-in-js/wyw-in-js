import { createRequire } from 'module';

import type { ProcessorClass } from '../processors/processorLookup';
import {
  addProcessorDeclaration,
  collectProcessorUsages,
} from '../utils/applyOxcProcessors/processorUsages';
import type { DefinedProcessor } from '../utils/applyOxcProcessors/types';
import { parseOxc } from '../utils/collectOxcTemplateDependencies/scopeAnalysis';
import { walkOxc } from '../utils/oxc/ast';

const processor: ProcessorClass = createRequire(import.meta.url)(
  './__fixtures__/test-css-processor.js'
).default;
const processors = new Map<string, DefinedProcessor>([
  ['css', [processor, { imported: 'css', source: 'test-package' }]],
]);

const input = () => {
  const code = `
    import { css } from 'test-package';
    ${Array.from(
      { length: 32 },
      (_, index) => `const unrelated_${index} = ${index};`
    ).join('\n')}
    export const first = css\`color: red;\`;
    export function render() {
      return css\`color: blue;\`;
    }
  `;
  const program = parseOxc(code, 'usages.js');
  const declarations = new Map<string, number[]>();
  addProcessorDeclaration(declarations, 'css', code.indexOf('css'));
  return { program, declarations };
};

it('does not populate binding-pattern caches for unrelated identifier declarations', () => {
  const { program, declarations } = input();
  const unrelated = new Set<WeakKey>();
  walkOxc(program, (node) => {
    if (node.type === 'Identifier' && node.name.startsWith('unrelated_')) {
      unrelated.add(node);
    }
  });
  const writes: WeakKey[] = [];
  const { set } = WeakMap.prototype;
  const spy = jest
    .spyOn(WeakMap.prototype, 'set')
    .mockImplementation(function recordBindingCacheWrite(
      this: WeakMap<WeakKey, unknown>,
      key: WeakKey,
      value: unknown
    ) {
      if (unrelated.has(key)) {
        writes.push(key);
      }
      return set.call(this, key, value);
    });
  try {
    expect(
      collectProcessorUsages(program, processors, declarations)
    ).toHaveLength(2);
    expect(writes).toHaveLength(0);
  } finally {
    spy.mockRestore();
  }
});

it('retains independent ancestor snapshots across sibling and nested usages', () => {
  const { program, declarations } = input();
  const usages = collectProcessorUsages(program, processors, declarations);
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
