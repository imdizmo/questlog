import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { convertTree, layoutFrames, macroSummary, orderInList, reconcile, type BoardPatch, type FrameInput } from '../web/src/board/projectFrames';
import { boardMaps, boardUndo, LOCAL, readBoard, readProjectId, writePatch } from '../web/src/board/useBoard';
import { refOf, SUBTASK, WAITS_FOR } from '../web/src/board/projectTree';
import { isMacro, MACRO_BELOW, macroView, tasksLeft } from '../web/src/board/macro';
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../shared/board';
import { containerAt, type BoardEdge, type BoardNode, type Rect } from '../shared/board';
import type { Card, CardDep, Deck, Project, Space } from '../shared/types';

const spaces = [{ id: 1, name: 'World' }, { id: 2, name: 'Combat' }, { id: 3, name: 'Empty' }] as unknown as Space[];
const project = { id: 'p1', name: 'Game', spaces } as unknown as Project;
const deck = (id: string, spaceId: number) => ({ id, spaceId, title: `List ${id}` }) as unknown as Deck;
const card = (id: string, deckId: string, extra: Partial<Card> = {}) =>
  ({ id, deckId, seq: Number(id.slice(1)), sortIndex: Number(id.slice(1)), parentCardId: null, ...extra }) as unknown as Card;

const decks = [deck('d1', 1), deck('d2', 1), deck('d3', 2)];
// d1: eight tasks (two rows), c3 is a subtask of c1; d2 empty; d3 one task; area 3 empty.
const cards = [
  card('c1', 'd1'), card('c2', 'd1'), card('c3', 'd1', { parentCardId: 'c1' }), card('c4', 'd1'), card('c5', 'd1'),
  card('c6', 'd1'), card('c7', 'd1'), card('c8', 'd1'), card('c9', 'd3'),
];
const deps: CardDep[] = [{ lockedCardId: 'c9', lockingCardId: 'c2' }];
const input = (over: Partial<FrameInput> = {}): FrameInput => ({
  project, spaces, decks, cards, deps, gone: new Set(), areaName: (id) => spaces.find((s) => s.id === id)!.name ?? '', nodes: [], edges: [], ...over,
});

function apply(nodes: BoardNode[], edges: BoardEdge[], p: BoardPatch): { nodes: BoardNode[]; edges: BoardEdge[] } {
  const gone = new Set(p.remove), goneE = new Set(p.removeEdges), moved = new Map(p.move.map((m) => [m.id, m.pos]));
  const vals = new Map(p.update.map((u) => [u.id, u.value]));
  return {
    nodes: [...nodes.filter((n) => !gone.has(n.id)).map((n) => ({ ...n, pos: moved.get(n.id) ?? n.pos, value: vals.get(n.id) ?? n.value })), ...p.add],
    edges: [...edges.filter((e) => !goneE.has(e.id)), ...p.addEdges],
  };
}
const empty: BoardPatch = { add: [], addEdges: [], move: [], remove: [], removeEdges: [], update: [] };
const byRef = (nodes: BoardNode[], ref: string) => nodes.find((n) => refOf(n) === ref)!;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const fresh = () => apply([], [], layoutFrames(input(), { x: 0, y: 0 }));

describe('layoutFrames', () => {
  it('fresh layout shape', () => {
    const p = layoutFrames(input(), { x: 0, y: 0 });
    expect(p.move).toEqual([]); expect(p.remove).toEqual([]);
    const { nodes, edges } = apply([], [], p);
    const header = byRef(nodes, 'project:p1');
    expect(header.type).toBe('text');
    expect(header.value.content).toBe('Game');
    const a1 = byRef(nodes, 'area:p1:1'), a2 = byRef(nodes, 'area:p1:2'), a3 = byRef(nodes, 'area:p1:3');
    for (const a of [a1, a2, a3]) { expect(a.type).toBe('container'); expect(a.pos.parent).toBeNull(); }
    expect(a1.value.label).toBe('World');
    // areas left to right, below the header
    expect(a1.pos.x).toBeLessThan(a2.pos.x); expect(a2.pos.x).toBeLessThan(a3.pos.x);
    expect(a1.pos.y).toBeGreaterThanOrEqual(header.pos.y + header.pos.h);
    expect(overlap(a1.pos, a2.pos) || overlap(a2.pos, a3.pos)).toBe(false);
    // lists stacked in their area; an empty list and an empty area still get a frame
    const l1 = byRef(nodes, 'deck:d1'), l2 = byRef(nodes, 'deck:d2'), l3 = byRef(nodes, 'deck:d3');
    expect(l1.value.label).toBe('List d1');
    expect([l1.pos.parent, l2.pos.parent, l3.pos.parent]).toEqual([a1.id, a1.id, a2.id]);
    expect(l2.pos.y).toBeGreaterThanOrEqual(l1.pos.y + l1.pos.h);
    expect(l2.pos.w).toBeGreaterThan(0); expect(a3.pos.h).toBeGreaterThan(0);
    // cards: mini, in their list, rows of 6 in order (c3 follows its parent c1)
    const row = ['c1', 'c3', 'c2', 'c4', 'c5', 'c6', 'c7', 'c8'].map((id) => byRef(nodes, `card:${id}`));
    for (const c of row) { expect(c.value.mode).toBe('mini'); expect(c.pos.parent).toBe(l1.id); }
    expect(new Set(row.slice(0, 6).map((c) => c.pos.y)).size).toBe(1);
    for (let i = 1; i < 6; i++) expect(row[i].pos.x).toBeGreaterThan(row[i - 1].pos.x);
    expect(row[6].pos.y).toBeGreaterThan(row[0].pos.y); expect(row[6].pos.x).toBe(row[0].pos.x);
    // every node sits inside its parent, which is also the smallest container around it
    for (const n of nodes) expect(containerAt(nodes, n.pos, n.id)).toBe(n.pos.parent);
    // edges: waits for and subtask only, no list/area lines
    const id = (r: string) => byRef(nodes, r).id;
    expect(edges.map((e) => [e.value.source.nodeId, e.value.target.nodeId, e.label]).sort()).toEqual([
      [id('card:c1'), id('card:c3'), SUBTASK], [id('card:c9'), id('card:c2'), WAITS_FOR],
    ].sort());
  });
});

