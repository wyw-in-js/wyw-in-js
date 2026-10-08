import type { Program } from 'oxc-parser';

/**
 * One edit of a source file, in source coordinates: the text in
 * `[start, end)` becomes `value`. An edit with `start === end` is an
 * insertion, an edit with an empty `value` is a removal.
 */
export type OxcEdit = {
  end: number;
  start: number;
  value: string;
};

export type OxcEditRange = Pick<OxcEdit, 'end' | 'start'>;

/**
 * Where an insertion goes: a source offset, or a symbolic anchor resolved
 * against the program of the source.
 *
 * - `after-imports`: after the last top-level import declaration; without
 *   imports, after the hashbang line or at the start of the file.
 */
export type OxcEditAnchor = number | 'after-imports';

export type OxcInsertOptions = {
  /**
   * Keep the inserted text on its own lines: add a line break before and after
   * it unless the source already has one there (or the anchor is at an edge).
   */
  ownLine?: boolean;
};

/**
 * A set of edits for one source text.
 *
 * All edits use the coordinates of the original source, so their addition
 * order never shifts positions. Conflicts are resolved when the edits are
 * applied:
 * - edits whose ranges partially overlap are rejected;
 * - an edit nested in a wider edit is dropped (the wider one wins), and of two
 *   edits with the same range the one added first wins;
 * - an insertion strictly inside a replaced range is dropped; at the start of
 *   a replaced range it goes before the new text, at its end it goes after;
 * - insertions at the same position are emitted latest-added first.
 */
export type OxcFileEdits = {
  add(edits: readonly OxcEdit[]): OxcFileEdits;
  apply(): string;
  applyInRange(range: OxcEditRange): string;
  insert(
    anchor: OxcEditAnchor,
    value: string,
    options?: OxcInsertOptions
  ): OxcFileEdits;
  readonly isEmpty: boolean;
  remove(start: number, end: number): OxcFileEdits;
  replace(start: number, end: number, value: string): OxcFileEdits;
  readonly source: string;
};

const describeRange = ({ end, start }: OxcEditRange): string =>
  `[${start}, ${end})`;

const assertRange = (
  { end, start }: OxcEditRange,
  { end: limitEnd, start: limitStart }: OxcEditRange
): void => {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < limitStart ||
    start > end ||
    end > limitEnd
  ) {
    throw new RangeError(
      `Oxc edit ${describeRange({ end, start })} is outside of ${describeRange({
        end: limitEnd,
        start: limitStart,
      })}`
    );
  }
};

/**
 * Resolves conflicts between edits and returns the surviving ones in output
 * order (see `OxcFileEdits` for the rules).
 */
const resolveEdits = (edits: readonly OxcEdit[]): OxcEdit[] => {
  const replacementIndexes: number[] = [];
  const insertionIndexes: number[] = [];
  for (let idx = 0; idx < edits.length; idx += 1) {
    const edit = edits[idx]!;
    (edit.start === edit.end ? insertionIndexes : replacementIndexes).push(idx);
  }

  replacementIndexes.sort(
    (a, b) =>
      edits[a]!.start - edits[b]!.start ||
      edits[b]!.end - edits[a]!.end ||
      a - b
  );

  const replacements: OxcEdit[] = [];
  let outer: OxcEdit | undefined;
  for (let idx = 0; idx < replacementIndexes.length; idx += 1) {
    const edit = edits[replacementIndexes[idx]!]!;
    if (outer && edit.start < outer.end) {
      if (edit.end <= outer.end) {
        // eslint-disable-next-line no-continue
        continue;
      }

      throw new Error(
        `Oxc edits overlap without containment: ${describeRange(
          outer
        )} and ${describeRange(edit)}`
      );
    }

    replacements.push(edit);
    outer = edit;
  }

  if (insertionIndexes.length === 0) {
    return replacements;
  }

  insertionIndexes.sort((a, b) => edits[a]!.start - edits[b]!.start || b - a);

  const ordered: OxcEdit[] = [];
  let next = 0;
  for (let idx = 0; idx < insertionIndexes.length; idx += 1) {
    const insertion = edits[insertionIndexes[idx]!]!;
    let isInsideReplacement = false;
    while (
      next < replacements.length &&
      replacements[next]!.start < insertion.start
    ) {
      if (replacements[next]!.end > insertion.start) {
        isInsideReplacement = true;
        break;
      }

      ordered.push(replacements[next]!);
      next += 1;
    }

    if (!isInsideReplacement) {
      ordered.push(insertion);
    }
  }

  for (; next < replacements.length; next += 1) {
    ordered.push(replacements[next]!);
  }

  return ordered;
};

