import { hasLoop } from '../hasLoop';

type Node = { name: string; parents: Node[] };

const node = (name: string, parents: Node[] = []): Node => ({ name, parents });

describe('hasLoop', () => {
  it('returns true when the name is the parent itself', () => {
    expect(hasLoop('a', node('a'))).toBe(true);
  });

  it('returns true when the name is a distant ancestor', () => {
    const root = node('a');
    const chain = node('d', [node('c', [node('b', [root])])]);

    expect(hasLoop('a', chain)).toBe(true);
  });

  it('returns true when the ancestors contain a cycle', () => {
    const b = node('b');
    const c = node('c', [b]);
    b.parents.push(c);

    expect(hasLoop('a', node('d', [b]))).toBe(true);
  });

  it('returns false when the name is not an ancestor', () => {
    const shared = node('shared');
    const left = node('left', [shared]);
    const right = node('right', [shared]);

    expect(hasLoop('a', node('leaf', [left, right]))).toBe(false);
  });

  it('finds the name through a later branch after exploring an earlier one', () => {
    const shared = node('shared');
    const target = node('target');
    const left = node('left', [shared]);
    const right = node('right', [shared, target]);

    expect(hasLoop('target', node('leaf', [left, right]))).toBe(true);
  });

  it('follows every generation of a module that shares a name', () => {
    const target = node('target');
    const first = node('x');
    const second = node('x', [target]);

    expect(
      hasLoop('target', node('leaf', [node('c', [first]), node('d', [second])]))
    ).toBe(true);
  });

  it('reads the parents of every ancestor once', () => {
    // A ladder: every node of a layer has both nodes of the layer below as
    // parents, so a walk of every path reads each ladder node 2^depth times.
    const read = new Set<Node>();
    const counted = (name: string, parents: Node[] = []): Node => {
      const result = { name } as Node;
      Object.defineProperty(result, 'parents', {
        get() {
          if (read.has(result)) {
            throw new Error(`the parents of ${name} were read twice`);
          }

          read.add(result);
          return parents;
        },
      });
      return result;
    };

    let layer = [counted('root-0'), counted('root-1')];
    for (let depth = 0; depth < 20; depth += 1) {
      layer = [
        counted(`layer-${depth}-0`, layer),
        counted(`layer-${depth}-1`, layer),
      ];
    }

    expect(hasLoop('missing', counted('leaf', layer))).toBe(false);
    expect(read.size).toBe(43);
  });
});
