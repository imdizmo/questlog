import { GRID, newId, snap, type BoardEdge, type BoardNode } from '../../../shared/board';

/** What a node stands for in the project: `card:<id>` for task nodes, or the `ref` a tree label carries (`project:`, `area:`, `deck:`). */
export const refOf = (n: BoardNode): string | null =>
  n.type === 'card' ? `card:${String(n.value.id)}` : typeof n.value.ref === 'string' ? n.value.ref : null;

export const WAITS_FOR = 'waits for';
export const SUBTASK = 'subtask';

export const SCENE = { w: 220, h: 280 };
/**
 * A storyline's frames as picture cards in a row, each joined to the one before it. Only frames not on the board yet
 * are planned (to the right of what is there), so branches and moved cards stay as the user left them.
 */
export function planStoryboard(frameIds: string[], nodes: BoardNode[]): { nodes: BoardNode[]; edges: BoardEdge[] } {
  const have = new Map(nodes.filter((n) => n.type === 'card').map((n) => [String(n.value.id), n]));
  const out: BoardNode[] = [], edges: BoardEdge[] = [];
  // One line, left to right, in the storyline's order: an empty board starts clear of the tool rail, later frames go
  // to the right of what is there.
  let x = nodes.length ? snap(Math.max(...nodes.map((n) => n.pos.x + n.pos.w)) + 4 * GRID) : 4 * GRID;
  let prev: BoardNode | undefined;
  for (const id of frameIds) {
    let n = have.get(id);
    if (!n) {
      n = { id: newId(), type: 'card', value: { id, mode: 'scene' }, pos: { x, y: 2 * GRID, ...SCENE, parent: null } };
      x = snap(x + SCENE.w + 7 * GRID); // room for a choice's label on the line
      out.push(n);
      if (prev) edges.push({ id: newId(), value: { source: { nodeId: prev.id, side: 'right' }, target: { nodeId: n.id, side: 'left' } } });
    }
    prev = n;
  }
  return { nodes: out, edges };
}