describe('layoutFrames over an existing board', () => {
  it('reuses the nodes it finds, moves them as one, keeps the lines', () => {
    const b = fresh();
    const p = layoutFrames(input(b), { x: 400, y: 200 });
    expect(p.add).toEqual([]); expect(p.remove).toEqual([]); expect(p.addEdges).toEqual([]); expect(p.removeEdges).toEqual([]);
    expect(p.move).toHaveLength(b.nodes.length);
    for (const m of p.move) {
      const old = b.nodes.find((n) => n.id === m.id)!.pos;
      expect([m.pos.x - old.x, m.pos.y - old.y, m.pos.parent]).toEqual([400, 200, old.parent]);
    }
  });
});

describe('orderInList', () => {
  const ids = (cs: Card[]) => cs.map((c) => c.id);
  it('chain a→b→c gives a,b,c', () => {
    const a = card('a3', 'd'), b = card('b2', 'd'), c = card('c1', 'd'); // sort order alone would be c, b, a
    expect(ids(orderInList([c, b, a], [{ lockedCardId: 'b2', lockingCardId: 'a3' }, { lockedCardId: 'c1', lockingCardId: 'b2' }]))).toEqual(['a3', 'b2', 'c1']);
  });
  it('cycle falls back to sort order', () => {
    const a = card('a1', 'd'), b = card('b2', 'd'), c = card('c3', 'd');
    const cyc = [{ lockedCardId: 'a1', lockingCardId: 'c3' }, { lockedCardId: 'b2', lockingCardId: 'a1' }, { lockedCardId: 'c3', lockingCardId: 'b2' }];
    expect(ids(orderInList([c, a, b], cyc))).toEqual(['a1', 'b2', 'c3']);
    expect(ids(orderInList([b, a], [{ lockedCardId: 'a1', lockingCardId: 'b2' }, { lockedCardId: 'b2', lockingCardId: 'a1' }]))).toEqual(['a1', 'b2']);
  });
  it('subtasks follow their parent; a dep on a subtask orders the families', () => {
    const p1 = card('p1', 'd'), p2 = card('p2', 'd'), s = card('s3', 'd', { parentCardId: 'p1' }), t = card('t4', 'd', { parentCardId: 'p2' });
    expect(ids(orderInList([s, p2, p1], []))).toEqual(['p1', 's3', 'p2']);
    // p1's subtask waits for p2's subtask: the p2 family comes first
    expect(ids(orderInList([t, s, p2, p1], [{ lockedCardId: 's3', lockingCardId: 't4' }]))).toEqual(['p2', 't4', 'p1', 's3']);
  });
  it('deps outside the list do not matter', () => {
    expect(ids(orderInList([card('b2', 'd'), card('a1', 'd')], [{ lockedCardId: 'a1', lockingCardId: 'zz' }]))).toEqual(['a1', 'b2']);
  });
});