const render = (
  source: string,
  edits: readonly OxcEdit[],
  range: OxcEditRange
): string => {
  const ordered = resolveEdits(edits);
  let cursor = range.start;
  let result = '';
  for (let idx = 0; idx < ordered.length; idx += 1) {
    const edit = ordered[idx]!;
    result += source.slice(cursor, edit.start) + edit.value;
    cursor = edit.end;
  }

  return result + source.slice(cursor, range.end);
};

const resolveAfterImports = (source: string, program: Program): number => {
  for (let idx = program.body.length - 1; idx >= 0; idx -= 1) {
    const statement = program.body[idx]!;
    if (statement.type === 'ImportDeclaration') {
      return statement.end;
    }
  }

  if (!source.startsWith('#!')) {
    return 0;
  }

  const newline = source.indexOf('\n');
  return newline === -1 ? source.length : newline + 1;
};

/**
 * Starts an edit session for `source`. `program` is the parsed `source`; it is
 * only needed to resolve symbolic anchors.
 */
export const createOxcFileEdits = (
  source: string,
  program?: Program
): OxcFileEdits => {
  const fileRange: OxcEditRange = { end: source.length, start: 0 };
  const edits: OxcEdit[] = [];

  const resolveAnchor = (anchor: OxcEditAnchor): number => {
    if (typeof anchor === 'number') {
      return anchor;
    }

    if (!program) {
      throw new Error(
        `Oxc edit anchor "${anchor}" needs the program of the source`
      );
    }

    return resolveAfterImports(source, program);
  };

  const session: OxcFileEdits = {
    add(nextEdits) {
      for (let idx = 0; idx < nextEdits.length; idx += 1) {
        const edit = nextEdits[idx]!;
        assertRange(edit, fileRange);
        edits.push(edit);
      }

      return session;
    },
    apply() {
      return edits.length === 0 ? source : render(source, edits, fileRange);
    },
    applyInRange(range) {
      assertRange(range, fileRange);
      for (let idx = 0; idx < edits.length; idx += 1) {
        assertRange(edits[idx]!, range);
      }

      return edits.length === 0
        ? source.slice(range.start, range.end)
        : render(source, edits, range);
    },
    insert(anchor, value, options) {
      const position = resolveAnchor(anchor);
      if (!options?.ownLine) {
        return session.add([{ end: position, start: position, value }]);
      }

      const before = position > 0 && source[position - 1] !== '\n' ? '\n' : '';
      const after =
        position < source.length && source[position] !== '\n' ? '\n' : '';
      return session.add([
        { end: position, start: position, value: `${before}${value}${after}` },
      ]);
    },
    get isEmpty() {
      return edits.length === 0;
    },
    remove(start, end) {
      return session.add([{ end, start, value: '' }]);
    },
    replace(start, end, value) {
      return session.add([{ end, start, value }]);
    },
    source,
  };

  return session;
};

/** Applies `edits` to `source` (see `OxcFileEdits` for conflict rules). */
export const applyOxcEdits = (
  source: string,
  edits: readonly OxcEdit[]
): string => createOxcFileEdits(source).add(edits).apply();

/**
 * Applies `edits` to `source` and returns the edited text of `range` only.
 * Every edit must lie inside `range`.
 */
export const applyOxcEditsInRange = (
  source: string,
  edits: readonly OxcEdit[],
  range: OxcEditRange
): string => createOxcFileEdits(source).add(edits).applyInRange(range);
