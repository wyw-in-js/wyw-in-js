import { SourceMapConsumer } from 'source-map';

import type { Artifact, Replacements, Rules } from '@wyw-in-js/shared';

import { asyncActionRunner } from '../../actions/actionRunner';
import {
  createEntrypoint,
  createServices,
  getHandlers,
} from '../../__tests__/entrypoint-helpers';
import type { Services } from '../../types';
import { extract, extractCssFromAst } from '../extract';

const filename = '/path/to/src/file.js';

const rule = (className: string, cssText: string, line: number) => ({
  className,
  displayName: className,
  cssText,
  start: { line, column: 0 },
});

const mappedLines = async (sourceMapText: string) => {
  const consumer = await new SourceMapConsumer(JSON.parse(sourceMapText));
  const lines: Record<string, number> = {};
  try {
    consumer.eachMapping((mapping) => {
      if (mapping.name === null) {
        throw new Error(`Mapping at line ${mapping.generatedLine} has no name`);
      }
      lines[mapping.name] = mapping.generatedLine;
    });
  } finally {
    consumer.destroy();
  }
  return lines;
};

const ruleLines = (cssText: string, selectors: string[]) =>
  Object.fromEntries(
    selectors.map((selector) => {
      const index = cssText
        .split('\n')
        .findIndex((line) => line.startsWith(selector));
      if (index === -1) {
        throw new Error(`No line starts with ${selector}`);
      }
      return [selector, index + 1];
    })
  );

const expectMappingsToPointAtRules = async (
  result: ReturnType<typeof extractCssFromAst>
) => {
  expect(await mappedLines(result.cssSourceMapText)).toEqual(
    ruleLines(result.cssText, Object.keys(result.rules))
  );
};

describe('extractCssFromAst', () => {
  it('maps single-line rules to consecutive lines', async () => {
    const rules: Rules = {
      '.a': rule('a', 'color: red;', 1),
      '.b': rule('b', 'color: blue;', 2),
    };

    const result = extractCssFromAst(rules, '', { filename });

    expect(result.cssText).toBe('.a{color:red;}\n.b{color:blue;}\n');
    expect(await mappedLines(result.cssSourceMapText)).toEqual({
      '.a': 1,
      '.b': 2,
    });
  });

  it('accounts for multi-line comments kept in a rule', async () => {
    const rules: Rules = {
      '.a': rule('a', '/* one\n   two */\ncolor: red;', 1),
      '.b': rule('b', 'color: blue;', 2),
      '.c': rule('c', 'color: green;', 3),
    };

    const result = extractCssFromAst(rules, '', {
      filename,
      keepComments: true,
    });

    expect(result.cssText).toBe(
      '.a{/* one\n   two */color:red;}\n.b{color:blue;}\n.c{color:green;}\n'
    );
    expect(await mappedLines(result.cssSourceMapText)).toEqual({
      '.a': 1,
      '.b': 3,
      '.c': 4,
    });
  });

  it('accounts for a string continued on the next line', async () => {
    const rules: Rules = {
      '.a': rule('a', 'content:"a\\\nb";color: red;', 1),
      '.b': rule('b', 'color: blue;', 2),
    };

    await expectMappingsToPointAtRules(
      extractCssFromAst(rules, '', { filename })
    );
  });

  it('inserts atoms verbatim and accounts for their lines', async () => {
    const rules: Rules = {
      '.a': {
        ...rule('a', '.a{color:red;}\n.a:hover{color:blue;}', 1),
        atom: true,
      },
      '.b': rule('b', 'color: green;', 2),
    };

    const result = extractCssFromAst(rules, '', { filename });

    expect(result.cssText).toBe(
      '.a{color:red;}\n.a:hover{color:blue;}\n.b{color:green;}\n'
    );
    expect(await mappedLines(result.cssSourceMapText)).toEqual({
      '.a': 1,
      '.b': 3,
    });
  });

  it('accounts for multi-line rules from the none preprocessor', async () => {
    const rules: Rules = {
      '.a': rule('a', '\n  color: red;\n', 1),
      '.b': rule('b', 'color: blue;', 2),
    };

    const result = extractCssFromAst(rules, '', {
      filename,
      preprocessor: 'none',
    });

    expect(result.cssText).toBe(
      '.a {\n  color: red;\n}\n\n.b {color: blue;}\n\n'
    );
    expect(await mappedLines(result.cssSourceMapText)).toEqual({
      '.a': 1,
      '.b': 5,
    });
  });
});