describe('reconcile', () => {
  it('reconcile of an up-to-date board is empty', () => {
    const b = fresh();
    expect(reconcile(input(b))).toEqual(empty);
  });

  it('moved task follows its list', () => {
    const b = fresh();
    const moved = cards.map((c) => (c.id === 'c2' ? { ...c, deckId: 'd3' } : c));
    const p = reconcile(input({ ...b, cards: moved }));
    const n2 = byRef(b.nodes, 'card:c2'), n9 = byRef(b.nodes, 'card:c9'), l3 = byRef(b.nodes, 'deck:d3');
    expect(p.move.map((m) => m.id)).toEqual([n2.id]);
    expect(p.move[0].pos).toMatchObject({ parent: l3.id, y: n9.pos.y });
    expect(p.move[0].pos.x).toBeGreaterThan(n9.pos.x);
    expect(p.add).toEqual([]); expect(p.remove).toEqual([]);
    const after = apply(b.nodes, b.edges, p);
    expect(containerAt(after.nodes, p.move[0].pos, n2.id)).toBe(l3.id);
  });

  it('done task leaves', () => {
    const b = fresh();
    const p = reconcile(input({ ...b, cards: cards.filter((c) => c.id !== 'c3'), gone: new Set(['c3']) }));
    const n3 = byRef(b.nodes, 'card:c3');
    expect(p.remove).toEqual([n3.id]);
    expect(p.removeEdges).toEqual(b.edges.filter((e) => e.label === SUBTASK).map((e) => e.id));
    expect(p.move).toEqual([]); expect(p.add).toEqual([]);
  });

  it('new task added at end of row and frame grows', () => {
    const b = fresh();
    const more = [...cards, card('c10', 'd3'), card('c11', 'd3')];
    const p = reconcile(input({ ...b, cards: more }));
    const l3 = byRef(b.nodes, 'deck:d3'), a2 = byRef(b.nodes, 'area:p1:2'), a3 = byRef(b.nodes, 'area:p1:3'), n9 = byRef(b.nodes, 'card:c9');
    expect(p.add.map(refOf)).toEqual(['card:c10', 'card:c11']);
    const [n10, n11] = p.add;
    expect(n10.pos).toMatchObject({ parent: l3.id, y: n9.pos.y });
    expect(n11.pos.y).toBe(n9.pos.y);
    expect(n9.pos.x).toBeLessThan(n10.pos.x); expect(n10.pos.x).toBeLessThan(n11.pos.x);
    const after = apply(b.nodes, b.edges, p);
    const get = (id: string) => after.nodes.find((n) => n.id === id)!;
    // the list frame and its area grow to fit; the area to the right shifts so nothing overlaps
    expect(get(l3.id).pos.w).toBeGreaterThan(l3.pos.w);
    expect(get(a2.id).pos.w).toBeGreaterThan(a2.pos.w);
    expect(get(a3.id).pos.x).toBeGreaterThan(a3.pos.x);
    expect(overlap(get(a2.id).pos, get(a3.id).pos)).toBe(false);
    for (const n of after.nodes) expect(containerAt(after.nodes, n.pos, n.id)).toBe(n.pos.parent);
    expect(p.move.map((m) => m.id).sort()).toEqual([l3.id, a2.id, a3.id].sort());
    expect(reconcile(input({ ...after, cards: more }))).toEqual(empty);
  });

  it('a list that runs onto a new row pushes the list below it down', () => {
    const b = fresh();
    const more = [...cards, ...['c12', 'c13', 'c14', 'c15', 'c16'].map((id) => card(id, 'd1'))];
    const p = reconcile(input({ ...b, cards: more }));
    const after = apply(b.nodes, b.edges, p);
    const l1 = byRef(after.nodes, 'deck:d1'), l2 = byRef(after.nodes, 'deck:d2');
    expect(l2.pos.y).toBeGreaterThanOrEqual(l1.pos.y + l1.pos.h);
    for (const n of after.nodes) expect(containerAt(after.nodes, n.pos, n.id)).toBe(n.pos.parent);
  });

  it('loose card left alone', () => {
    const b = fresh();
    const n1 = byRef(b.nodes, 'card:c1');
    const nodes = b.nodes.map((n) => (n.id === n1.id ? { ...n, pos: { ...n.pos, x: -2000, y: -2000, parent: null } } : n));
    // even when its task moved to another list
    const moved = cards.map((c) => (c.id === 'c1' ? { ...c, deckId: 'd3' } : c));
    expect(reconcile(input({ nodes, edges: b.edges, cards: moved }))).toEqual(empty);
  });

  it('card in correct frame never moved', () => {
    const b = fresh();
    const n1 = byRef(b.nodes, 'card:c1'), l1 = byRef(b.nodes, 'deck:d1');
    // dragged within its list frame to the second row
    const nodes = b.nodes.map((n) => (n.id === n1.id ? { ...n, pos: { ...n.pos, x: l1.pos.x + l1.pos.w - n.pos.w - 20, parent: l1.id } } : n));
    const p = reconcile(input({ nodes, edges: b.edges, cards: [...cards, card('c20', 'd1')] }));
    expect(p.move.map((m) => m.id)).not.toContain(n1.id);
    expect(p.add.map(refOf)).toEqual(['card:c20']);
  });

  it('deleted list frame removed when empty', () => {
    const b = fresh();
    const l2 = byRef(b.nodes, 'deck:d2'), l3 = byRef(b.nodes, 'deck:d3'), l1 = byRef(b.nodes, 'deck:d1');
    // d2 (empty) deleted: its frame goes
    const p = reconcile(input({ ...b, decks: [deck('d1', 1), deck('d3', 2)] }));
    expect(p.remove).toEqual([l2.id]);
    // d3 deleted, its task moved to d1: the task follows, then the empty frame goes
    const moved = cards.map((c) => (c.id === 'c9' ? { ...c, deckId: 'd1' } : c));
    const q = reconcile(input({ ...b, decks: [deck('d1', 1), deck('d2', 1)], cards: moved }));
    expect(q.remove).toEqual([l3.id]);
    expect(q.move.find((m) => m.id === byRef(b.nodes, 'card:c9').id)?.pos.parent).toBe(l1.id);
    // an area whose space is gone goes once empty
    const r = reconcile(input({ ...b, spaces: spaces.slice(0, 2) }));
    expect(r.remove).toEqual([byRef(b.nodes, 'area:p1:3').id]);
  });

  it('missing area and list are added', () => {
    const b = fresh();
    const sp = [...spaces, { id: 4, name: 'Audio' } as unknown as Space];
    const p = reconcile(input({ ...b, spaces: sp, decks: [...decks, deck('d4', 4), deck('d5', 1)], areaName: (id) => sp.find((s) => s.id === id)!.name ?? '' }));
    expect(p.add.map(refOf)).toEqual(['area:p1:4', 'deck:d4', 'deck:d5']);
    const after = apply(b.nodes, b.edges, p);
    const a3 = byRef(after.nodes, 'area:p1:3'), a4 = byRef(after.nodes, 'area:p1:4'), l2 = byRef(after.nodes, 'deck:d2'), l5 = byRef(after.nodes, 'deck:d5');
    expect(a4.pos.x).toBeGreaterThanOrEqual(a3.pos.x + a3.pos.w);
    expect(byRef(after.nodes, 'deck:d4').pos.parent).toBe(a4.id);
    expect(l5.pos.parent).toBe(byRef(after.nodes, 'area:p1:1').id);
    expect(l5.pos.y).toBeGreaterThanOrEqual(l2.pos.y + l2.pos.h);
    for (const n of after.nodes) expect(containerAt(after.nodes, n.pos, n.id)).toBe(n.pos.parent);
  });

  it('duplicates resolve to the smaller id', () => {
    const b = fresh();
    const n1 = byRef(b.nodes, 'card:c1');
    const dupHi = { ...n1, id: '~dup' }, dupLo = { ...n1, id: '!dup' };
    const e = { id: 'e-dup', value: { source: { nodeId: '~dup', side: 'top' as const }, target: { nodeId: n1.id, side: 'top' as const } } };
    // a newer copy (larger id) goes with its lines
    const p = reconcile(input({ nodes: [...b.nodes, dupHi], edges: [...b.edges, e] }));
    expect(p.remove).toEqual(['~dup']);
    expect(p.removeEdges).toEqual(['e-dup']);
    // a copy with a smaller id wins; the other's subtask line is redrawn from the kept node
    const q = reconcile(input({ nodes: [...b.nodes, dupLo], edges: b.edges }));
    expect(q.remove).toEqual([n1.id]);
    expect(q.addEdges.map((x) => [x.value.source.nodeId, x.label])).toEqual([['!dup', SUBTASK]]);
  });

  it('dependency edges follow the dependencies', () => {
    const b = fresh();
    const id = (r: string) => byRef(b.nodes, r).id;
    const plain = { id: 'plain', value: { source: { nodeId: id('card:c4'), side: 'top' as const }, target: { nodeId: id('card:c5'), side: 'top' as const } } };
    const p = reconcile(input({ nodes: b.nodes, edges: [...b.edges, plain], deps: [{ lockedCardId: 'c5', lockingCardId: 'c4' }] }));
    expect(p.removeEdges).toEqual(b.edges.filter((e) => e.label === WAITS_FOR).map((e) => e.id));
    expect(p.addEdges.map((e) => [e.value.source.nodeId, e.value.target.nodeId, e.label])).toEqual([[id('card:c5'), id('card:c4'), WAITS_FOR]]);
  });
});

