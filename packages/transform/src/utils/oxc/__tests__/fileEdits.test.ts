/* eslint-env jest */
import { parseOxcProgram } from '../parse';
import {
  applyOxcEdits,
  applyOxcEditsInRange,
  createOxcFileEdits,
  mergeOxcRemovals,
  type OxcEdit,
} from '../fileEdits';

const edit = (start: number, end: number, value: string): OxcEdit => ({
  end,
  start,
  value,
});

describe('applyOxcEdits', () => {
  it('returns the source when there is nothing to apply', () => {
    expect(applyOxcEdits('abcdef', [])).toBe('abcdef');
  });

  it('applies disjoint replacements, removals and insertions in source coordinates', () => {
    expect(
      applyOxcEdits('abcdef', [
        edit(4, 6, 'EF!'),
        edit(0, 1, ''),
        edit(2, 2, '+'),
        edit(1, 2, 'B'),
      ])
    ).toBe('B+cdEF!');
  });

  it('does not depend on the order edits were added and leaves them untouched', () => {
    const edits = [edit(0, 1, 'A'), edit(3, 4, 'D'), edit(1, 3, '')];
    const snapshot = JSON.stringify(edits);

    expect(applyOxcEdits('abcdef', edits)).toBe('ADef');
    expect(applyOxcEdits('abcdef', [...edits].reverse())).toBe('ADef');
    expect(JSON.stringify(edits)).toBe(snapshot);
  });

  describe('overlaps', () => {
    it('rejects partially overlapping edits in either order', () => {
      expect(() =>
        applyOxcEdits('abcdef', [edit(1, 4, 'left'), edit(3, 5, 'right')])
      ).toThrow('Oxc edits overlap without containment: [1, 4) and [3, 5)');
      expect(() =>
        applyOxcEdits('abcdef', [edit(3, 5, 'right'), edit(1, 4, 'left')])
      ).toThrow('Oxc edits overlap without containment: [1, 4) and [3, 5)');
    });

    it('treats edits that only touch as disjoint', () => {
      expect(applyOxcEdits('abcdef', [edit(2, 4, 'X'), edit(0, 2, 'Y')])).toBe(
        'YXef'
      );
    });

    it('rejects ranges outside of the source', () => {
      expect(() => applyOxcEdits('abc', [edit(2, 4, '')])).toThrow(RangeError);
      expect(() => applyOxcEdits('abc', [edit(-1, 1, '')])).toThrow(RangeError);
      expect(() => applyOxcEdits('abc', [edit(2, 1, '')])).toThrow(RangeError);
    });
  });

  describe('nesting', () => {
    it('keeps the outer edit regardless of addition order', () => {
      const outer = edit(1, 5, 'outer');
      const inner = edit(2, 4, 'inner');

      expect(applyOxcEdits('abcdef', [inner, outer])).toBe('aouterf');
      expect(applyOxcEdits('abcdef', [outer, inner])).toBe('aouterf');
    });

    it('keeps the earlier edit for equal ranges', () => {
      expect(
        applyOxcEdits('abc', [edit(0, 3, 'processor'), edit(0, 3, 'dangerous')])
      ).toBe('processor');
    });

    it('drops nested edits that start or end at the outer boundary', () => {
      expect(
        applyOxcEdits('abcdef', [
          edit(1, 2, 'head'),
          edit(1, 5, 'X'),
          edit(4, 5, 'tail'),
        ])
      ).toBe('aXf');
    });

    it('ignores conflicts between edits that a wider edit replaces anyway', () => {
      expect(
        applyOxcEdits('abcdefgh', [
          edit(2, 5, 'left'),
          edit(4, 6, 'right'),
          edit(1, 7, 'X'),
        ])
      ).toBe('aXh');
    });
  });

  describe('insertions', () => {
    it('keeps boundary insertions and drops interior insertions', () => {
      expect(
        applyOxcEdits('abcdef', [
          edit(1, 5, 'X'),
          edit(1, 1, '<'),
          edit(3, 3, 'discarded'),
          edit(5, 5, '>'),
        ])
      ).toBe('a<X>f');
    });

    it('drops interior insertions added before the replacement', () => {
      expect(
        applyOxcEdits('abcdef', [
          edit(3, 3, 'discarded'),
          edit(1, 1, '<'),
          edit(1, 5, 'X'),
        ])
      ).toBe('a<Xf');
    });

    it('puts an insertion between two adjacent replacements', () => {
      expect(
        applyOxcEdits('abcd', [
          edit(2, 2, '|'),
          edit(0, 2, 'L'),
          edit(2, 4, 'R'),
        ])
      ).toBe('L|R');
    });

    it('emits the latest insertion first when several share a position', () => {
      expect(
        applyOxcEdits('ab', [edit(1, 1, '1'), edit(1, 1, '2'), edit(1, 1, '3')])
      ).toBe('a321b');
    });

    it('supports insertions at both ends of the source', () => {
      expect(applyOxcEdits('ab', [edit(2, 2, '>'), edit(0, 0, '<')])).toBe(
        '<ab>'
      );
    });
  });
});