describe('extract', () => {
  const cssArtifact = (
    rules: Rules,
    replacements: Replacements = []
  ): Artifact => ['css', [rules, replacements]];

  const replacement = (line: number): Replacements[number] => ({
    length: 1,
    original: {
      start: { line, column: 0 },
      end: { line, column: 1 },
    },
  });

  const runExtract = (processors: { artifacts: Artifact[] }[]) => {
    const services = createServices();
    services.options = { filename } as Services['options'];
    const entrypoint = createEntrypoint(services, filename, ['*'], '');
    const action = entrypoint.createAction('extract', { processors }, null);

    return asyncActionRunner(action, getHandlers<'sync'>({ extract }));
  };

  it('merges css artifacts of all processors in order', async () => {
    const result = await runExtract([
      {
        artifacts: [
          cssArtifact({ '.a': rule('a', 'color: red;', 1) }, [replacement(1)]),
          ['meta', { ignored: true }],
        ],
      },
      { artifacts: [] },
      {
        artifacts: [
          cssArtifact(
            {
              '.b': rule('b', 'color: blue;', 2),
              '.c': rule('c', 'color: green;', 3),
            },
            [replacement(2), replacement(3)]
          ),
        ],
      },
      {
        artifacts: [
          cssArtifact({ '.d': rule('d', 'color: black;', 4) }),
          cssArtifact({ '.e': rule('e', 'color: white;', 5) }, [
            replacement(5),
          ]),
        ],
      },
    ]);

    expect(result.cssText).toBe(
      '.a{color:red;}\n.b{color:blue;}\n.c{color:green;}\n.d{color:black;}\n.e{color:white;}\n'
    );
    expect(Object.keys(result.rules)).toEqual(['.a', '.b', '.c', '.d', '.e']);
    expect(result.replacements).toEqual([
      replacement(1),
      replacement(2),
      replacement(3),
      replacement(5),
    ]);
  });

  it('keeps the first position and the last value of a repeated selector', async () => {
    const result = await runExtract([
      {
        artifacts: [
          cssArtifact({
            '.a': rule('a', 'color: red;', 1),
            '.b': rule('b', 'color: blue;', 2),
          }),
        ],
      },
      {
        artifacts: [
          cssArtifact({
            '.c': rule('c', 'color: green;', 3),
            '.a': rule('a', 'color: black;', 4),
          }),
        ],
      },
    ]);

    expect(result.cssText).toBe(
      '.a{color:black;}\n.b{color:blue;}\n.c{color:green;}\n'
    );
    expect(Object.keys(result.rules)).toEqual(['.a', '.b', '.c']);
    expect(result.rules['.a'].start).toEqual({ line: 4, column: 0 });
  });

  it('does not mutate the rules of a processor', async () => {
    const first: Rules = { '.a': rule('a', 'color: red;', 1) };
    const second: Rules = { '.b': rule('b', 'color: blue;', 2) };

    const result = await runExtract([
      { artifacts: [cssArtifact(first)] },
      { artifacts: [cssArtifact(second)] },
    ]);

    expect(result.rules).not.toBe(first);
    expect(Object.keys(first)).toEqual(['.a']);
    expect(Object.keys(second)).toEqual(['.b']);
  });

  it('returns empty css when no processor has css artifacts', async () => {
    const result = await runExtract([
      { artifacts: [['meta', {}]] },
      { artifacts: [] },
    ]);

    expect(result.cssText).toBe('');
    expect(result.cssSourceMapText).toBe('');
    expect(result.rules).toEqual({});
    expect(result.replacements).toEqual([]);
  });
});