describe('reconcile leaves what it does not own', () => {
  const plain = (id: string, a: string, b: string, label?: string): BoardEdge =>
    ({ id, ...(label ? { label } : {}), value: { source: { nodeId: a, side: 'top' }, target: { nodeId: b, side: 'top' } } });
  const mini = (id: string, task: string, x: number, y: number, parent: string | null): BoardNode =>
    ({ id, type: 'card', value: { id: task, mode: 'mini' }, pos: { x, y, w: 120, h: 160, parent } });

  it("another project's card stays", () => {
    const b = fresh();
    const n8 = byRef(b.nodes, 'card:c8'), l1 = byRef(b.nodes, 'deck:d1'), n2 = byRef(b.nodes, 'card:c2');
    // sitting in a list frame of this project, with a plain line and a "waits for" line to this project's cards
    const other = mini('other', 'x-task', n8.pos.x + 140, n8.pos.y, l1.id);
    const edges = [...b.edges, plain('e1', 'other', n2.id), plain('e2', n2.id, 'other', WAITS_FOR)];
    expect(reconcile(input({ nodes: [...b.nodes, other], edges }))).toEqual(empty);
  });

  it('a lore card stays', () => {
    const b = fresh();
    const lore = mini('lore', 'lore-1', -1000, 0, null);
    expect(reconcile(input({ nodes: [...b.nodes, lore], edges: [...b.edges, plain('e1', 'lore', byRef(b.nodes, 'card:c1').id)] }))).toEqual(empty);
  });

  it('empty input removes nothing', () => {
    const b = fresh();
    for (const over of [{ cards: [] }, { cards: [], deps: [], decks: [], spaces: [] }]) {
      const p = reconcile(input({ ...b, ...over }));
      expect([p.remove, p.removeEdges, p.move]).toEqual([[], [], []]);
    }
  });

  it('a gone task leaves with only the lines touching it', () => {
    const b = fresh();
    const id = (r: string) => byRef(b.nodes, r).id;
    const edges = [...b.edges, plain('keep', id('card:c4'), id('card:c5')), plain('mine', id('card:c3'), id('card:c6'))];
    // c3 is gone; c4 is not in `cards` but not gone either (not loaded): it stays
    const p = reconcile(input({ nodes: b.nodes, edges, cards: cards.filter((c) => c.id !== 'c3' && c.id !== 'c4'), gone: new Set(['c3']) }));
    expect(p.remove).toEqual([id('card:c3')]);
    expect(p.removeEdges.sort()).toEqual([...b.edges.filter((e) => e.label === SUBTASK).map((e) => e.id), 'mine'].sort());
  });

  it("a user line on the losing duplicate survives on the kept node", () => {
    const b = fresh();
    const n1 = byRef(b.nodes, 'card:c1'), n4 = byRef(b.nodes, 'card:c4'), n5 = byRef(b.nodes, 'card:c5');
    const dup = { ...n1, id: '~dup' };
    const edges = [...b.edges, { ...plain('u1', '~dup', n4.id), color: 'pink' as const }, plain('loop', '~dup', n1.id), plain('twin', '~dup', n5.id), plain('had', n1.id, n5.id)];
    const p = reconcile(input({ nodes: [...b.nodes, dup], edges }));
    expect(p.remove).toEqual(['~dup']);
    expect(p.removeEdges.sort()).toEqual(['loop', 'twin', 'u1']);
    // moved over: the line to c4 (colour kept); not the loop, not the one n1 already has
    expect(p.addEdges.map((e) => [e.value.source.nodeId, e.value.target.nodeId, e.label, e.color])).toEqual([[n1.id, n4.id, undefined, 'pink']]);
  });

  it("another project's list and area frames survive, with the lines on them", () => {
    const b = fresh();
    const frame = (id: string, ref: string, x: number, parent: string | null): BoardNode =>
      ({ id, type: 'container', value: { label: ref, ref }, pos: { x, y: -1000, w: 400, h: 300, parent } });
    const theirs = [frame('fl', 'deck:zz', -3000, null), frame('fa', 'area:p2:1', -2000, null), { ...frame('fal', 'deck:yy', -1980, 'fa'), pos: { x: -1980, y: -960, w: 280, h: 220, parent: 'fa' } }];
    const n1 = byRef(b.nodes, 'card:c1').id;
    const lines = [plain('u1', 'fl', n1), plain('u2', 'fa', n1), plain('u3', 'fal', 'fl')];
    const inp = input({ nodes: [...b.nodes, ...theirs], edges: [...b.edges, ...lines] });
    expect(reconcile(inp)).toEqual(empty);
    const l = layoutFrames(inp, { x: 0, y: 0 });
    expect([l.remove, l.removeEdges]).toEqual([[], []]);
    expect(l.move.map((m) => m.id).filter((id) => id.startsWith('f'))).toEqual([]);
  });

  it("a coloured user line on the losing duplicate is not taken for the kept node's plain one", () => {
    const b = fresh();
    const n1 = byRef(b.nodes, 'card:c1'), n5 = byRef(b.nodes, 'card:c5');
    const edges = [...b.edges, plain('had', n1.id, n5.id), { ...plain('pink', '~dup', n5.id), color: 'pink' as const }];
    const p = reconcile(input({ nodes: [...b.nodes, { ...n1, id: '~dup' }], edges }));
    expect(p.addEdges.map((e) => [e.value.source.nodeId, e.value.target.nodeId, e.color])).toEqual([[n1.id, n5.id, 'pink']]);
  });

  it('a duplicated list frame folds into the one with the smaller id, cards from both kept', () => {
    const b = fresh();
    const l3 = byRef(b.nodes, 'deck:d3');
    const extra: BoardNode = { ...l3, id: '~l3', pos: { ...l3.pos, x: l3.pos.x, y: l3.pos.y + 2000, parent: null } };
    const c30 = mini('n30', 'c30', extra.pos.x + 20, extra.pos.y + 40, '~l3');
    const foreign = mini('nf', 'x-task', extra.pos.x + 160, extra.pos.y + 40, '~l3');
    const more = [...cards, card('c30', 'd3')];
    const p = reconcile(input({ nodes: [...b.nodes, extra, c30, foreign], edges: [...b.edges, plain('e1', '~l3', byRef(b.nodes, 'card:c1').id)], cards: more }));
    expect(p.remove).toEqual(['~l3']);
    const after = apply([...b.nodes, extra, c30, foreign], [...b.edges, plain('e1', '~l3', byRef(b.nodes, 'card:c1').id)], p);
    const get = (id: string) => after.nodes.find((n) => n.id === id)!;
    expect([get('n30').pos.parent, get('nf').pos.parent]).toEqual([l3.id, l3.id]);
    const inList = after.nodes.filter((n) => n.pos.parent === l3.id);
    expect(inList).toHaveLength(3);
    expect(inList.some((a, i) => inList.some((c, j) => i < j && overlap(a.pos, c.pos)))).toBe(false);
    for (const n of after.nodes) expect(containerAt(after.nodes, n.pos, n.id)).toBe(n.pos.parent);
    expect(after.edges.some((e) => e.value.source.nodeId === l3.id && !e.label)).toBe(true);
    expect(reconcile(input({ ...after, cards: more }))).toEqual(empty);
  });

  it('a duplicated area frame folds in, its lists and cards with it', () => {
    const b = fresh();
    const a2 = byRef(b.nodes, 'area:p1:2'), l3 = byRef(b.nodes, 'deck:d3');
    const dy = 3000;
    const xa: BoardNode = { ...a2, id: '~a2', pos: { ...a2.pos, y: a2.pos.y + dy } };
    const xl: BoardNode = { ...l3, id: '~l3', pos: { ...l3.pos, y: l3.pos.y + dy, parent: '~a2' } };
    const xc = mini('n31', 'c31', l3.pos.x + 20, l3.pos.y + dy + 40, '~l3');
    const nodes = [...b.nodes, xa, xl, xc], more = [...cards, card('c31', 'd3')];
    const p = reconcile(input({ nodes, edges: b.edges, cards: more }));
    expect(p.remove.sort()).toEqual(['~a2', '~l3']);
    const after = apply(nodes, b.edges, p);
    expect(after.nodes.find((n) => n.id === 'n31')!.pos.parent).toBe(l3.id);
    for (const n of after.nodes) expect(containerAt(after.nodes, n.pos, n.id)).toBe(n.pos.parent);
    expect(reconcile(input({ ...after, cards: more }))).toEqual(empty);
  });

  it('a duplicated header goes, keeping its lines', () => {
    const b = fresh();
    const h = byRef(b.nodes, 'project:p1');
    const p = reconcile(input({ nodes: [...b.nodes, { ...h, id: '~h' }], edges: [...b.edges, plain('e1', '~h', byRef(b.nodes, 'card:c1').id)] }));
    expect(p.remove).toEqual(['~h']);
    expect(p.addEdges.map((e) => e.value.source.nodeId)).toEqual([h.id]);
  });

  it('renames follow: area, list and project names', () => {
    const b = fresh();
    const p = reconcile(input({
      ...b, project: { ...project, name: 'Game 2' }, decks: [{ ...decks[0], title: 'Todo' }, decks[1], decks[2]],
      areaName: (id) => (id === 2 ? 'Fights' : spaces.find((s) => s.id === id)!.name ?? ''),
    }));
    expect([p.add, p.move, p.remove]).toEqual([[], [], []]);
    const after = apply(b.nodes, b.edges, p);
    expect(byRef(after.nodes, 'deck:d1').value).toEqual({ label: 'Todo', ref: 'deck:d1' });
    expect(byRef(after.nodes, 'area:p1:2').value.label).toBe('Fights');
    expect(byRef(after.nodes, 'project:p1').value.content).toBe('Game 2');
    expect(p.update).toHaveLength(3);
  });
});