describe('applyOxcEditsInRange', () => {
  it('returns the edited text of the range only', () => {
    expect(
      applyOxcEditsInRange('const a = b + c;', [edit(10, 11, 'B')], {
        end: 15,
        start: 10,
      })
    ).toBe('B + c');
  });

  it('keeps insertions on the range bounds', () => {
    expect(
      applyOxcEditsInRange(
        'xx(a)xx',
        [edit(2, 2, 'f'), edit(5, 5, '!'), edit(3, 4, 'b')],
        { end: 5, start: 2 }
      )
    ).toBe('f(b)!');
  });

  it('returns the range text when there are no edits', () => {
    expect(applyOxcEditsInRange('abcdef', [], { end: 4, start: 1 })).toBe(
      'bcd'
    );
  });

  it('rejects edits outside of the range', () => {
    expect(() =>
      applyOxcEditsInRange('abcdef', [edit(0, 2, 'X')], { end: 4, start: 1 })
    ).toThrow(RangeError);
  });
});

describe('createOxcFileEdits', () => {
  const parse = (code: string) => parseOxcProgram(code, 'file.js', 'module');

  it('collects edits through the session and applies them once', () => {
    const edits = createOxcFileEdits('let a = 1;');
    edits.replace(4, 5, 'b').insert(10, '\nexport { b };').remove(8, 9);
    edits.add([edit(0, 3, 'var')]);

    expect(edits.source).toBe('let a = 1;');
    expect(edits.apply()).toBe('var b = ;\nexport { b };');
  });

  describe('anchors', () => {
    it('inserts after the last import declaration', () => {
      const code = "import a from 'a';\nimport b from 'b';\nconst c = a + b;\n";
      const edits = createOxcFileEdits(code, parse(code));

      edits.insert('after-imports', "\nimport c from 'c';");

      expect(edits.apply()).toBe(
        "import a from 'a';\nimport b from 'b';\nimport c from 'c';\nconst c = a + b;\n"
      );
    });

    it('inserts after a hashbang when there are no imports', () => {
      const code = '#!/usr/bin/env node\nrun();\n';
      const edits = createOxcFileEdits(code, parse(code));

      edits.insert('after-imports', 'setup();\n');

      expect(edits.apply()).toBe('#!/usr/bin/env node\nsetup();\nrun();\n');
    });

    it('inserts at the start of a file without imports or hashbang', () => {
      const code = 'run();\n';
      const edits = createOxcFileEdits(code, parse(code));

      edits.insert('after-imports', 'setup();\n');

      expect(edits.apply()).toBe('setup();\nrun();\n');
    });

    it('puts own-line insertions on separate lines only where needed', () => {
      const sameLine = "import a from 'a';run(a);";
      const ownLine = "import a from 'a';\nrun(a);";
      const insert = (code: string) =>
        createOxcFileEdits(code, parse(code))
          .insert('after-imports', "import b from 'b';", { ownLine: true })
          .apply();

      expect(insert(sameLine)).toBe(
        "import a from 'a';\nimport b from 'b';\nrun(a);"
      );
      expect(insert(ownLine)).toBe(
        "import a from 'a';\nimport b from 'b';\nrun(a);"
      );
      expect(insert('')).toBe("import b from 'b';");
    });

    it('resolves anchors in source coordinates next to other edits', () => {
      const code = "import a from 'a';\nconst x = a;\n";
      const edits = createOxcFileEdits(code, parse(code));

      edits
        .replace(0, 18, "import a from 'A';")
        .insert('after-imports', '\nconst y = 1;');

      expect(edits.apply()).toBe(
        "import a from 'A';\nconst y = 1;\nconst x = a;\n"
      );
    });

    it('requires a program to resolve symbolic anchors', () => {
      expect(() =>
        createOxcFileEdits('run();').insert('after-imports', 'x')
      ).toThrow('after-imports');
    });
  });
});

describe('mergeOxcRemovals', () => {
  it('merges overlapping and touching removals into one', () => {
    expect(
      mergeOxcRemovals([
        edit(6, 8, ''),
        edit(0, 3, ''),
        edit(2, 5, ''),
        edit(5, 6, ''),
      ])
    ).toEqual([edit(0, 8, '')]);
  });

  it('keeps edits with new text apart from removals', () => {
    expect(
      mergeOxcRemovals([edit(4, 6, ''), edit(0, 2, ''), edit(2, 4, 'X')])
    ).toEqual([edit(0, 2, ''), edit(2, 4, 'X'), edit(4, 6, '')]);
  });

  it('does not mutate the given removals', () => {
    const removals = [edit(0, 3, ''), edit(2, 5, '')];

    mergeOxcRemovals(removals);

    expect(removals).toEqual([edit(0, 3, ''), edit(2, 5, '')]);
  });
});
