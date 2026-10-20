type LoopNode = {
  name: string;
  parents: readonly LoopNode[];
};

export function hasLoop(name: string, parent: LoopNode): boolean {
  const onPath = new Set<string>();
  // Explored nodes, not names: the generations of a module share its name but
  // not its parents. Each node's parents are still walked once.
  const explored = new Set<LoopNode>();

  const visit = (node: LoopNode): boolean => {
    if (node.name === name || onPath.has(node.name)) {
      return true;
    }

    if (explored.has(node)) {
      return false;
    }

    onPath.add(node.name);
    for (const candidate of node.parents) {
      if (visit(candidate)) {
        return true;
      }
    }

    onPath.delete(node.name);
    explored.add(node);
    return false;
  };

  return visit(parent);
}