describe('macroSummary', () => {
  it('counts cards per list and sums cross-list waits-for lines only', () => {
    const b = fresh();
    const id = (r: string) => byRef(b.nodes, r).id;
    const extra: BoardEdge[] = [
      { id: 'x1', label: WAITS_FOR, value: { source: { nodeId: id('card:c9'), side: 'top' }, target: { nodeId: id('card:c4'), side: 'top' } } },
      { id: 'x2', label: SUBTASK, value: { source: { nodeId: id('card:c9'), side: 'top' }, target: { nodeId: id('card:c5'), side: 'top' } } },
      { id: 'x3', value: { source: { nodeId: id('card:c9'), side: 'top' }, target: { nodeId: id('card:c6'), side: 'top' } } },
      { id: 'x4', label: WAITS_FOR, value: { source: { nodeId: id('card:c4'), side: 'top' }, target: { nodeId: id('card:c5'), side: 'top' } } },
    ];
    const m = macroSummary(b.nodes, [...b.edges, ...extra]);
    expect(m.counts.get(id('deck:d1'))).toBe(8);
    expect(m.counts.get(id('deck:d2'))).toBe(0);
    expect(m.counts.get(id('deck:d3'))).toBe(1);
    expect(m.counts.has(id('area:p1:1'))).toBe(false);
    expect(m.links).toEqual([{ from: id('deck:d3'), to: id('deck:d1'), count: 2 }]);
  });
});

