import { DEFAULT_SIZE, GRID, newId, snap, type BoardEdge, type BoardNode, type Side } from '../../../shared/board';
import type { Card, CardDep, Deck, Project } from '../../../shared/types';

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

export interface TreeInput {
  project: Project;
  /** The project's lists, in order. */
  decks: Deck[];
  /** Every task that may appear (the caller leaves out done, archived and lore). */
  cards: Card[];
  deps: CardDep[];
  areaName(spaceId: number): string;
  nodes: BoardNode[];
  edges: BoardEdge[];
}

const LABEL = { w: 200, h: 40 };
const X = { project: 0, area: 260, list: 520 };
const PER_ROW = 6;

/**
 * The project as a tree on the board: project → areas → lists → open tasks → subtasks, plus a line per dependency.
 * Only what is missing is planned, so running it again after the project changed adds the new tasks and lines and
 * leaves everything the user has moved where it is.
 */
export function planProjectTree(inp: TreeInput): { nodes: BoardNode[]; edges: BoardEdge[] } {
  const have = new Map<string, BoardNode>();
  for (const n of inp.nodes) { const r = refOf(n); if (r && !have.has(r)) have.set(r, n); }
  const nodes: BoardNode[] = [], edges: BoardEdge[] = [];
  const linked = new Set(inp.edges.map((e) => `${e.value.source.nodeId}>${e.value.target.nodeId}`));
  const link = (a: BoardNode, b: BoardNode, label?: string, sides: [Side, Side] = ['right', 'left']) => {
    if (linked.has(`${a.id}>${b.id}`) || linked.has(`${b.id}>${a.id}`)) return;
    linked.add(`${a.id}>${b.id}`);
    edges.push({ id: newId(), value: { source: { nodeId: a.id, side: sides[0] }, target: { nodeId: b.id, side: sides[1] } }, ...(label ? { label } : {}) });
  };
  const add = (ref: string, make: () => BoardNode): BoardNode => {
    const old = have.get(ref);
    if (old) return old;
    const n = make();
    nodes.push(n); have.set(ref, n);
    return n;
  };
  const label = (ref: string, text: string, x: number, y: number) =>
    add(ref, () => ({ id: newId(), type: 'text', value: { content: text, ref }, pos: { x, y: snap(y), ...LABEL, parent: null } }));
  // A fresh tree starts below whatever is already on the board.
  const y0 = inp.nodes.length ? snap(Math.max(...inp.nodes.map((n) => n.pos.y + n.pos.h)) + 4 * GRID) : 0;
  const card = DEFAULT_SIZE.card, stepX = card.w + GRID, stepY = card.h + 2 * GRID;

  const open = new Map(inp.cards.map((c) => [c.id, c]));
  const kids = new Map<string, Card[]>();
  for (const c of inp.cards) if (c.parentCardId && open.has(c.parentCardId)) { const l = kids.get(c.parentCardId); if (l) l.push(c); else kids.set(c.parentCardId, [c]); }
  const bySort = (a: Card, b: Card) => a.sortIndex - b.sortIndex || a.seq - b.seq;

  const root = label(`project:${inp.project.id}`, inp.project.name, X.project, y0);
  let y = y0;
  for (const space of inp.project.spaces) {
    const lists = inp.decks.filter((d) => d.spaceId === space.id);
    if (!lists.length) continue;
    const area = label(`area:${inp.project.id}:${space.id}`, inp.areaName(space.id), X.area, y);
    link(root, area);
    for (const d of lists) {
      const list = label(`deck:${d.id}`, d.title, X.list, y);
      link(area, list);
      const tops = inp.cards.filter((c) => c.deckId === d.id && !(c.parentCardId && open.has(c.parentCardId))).sort(bySort);
      // Each task is followed by its subtasks, so a family sits together.
      const seq = tops.flatMap((t) => [t, ...(kids.get(t.id) ?? []).sort(bySort)]);
      let placed = 0;
      for (const c of seq) {
        const node = add(`card:${c.id}`, () => {
          // A list's tasks sit in rows under its label, so the lines fan out without crossing a neighbour.
          const at = { x: X.list + 2 * GRID + (placed % PER_ROW) * stepX, y: snap(y + LABEL.h + 2 * GRID + Math.floor(placed / PER_ROW) * stepY) };
          placed += 1;
          return { id: newId(), type: 'card', value: { id: c.id, mode: 'mini' }, pos: { ...at, ...card, parent: null } };
        });
        const parent = c.parentCardId ? have.get(`card:${c.parentCardId}`) : undefined;
        if (parent) link(parent, node, SUBTASK); else link(list, node, undefined, ['bottom', 'top']);
      }
      y += LABEL.h + 2 * GRID + Math.ceil(placed / PER_ROW) * stepY;
    }
    y += 2 * GRID;
  }
  for (const dep of inp.deps) {
    const a = have.get(`card:${dep.lockedCardId}`), b = have.get(`card:${dep.lockingCardId}`);
    if (a && b) link(a, b, WAITS_FOR, ['top', 'top']);
  }
  return { nodes, edges };
}