describe('macro view', () => {
  it('isMacro: only a board that follows its project, only below the threshold', () => {
    expect(isMacro(1, true)).toBe(false);
    expect(isMacro(MACRO_BELOW, true)).toBe(false);
    expect(isMacro(0.4, true)).toBe(true);
    expect(isMacro(ZOOM_MIN, true)).toBe(true);
    expect(isMacro(0.4, false)).toBe(false);
    expect(isMacro(ZOOM_MIN, false)).toBe(false);
    // The keyboard reaches it: 1 − 6 steps of 0.1 (as the canvas rounds them) is macro, 1 − 5 is not.
    expect(isMacro(Math.round((1 - 6 * ZOOM_STEP) * 10) / 10, true)).toBe(true);
    expect(isMacro(Math.round((1 - 5 * ZOOM_STEP) * 10) / 10, true)).toBe(false);
  });

  it('tasksLeft copy', () => {
    expect(tasksLeft(0)).toBe('0 tasks left');
    expect(tasksLeft(1)).toBe('1 task left');
    expect(tasksLeft(5)).toBe('5 tasks left');
  });

  it('hides the cards in list frames and their lines, keeps the rest, sums cross-list waits-for', () => {
    const b = fresh();
    const id = (r: string) => byRef(b.nodes, r).id;
    const note: BoardNode = { id: 'note', type: 'text', value: { content: 'hi' }, pos: { x: 0, y: -400, w: 160, h: 40, parent: null } };
    const loose: BoardNode = { id: 'loose', type: 'card', value: { id: 'zz', mode: 'mini' }, pos: { x: 0, y: -300, w: 120, h: 160, parent: null } };
    const extra: BoardEdge[] = [
      { id: 'n1', value: { source: { nodeId: 'note', side: 'right' }, target: { nodeId: 'loose', side: 'left' } } },
      { id: 'n2', value: { source: { nodeId: 'note', side: 'right' }, target: { nodeId: id('card:c1'), side: 'left' } } },
    ];
    const v = macroView([...b.nodes, note, loose], [...b.edges, ...extra]);
    const cardsIn = b.nodes.filter((n) => n.type === 'card').map((n) => n.id);
    expect([...v.hidden].sort()).toEqual([...cardsIn].sort());
    expect(v.hidden.has('loose')).toBe(false);
    expect(v.edges.map((e) => e.id)).toEqual(['n1']);
    expect(v.counts.get(id('deck:d1'))).toBe(8);
    expect(v.links).toEqual([{ from: id('deck:d3'), to: id('deck:d1'), count: 1 }]);
  });

  it('is pure: zooming in and out through the threshold never writes to the board document', () => {
    const doc = new Y.Doc(), maps = boardMaps(doc);
    writePatch(doc, maps, layoutFrames(input(), { x: 0, y: 0 }), LOCAL, 'p1');
    const before = Y.encodeStateAsUpdate(doc);
    let updates = 0;
    doc.on('update', () => { updates++; });
    for (let s = ZOOM_MAX; s >= ZOOM_MIN; s = Math.round((s - ZOOM_STEP) * 10) / 10) {
      const now = readBoard(doc);
      if (isMacro(s, now.projectId !== null)) macroView(now.nodes, now.edges);
    }
    for (let s = ZOOM_MIN; s <= ZOOM_MAX; s = Math.round((s + ZOOM_STEP) * 10) / 10) {
      const now = readBoard(doc);
      if (isMacro(s, now.projectId !== null)) macroView(now.nodes, now.edges);
    }
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    // Nothing about the view is kept in the document: meta holds only the board's project.
    expect([...maps.meta.keys()]).toEqual(['projectId']);
  });
});

// A board made with the old tree layout: labels for the project, two areas and two lists, lines between them and
// from the lists to their tasks, plus a note joined to a list label, an image far away, and the user's own lines.
const label = (id: string, ref: string, x: number, y: number): BoardNode => ({ id, type: 'text', value: { content: ref, ref }, pos: { x, y, w: 200, h: 40, parent: null } });
const cardNode = (c: string, x: number, y: number): BoardNode => ({ id: `n${c}`, type: 'card', value: { id: c, mode: 'mini' }, pos: { x, y, w: 200, h: 80, parent: null } });
const line = (id: string, s: string, t: string, label?: string, color?: BoardEdge['color']): BoardEdge =>
  ({ id, value: { source: { nodeId: s, side: 'right' }, target: { nodeId: t, side: 'left' } }, ...(label ? { label } : {}), ...(color ? { color } : {}) });
const treeNodes = (): BoardNode[] => [
  label('P', 'project:p1', 0, 0), label('A1', 'area:p1:1', 260, 0), label('A2', 'area:p1:2', 260, 400),
  label('L1', 'deck:d1', 520, 0), label('L3', 'deck:d3', 520, 400),
  ...cards.map((c, i) => cardNode(c.id, 560 + (i % 6) * 220, 80 + Math.floor(i / 6) * 120)),
  { id: 'note', type: 'text', value: { content: 'Remember the boss fight' }, pos: { x: 300, y: 100, w: 200, h: 80, parent: null } },
  { id: 'img', type: 'image', value: { url: '/files/x.png' }, pos: { x: 9000, y: 0, w: 200, h: 200, parent: null } },
];
const treeEdges = (): BoardEdge[] => [
  line('e-pa1', 'P', 'A1'), line('e-pa2', 'P', 'A2'), line('e-a1l1', 'A1', 'L1'), line('e-a2l3', 'A2', 'L3'),
  ...cards.filter((c) => c.deckId === 'd1' && !c.parentCardId).map((c) => line(`e-l1${c.id}`, 'L1', `n${c.id}`)),
  line('e-l3c9', 'L3', 'nc9'),
  line('e-sub', 'nc1', 'nc3', SUBTASK), line('e-dep', 'nc9', 'nc2', WAITS_FOR), line('e-plain', 'nc4', 'nc5'),
  line('e-note', 'note', 'L1', undefined, 'pink'),
];

describe('convertTree', () => {
  it('conversion keeps user content', () => {
    const nodes = treeNodes(), edges = treeEdges();
    const plan = convertTree(input({ nodes, edges }))!;
    expect(plan).not.toBeNull();
    expect(plan.projectId).toBe('p1');
    const { projectId: _p, ...patch } = plan;
    const b = apply(nodes, edges, patch);
    const ids = new Set(b.nodes.map((n) => n.id));
    // the area and list labels go; the project label stays as the header, where the tree started
    for (const l of ['A1', 'A2', 'L1', 'L3']) expect(ids.has(l)).toBe(false);
    const header = byRef(b.nodes, 'project:p1');
    expect(header.id).toBe('P');
    expect([header.pos.x, header.pos.y]).toEqual([0, 0]);
    // frames, every card in its list frame
    for (const c of cards) expect(byRef(b.nodes, `card:${c.id}`).pos.parent).toBe(byRef(b.nodes, `deck:${c.deckId}`).id);
    for (const n of b.nodes) expect(containerAt(b.nodes, n.pos, n.id)).toBe(n.pos.parent);
    // lines between labels and from lists to tasks are gone; waits for, subtask and a plain line between cards stay
    const eids = new Set(b.edges.map((e) => e.id));
    for (const e of ['e-pa1', 'e-pa2', 'e-a1l1', 'e-a2l3', 'e-l3c9', 'e-l1c1']) expect(eids.has(e)).toBe(false);
    for (const e of ['e-sub', 'e-dep', 'e-plain']) expect(eids.has(e)).toBe(true);
    // the note's line to the list label now goes to the list frame, colour kept
    const l1 = byRef(b.nodes, 'deck:d1');
    const noteLines = b.edges.filter((e) => e.value.source.nodeId === 'note');
    expect(noteLines.map((e) => [e.value.target.nodeId, e.color])).toEqual([[l1.id, 'pink']]);
    // nothing points at a node that is not there
    for (const e of b.edges) { expect(ids.has(e.value.source.nodeId)).toBe(true); expect(ids.has(e.value.target.nodeId)).toBe(true); }
    // the note overlapped the frames: moved straight down below them; the image far away did not move
    const note = b.nodes.find((n) => n.id === 'note')!, img = b.nodes.find((n) => n.id === 'img')!;
    const frames = b.nodes.filter((n) => n.pos.parent === null && (n.id === 'P' || refOf(n)?.startsWith('area:')));
    expect(note.pos.x).toBe(300);
    expect(note.pos.y).toBeGreaterThanOrEqual(Math.max(...frames.map((f) => f.pos.y + f.pos.h)));
    for (const f of frames) expect(overlap(f.pos, note.pos)).toBe(false);
    expect(img.pos).toEqual(treeNodes().find((n) => n.id === 'img')!.pos);
    // converted once: there is no tree left to arrange
    expect(convertTree(input(b))).toBeNull();
  });

  it("a user's line between a label and a task is redrawn on the frame; the tree's list→task lines go", () => {
    const nodes = [...treeNodes(), cardNode('x9', 0, 2000), cardNode('cdone', 300, 2000)];
    const edges = [
      ...treeEdges(),
      line('u-area', 'A2', 'nc1', undefined, 'green'), // area label → a task
      line('u-foreign', 'L1', 'nx9'),                  // list label → another project's task
      line('u-other', 'L1', 'nc9', WAITS_FOR),         // list label → a task of another list (labelled by the user)
      line('t-done', 'L1', 'ncdone'),                  // the tree's line to a task of that list that is done now
    ];
    const deckOf = (id: string) => (id === 'x9' ? 'dq' : id === 'cdone' ? 'd1' : cards.find((c) => c.id === id)?.deckId ?? undefined);
    const { projectId: _p, ...patch } = convertTree(input({ nodes, edges, deckOf }))!;
    const b = apply(nodes, edges, patch);
    const ids = new Set(b.edges.map((e) => e.id));
    for (const e of ['e-l1c1', 'e-l1c2', 'e-l3c9', 't-done', 'u-area', 'u-foreign', 'u-other']) expect(ids.has(e)).toBe(false);
    const at = (s: string, t: string) => b.edges.filter((e) => e.value.source.nodeId === s && e.value.target.nodeId === t);
    const a2 = byRef(b.nodes, 'area:p1:2').id, l1 = byRef(b.nodes, 'deck:d1').id;
    expect(at(a2, 'nc1').map((e) => [e.color, e.value.source.side, e.value.target.side])).toEqual([['green', 'right', 'left']]);
    expect(at(l1, 'nx9')).toHaveLength(1);
    expect(at(l1, 'nc9').map((e) => e.label)).toEqual([WAITS_FOR]);
    expect(at(l1, 'nc1')).toHaveLength(0); expect(at(l1, 'ncdone')).toHaveLength(0);
  });

  it("two projects' labels: null", () => {
    const nodes = [...treeNodes(), label('Q', 'area:p2:1', 0, 900)];
    expect(convertTree(input({ nodes, edges: treeEdges() }))).toBeNull();
    // a list label of another project counts when the caller knows it
    const other = [...treeNodes(), label('Q', 'deck:dq', 0, 900)];
    expect(convertTree(input({ nodes: other, edges: treeEdges() }), (d) => (d === 'dq' ? 'p2' : undefined))).toBeNull();
  });

  it('a board without tree labels, or with frames already: null', () => {
    expect(convertTree(input())).toBeNull();
    expect(convertTree(input(fresh()))).toBeNull();
  });
});

describe('the board document: one undo step', () => {
  it('conversion and projectId are undone together; a write with another origin is not undone', () => {
    const doc = new Y.Doc();
    const maps = boardMaps(doc);
    const um = boardUndo(maps);
    const nodes = treeNodes(), edges = treeEdges();
    writePatch(doc, maps, { ...empty, add: nodes, addEdges: edges }, Symbol('sync'));
    expect(um.canUndo()).toBe(false);
    const snap = () => JSON.stringify([[...maps.nodes.entries()].map(([k, m]) => [k, m.toJSON()]).sort(), [...maps.edges.keys()].sort()]);
    const before = snap();
    const { projectId, ...patch } = convertTree(input({ nodes, edges }))!;
    writePatch(doc, maps, patch, LOCAL, projectId);
    expect(readProjectId(maps.meta)).toBe('p1');
    expect(snap()).not.toBe(before);
    expect(um.undoStack).toHaveLength(1);
    um.undo();
    expect(readProjectId(maps.meta)).toBeNull();
    expect(snap()).toBe(before);
    um.destroy();
  });
});
