import { DEFAULT_SIZE, GRID, newId, type BoardEdge, type BoardNode, type EdgeKind, type NodePos, type Point, type Rect, type Side } from '../../../shared/board';
import type { Card, CardDep, Deck, Project, Space } from '../../../shared/types';
import { refOf, SUBTASK, WAITS_FOR } from './projectTree';

// The project board as frames: one frame per area (left to right), one per list (stacked inside its area), each open
// task a mini card inside its list frame. Pure planning only: the caller applies the patch to the board document.

export interface FrameInput {
  project: Project;
  /** The project's areas, in order. */
  spaces: Space[];
  /** The project's lists, in order. */
  decks: Deck[];
  /** Open, non-doc tasks of the project (the caller leaves out done, archived, deleted and lore). */
  cards: Card[];
  /**
   * Task ids the caller knows are done, archived or deleted from this project: only their cards leave the board.
   * Cards of other projects, lore, and tasks not loaded are left alone.
   */
  gone: Set<string>;
  deps: CardDep[];
  /**
   * The list a task is in, for any task the caller knows (done ones included). "Arrange as frames" uses it to tell the
   * old tree's list→task lines from a user's line between a label and a task; without it, only `cards` are known.
   */
  deckOf?: (taskId: string) => string | undefined;
  areaName(spaceId: number): string;
  nodes: BoardNode[];
  edges: BoardEdge[];
}

export interface BoardPatch {
  add: BoardNode[];
  addEdges: BoardEdge[];
  move: Array<{ id: string; pos: NodePos }>;
  remove: string[];
  removeEdges: string[];
  /** New values for existing nodes (renamed frames and header). */
  update: Array<{ id: string; value: Record<string, unknown> }>;
  /** New values for existing lines (an older "waits for" or subtask line gets its `kind`). Absent when there are none. */
  updateEdges?: Array<{ id: string; value: BoardEdge['value'] }>;
}

export const PER_ROW = 6;
const CARD = DEFAULT_SIZE.card;
const PAD = GRID, HEAD = 2 * GRID, LIST_GAP = GRID, AREA_GAP = 2 * GRID;
const STEP_X = CARD.w + GRID, STEP_Y = CARD.h + 2 * GRID;
export const HEADER = { w: 320, h: 40 };
/** An empty list keeps room for two cards (and its name); an empty area for one empty list. */
export const LIST_MIN = { w: 2 * PAD + 2 * STEP_X - GRID, h: HEAD + CARD.h + PAD };
export const AREA_MIN = { w: 2 * PAD + LIST_MIN.w, h: HEAD + LIST_MIN.h + PAD };

export const projectRef = (projectId: string) => `project:${projectId}`;
export const areaRef = (projectId: string, spaceId: number) => `area:${projectId}:${spaceId}`;
export const deckRef = (deckId: string) => `deck:${deckId}`;

const isFrame = (n: BoardNode | undefined, prefix: string) =>
  n?.type === 'container' && typeof n.value.ref === 'string' && n.value.ref.startsWith(prefix);

const bySort = (a: Card, b: Card) => a.sortIndex - b.sortIndex || a.seq - b.seq;

/**
 * A list's tasks in "waits for" order: what a task waits for comes before it (Kahn's order, picking the list's sort
 * order among the ready ones; a cycle is broken by taking the first in sort order). Each task is followed by its
 * subtasks, ordered the same way; a dependency that touches a subtask orders the families it sits in.
 */
export function orderInList(cards: Card[], deps: CardDep[]): Card[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  // A parent counts only when it is in this list and the parent chain has no loop.
  const parentOf = new Map<string, string | null>();
  const up = (id: string) => { const p = byId.get(id)!.parentCardId; return p && byId.has(p) ? p : null; };
  for (const c of cards) {
    let p = up(c.id);
    const seen = new Set([c.id]);
    for (let q = p; q; q = up(q)) {
      if (seen.has(q)) { p = null; break; }
      seen.add(q);
    }
    parentOf.set(c.id, p);
  }
  const chain = (id: string) => { const out: string[] = []; for (let q: string | null = id; q; q = parentOf.get(q)!) out.unshift(q); return out; };
  const groups = new Map<string | null, Card[]>();
  for (const c of cards) { const k = parentOf.get(c.id)!; const g = groups.get(k); if (g) g.push(c); else groups.set(k, [c]); }
  // before.get(x) = the siblings that must come before x
  const before = new Map<string, Set<string>>();
  for (const d of deps) {
    if (!byId.has(d.lockedCardId) || !byId.has(d.lockingCardId)) continue;
    const a = chain(d.lockingCardId), b = chain(d.lockedCardId);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (i >= a.length || i >= b.length) continue; // one is inside the other's family
    const s = before.get(b[i]); if (s) s.add(a[i]); else before.set(b[i], new Set([a[i]]));
  }
  const out: Card[] = [];
  const emit = (parent: string | null) => {
    const left = [...(groups.get(parent) ?? [])].sort(bySort);
    const done = new Set<string>();
    while (left.length) {
      let i = left.findIndex((c) => [...(before.get(c.id) ?? [])].every((x) => done.has(x)));
      if (i < 0) i = 0; // a cycle: the first in sort order goes next
      const [c] = left.splice(i, 1);
      done.add(c.id);
      out.push(c);
      emit(c.id);
    }
  };
  emit(null);
  return out;
}

/** "N tasks left" per list frame and the cross-list "waits for" counts, for the zoomed-out view. */
export function macroSummary(nodes: BoardNode[], edges: BoardEdge[]): { counts: Map<string, number>; links: Array<{ from: string; to: string; count: number }> } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const counts = new Map<string, number>();
  for (const n of nodes) if (isFrame(n, 'deck:')) counts.set(n.id, 0);
  const listOf = (n: BoardNode | undefined) => (n?.type === 'card' && n.pos.parent && counts.has(n.pos.parent) ? n.pos.parent : null);
  for (const n of nodes) { const l = listOf(n); if (l) counts.set(l, counts.get(l)! + 1); }
  const links = new Map<string, { from: string; to: string; count: number }>();
  for (const e of edges) {
    if (e.label !== WAITS_FOR) continue;
    const from = listOf(byId.get(e.value.source.nodeId)), to = listOf(byId.get(e.value.target.nodeId));
    if (!from || !to || from === to) continue;
    const k = `${from}>${to}`;
    const l = links.get(k); if (l) l.count += 1; else links.set(k, { from, to, count: 1 });
  }
  return { counts, links: [...links.values()] };
}

const listSize = (n: number) => {
  const cols = Math.max(2, Math.min(n, PER_ROW)), rows = Math.max(1, Math.ceil(n / PER_ROW));
  return { w: 2 * PAD + cols * STEP_X - GRID, h: HEAD + (rows - 1) * STEP_Y + CARD.h + PAD };
};
const slotAt = (frame: Point, i: number): Point =>
  ({ x: frame.x + PAD + (i % PER_ROW) * STEP_X, y: frame.y + HEAD + Math.floor(i / PER_ROW) * STEP_Y });
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const encloses = (o: Rect, i: Rect) => i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
const samePos = (a: NodePos, b: NodePos) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.parent === b.parent;
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const touches = (e: BoardEdge, id: string) => e.value.source.nodeId === id || e.value.target.nodeId === id;

/** The board being planned: original nodes and edges with working state, plus what is added, removed and relabelled. */
class Work {
  readonly orig = new Map<string, BoardNode>();
  readonly pos = new Map<string, NodePos>();
  readonly added: BoardNode[] = [];
  readonly removed = new Set<string>();
  readonly removedEdges = new Set<string>();
  addedEdges: BoardEdge[] = [];
  readonly nodes = new Map<string, BoardNode>();
  readonly values = new Map<string, Record<string, unknown>>();

  readonly edges: BoardEdge[];
  /** Existing lines that get a new value (see syncEdges). */
  readonly edgeValues = new Map<string, BoardEdge['value']>();

  /**
   * Nodes and edges are taken in id order, never in the order the document lists them (which differs between clients):
   * every choice of a winner (which copy stays, which line is kept) is then the same on every client.
   */
  constructor(nodes: BoardNode[], edges: BoardEdge[]) {
    for (const n of [...nodes].sort(byId)) { this.orig.set(n.id, n); this.pos.set(n.id, { ...n.pos }); this.nodes.set(n.id, n); }
    this.edges = [...edges].sort(byId);
  }
  node(id: string) { return this.removed.has(id) ? undefined : this.nodes.get(id); }
  live(): BoardNode[] { return [...this.nodes.values()].filter((n) => !this.removed.has(n.id)); }
  liveEdges(): BoardEdge[] { return [...this.edges.filter((e) => !this.removedEdges.has(e.id)), ...this.addedEdges]; }
  children(id: string): string[] { return this.live().filter((n) => this.pos.get(n.id)!.parent === id).map((n) => n.id); }
  value(id: string): Record<string, unknown> { return this.values.get(id) ?? this.nodes.get(id)!.value; }
  setValue(id: string, v: Record<string, unknown>) { this.values.set(id, v); }
  add(n: BoardNode) { this.added.push(n); this.nodes.set(n.id, n); this.pos.set(n.id, { ...n.pos }); }
  remove(id: string) {
    this.removed.add(id);
    for (const e of this.edges) if (touches(e, id)) this.removedEdges.add(e.id);
    this.addedEdges = this.addedEdges.filter((e) => !touches(e, id));
  }
  dropEdge(e: BoardEdge) {
    if (this.addedEdges.includes(e)) this.addedEdges = this.addedEdges.filter((x) => x !== e); else this.removedEdges.add(e.id);
  }
  /** Redraws `from`'s lines on `to` (before `from` is removed), leaving out loops and lines `to` already has. */
  reattach(from: string, to: string) {
    for (const e of this.liveEdges()) {
      if (!touches(e, from)) continue;
      const s = e.value.source.nodeId === from ? to : e.value.source.nodeId, t = e.value.target.nodeId === from ? to : e.value.target.nodeId;
      if (s === t || this.liveEdges().some((x) => x.value.source.nodeId === s && x.value.target.nodeId === t && x.label === e.label && (!!e.label || x.color === e.color))) continue;
      this.addedEdges.push({ ...e, id: newId(), value: { ...e.value, source: { ...e.value.source, nodeId: s }, target: { ...e.value.target, nodeId: t } } });
    }
  }
  set(id: string, p: Partial<NodePos>) { this.pos.set(id, { ...this.pos.get(id)!, ...p }); }
  /** Moves a node and everything inside it. */
  shift(id: string, dx: number, dy: number, seen = new Set<string>()) {
    if (seen.has(id) || (!dx && !dy)) return;
    seen.add(id);
    const p = this.pos.get(id)!;
    this.set(id, { x: p.x + dx, y: p.y + dy });
    for (const c of this.children(id)) this.shift(c, dx, dy, seen);
  }
  patch(addEdges: BoardEdge[]): BoardPatch {
    const move: BoardPatch['move'] = [], update: BoardPatch['update'] = [];
    for (const [id, n] of this.orig) {
      if (this.removed.has(id)) continue;
      if (!samePos(n.pos, this.pos.get(id)!)) move.push({ id, pos: this.pos.get(id)! });
      if (this.values.has(id)) update.push({ id, value: this.values.get(id)! });
    }
    const updateEdges = [...this.edgeValues].filter(([id]) => !this.removedEdges.has(id)).map(([id, value]) => ({ id, value }));
    return {
      add: this.added.filter((n) => !this.removed.has(n.id)).map((n) => ({ ...n, value: this.value(n.id), pos: this.pos.get(n.id)! })),
      addEdges: [...this.addedEdges, ...addEdges],
      move,
      remove: [...this.removed].filter((id) => this.orig.has(id)),
      removeEdges: this.edges.filter((e) => this.removedEdges.has(e.id)).map((e) => e.id),
      update,
      ...(updateEdges.length ? { updateEdges } : {}),
    };
  }
}

/** Frame geometry over a Work: growing, pushing siblings, and where the next card or list goes. */
function geometry(w: Work, pid: string) {
  const rect = (id: string) => w.pos.get(id)!;
  const isArea = (id: string | null) => !!id && isFrame(w.node(id), `area:${pid}:`);
  const isList = (id: string | null) => !!id && isFrame(w.node(id), 'deck:');
  /** Pushes the siblings that come after `id` (in y for lists, x for areas) until none overlaps. */
  const push = (id: string, siblings: string[], axis: 'x' | 'y', start: number) => {
    const gap = axis === 'y' ? LIST_GAP : AREA_GAP, other = axis === 'y' ? 'x' : 'y';
    const later = siblings.filter((s) => s !== id && rect(s)[axis] >= start).sort((a, b) => rect(a)[axis] - rect(b)[axis] || rect(a)[other] - rect(b)[other] || (a < b ? -1 : a > b ? 1 : 0));
    const done = [id];
    for (const s of later) {
      let d = 0;
      for (const m of done) if (overlaps(rect(m), rect(s))) d = Math.max(d, (axis === 'y' ? rect(m).y + rect(m).h : rect(m).x + rect(m).w) + gap - rect(s)[axis]);
      if (d > 0) w.shift(s, axis === 'x' ? d : 0, axis === 'y' ? d : 0);
      done.push(s);
    }
  };
  /** A frame grows to hold its contents, then its parent frame does the same. */
  const grow = (id: string) => {
    const f = rect(id);
    let rx = f.x + f.w, by = f.y + f.h;
    for (const c of w.children(id)) { const p = rect(c); rx = Math.max(rx, p.x + p.w + PAD); by = Math.max(by, p.y + p.h + PAD); }
    if (rx > f.x + f.w || by > f.y + f.h) {
      w.set(id, { w: rx - f.x, h: by - f.y });
      if (isList(id)) push(id, w.children(f.parent ?? '').filter(isList), 'y', f.y);
      else if (isArea(id)) push(id, w.live().map((n) => n.id).filter(isArea), 'x', f.x);
    }
    if (isArea(f.parent) || isList(f.parent)) grow(f.parent!);
  };
  const bottomOfLists = (areaId: string) => {
    const ls = w.children(areaId).filter(isList);
    return ls.length ? Math.max(...ls.map((l) => rect(l).y + rect(l).h)) + LIST_GAP : rect(areaId).y + HEAD;
  };
  /** The slot after the list's last card. */
  const endOfRow = (listId: string): Point => {
    const f = rect(listId);
    let last = -1;
    for (const c of w.children(listId)) {
      if (w.node(c)?.type !== 'card') continue;
      const p = rect(c);
      const row = Math.max(0, Math.round((p.y - f.y - HEAD) / STEP_Y)), col = Math.min(PER_ROW - 1, Math.max(0, Math.round((p.x - f.x - PAD) / STEP_X)));
      last = Math.max(last, row * PER_ROW + col);
    }
    return slotAt(f, last + 1);
  };
  /** Where a child that does not fit at its old spot goes in `frameId`: end of row, bottom of the lists, or below the rest. */
  const nextSpot = (frameId: string, childId: string): Point => {
    if (isList(frameId) && w.node(childId)?.type === 'card') return endOfRow(frameId);
    if (isArea(frameId) && isList(childId)) return { x: rect(frameId).x + PAD, y: bottomOfLists(frameId) };
    const kids = w.children(frameId);
    return { x: rect(frameId).x + PAD, y: kids.length ? Math.max(...kids.map((k) => rect(k).y + rect(k).h)) + GRID : rect(frameId).y + HEAD };
  };
  /** Folds `extra` into `keep` (same ref): its contents move over at the same spot when free, else to the next spot. */
  const merge = (extra: string, keep: string) => {
    const kids = w.children(extra).sort((a, b) => rect(a).y - rect(b).y || rect(a).x - rect(b).x || (a < b ? -1 : a > b ? 1 : 0));
    for (const c of kids) {
      const p = rect(c), er = rect(extra), kr = rect(keep);
      let at: Point = { x: kr.x + p.x - er.x, y: kr.y + p.y - er.y };
      const r = { ...at, w: p.w, h: p.h };
      if (!encloses(kr, r) || w.children(keep).some((o) => overlaps(rect(o), r))) at = nextSpot(keep, c);
      w.shift(c, at.x - p.x, at.y - p.y);
      w.set(c, { parent: keep });
      grow(keep);
    }
    w.reattach(extra, keep);
    w.remove(extra);
  };
  return { rect, isArea, isList, grow, bottomOfLists, endOfRow, merge };
}

/**
 * One node per task, frame and header: for each `card:` ref, and each project `area:` / `deck:` frame or `project:`
 * header, the node with the smallest id stays. A dropped copy's lines are redrawn on the kept one; a dropped frame's
 * contents move into the kept frame. Areas go before lists, so lists of two merged areas meet before they merge.
 * Returns task id → card node id.
 */
function dedupe(w: Work, g: ReturnType<typeof geometry>, pid: string): Map<string, string> {
  const keep = new Map<string, string>();
  for (const n of w.live().filter((x) => x.type === 'card').sort(byId)) {
    const t = String(n.value.id), k = keep.get(t);
    if (k) { w.reattach(n.id, k); w.remove(n.id); } else keep.set(t, n.id);
  }
  for (const [type, prefix] of [['container', `area:${pid}:`], ['container', 'deck:'], ['text', projectRef(pid)]] as const) {
    const first = new Map<string, string>();
    for (const n of w.live().filter((x) => x.type === type).sort(byId)) {
      const r = refOf(n);
      if (!r || !(type === 'text' ? r === prefix : r.startsWith(prefix))) continue;
      const k = first.get(r);
      if (k) g.merge(n.id, k); else first.set(r, n.id);
    }
  }
  return keep;
}

/**
 * Removes this project's frames that are no longer in it, once empty: a list frame only when it sits (at any depth)
 * inside one of this project's area frames and its list is not one of the project's; an area frame only for an area
 * the project no longer has. Frames of other projects are never touched. Lists first, so an area can empty out.
 */
function dropStaleFrames(w: Work, inp: FrameInput, lists: Map<string, string>, areas: Map<string, string>) {
  const pid = inp.project.id, prefix = `area:${pid}:`;
  const spaceIds = new Set(inp.spaces.map((s) => s.id));
  const deckIds = new Set(inp.decks.filter((d) => spaceIds.has(d.spaceId)).map((d) => d.id));
  const inProject = (id: string) => {
    const seen = new Set<string>();
    for (let p = w.pos.get(id)!.parent; p && !seen.has(p); p = w.pos.get(p)?.parent ?? null) {
      seen.add(p);
      if (isFrame(w.node(p), prefix)) return true;
    }
    return false;
  };
  for (const [ref, id] of lists) if (!w.removed.has(id) && !deckIds.has(ref.slice(5)) && inProject(id) && !w.children(id).length) w.remove(id);
  for (const [ref, id] of areas) if (!w.removed.has(id) && ref.startsWith(prefix) && !spaceIds.has(Number(ref.slice(prefix.length))) && !w.children(id).length) w.remove(id);
}

/** The node with each ref, among nodes of the given type (one each after dedupe). */
function framesByRef(w: Work, type: 'container' | 'text', prefix: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of w.live().sort(byId)) {
    const r = n.type === type ? refOf(n) : null;
    if (r && r.startsWith(prefix) && !out.has(r)) out.set(r, n.id);
  }
  return out;
}

/** Card nodes of tasks the caller knows are done, archived or deleted leave the board, with every line touching them. */
function dropGone(w: Work, inp: FrameInput, cardNode: Map<string, string>) {
  for (const [task, id] of cardNode) if (inp.gone.has(task)) { w.remove(id); cardNode.delete(task); }
}

/** Frame labels and the header follow renames of areas, lists and the project. */
function relabel(w: Work, inp: FrameInput, areas: Map<string, string>, lists: Map<string, string>, headers: Map<string, string>) {
  const want = (id: string | undefined, key: string, text: string) => {
    if (!id) return;
    const v = w.value(id);
    if (v[key] !== text) w.setValue(id, { ...v, [key]: text });
  };
  for (const s of inp.spaces) want(areas.get(areaRef(inp.project.id, s.id)), 'label', inp.areaName(s.id));
  for (const d of inp.decks) want(lists.get(deckRef(d.id)), 'label', d.title);
  want(headers.get(projectRef(inp.project.id)), 'content', inp.project.name);
}

const SIDES: Record<string, [Side, Side]> = { [WAITS_FOR]: ['top', 'top'], [SUBTASK]: ['bottom', 'bottom'] };
const KIND: Record<string, EdgeKind> = { [WAITS_FOR]: 'dep', [SUBTASK]: 'sub' };

/**
 * Whether a line stands for a "waits for" or subtask of the project (the board keeps those as the project says):
 * - its `kind` matches its label ('dep' with "waits for", 'sub' with "subtask"): reconcile drew it, or the user chose
 *   "It waits for it" / "It is its subtask";
 * - an older line without `kind` (from before kinds): its label is "waits for" or "subtask", its two ends are task cards,
 *   and the project has that very dependency (or parent) now.
 * Anything else, a line the user merely labelled "waits for" included, is the user's own line and is left alone.
 * `taskOf` gives the task of a card node; `hasDep(locked, locking)` and `parentOf(task)` read the project.
 */
export function standsFor(e: BoardEdge, taskOf: (nodeId: string) => string | undefined,
  hasDep: (locked: string, locking: string) => boolean, parentOf: (task: string) => string | null | undefined): EdgeKind | null {
  const want = e.label ? KIND[e.label] : undefined;
  if (!want) return null;
  if (e.value.kind) return e.value.kind === want ? want : null;
  const a = taskOf(e.value.source.nodeId), b = taskOf(e.value.target.nodeId);
  if (!a || !b) return null;
  return (want === 'dep' ? hasDep(a, b) : parentOf(b) === a) ? want : null;
}

/**
 * "waits for" (waiting task → what it waits for) and "subtask" (parent → child) lines between task cards, as the
 * project says. Only lines that stand for something (standsFor) between two cards of this project's open tasks are
 * judged; anything else is left alone. Of two lines for the same thing the one with the smallest id stays, so clients
 * that each drew one agree on which goes. An older line that is kept gets its `kind`.
 */
function syncEdges(w: Work, inp: FrameInput, cardNode: Map<string, string>): BoardEdge[] {
  const known = new Set<string>();
  const taskOfNode = new Map<string, string>();
  for (const c of inp.cards) { const id = cardNode.get(c.id); if (id) { known.add(id); taskOfNode.set(id, c.id); } }
  const deps = new Set(inp.deps.map((d) => `${d.lockedCardId}>${d.lockingCardId}`));
  const parents = new Map(inp.cards.map((c) => [c.id, c.parentCardId]));
  const want = new Map<string, [string, string, string]>();
  const put = (label: string, a: string | undefined, b: string | undefined) => { if (a && b && a !== b) want.set(`${label}|${a}>${b}`, [label, a, b]); };
  for (const d of inp.deps) put(WAITS_FOR, cardNode.get(d.lockedCardId), cardNode.get(d.lockingCardId));
  for (const c of inp.cards) if (c.parentCardId) put(SUBTASK, cardNode.get(c.parentCardId), cardNode.get(c.id));
  for (const e of [...w.liveEdges()].sort(byId)) {
    const s = e.value.source.nodeId, t = e.value.target.nodeId;
    if (!known.has(s) || !known.has(t)) continue;
    const kind = standsFor(e, (id) => taskOfNode.get(id), (a, b) => deps.has(`${a}>${b}`), (id) => parents.get(id));
    if (!kind) continue;
    const k = `${e.label}|${s}>${t}`;
    if (!want.has(k)) { w.dropEdge(e); continue; }
    want.delete(k);
    if (e.value.kind) continue;
    const value = { ...e.value, kind };
    const i = w.addedEdges.indexOf(e);
    if (i >= 0) w.addedEdges[i] = { ...e, value }; else w.edgeValues.set(e.id, value);
  }
  return [...want.entries()].filter(([, [, a, b]]) => known.has(a) && known.has(b)).map(([, [label, a, b]]) => ({
    id: newId(), label, value: { source: { nodeId: a, side: SIDES[label][0] }, target: { nodeId: b, side: SIDES[label][1] }, kind: KIND[label] },
  }));
}

/** Where a fresh layout goes when the caller has no better place: below everything on the board. */
export function originBelow(nodes: BoardNode[]): Point {
  return { x: 0, y: nodes.length ? Math.max(...nodes.map((n) => n.pos.y + n.pos.h)) + 4 * GRID : 0 };
}

/**
 * The whole project laid out fresh at `origin`: header, area frames left to right, list frames stacked in their area,
 * open tasks in rows of 6 in "waits for" order. Nodes already on the board with the same ref (task cards, frames,
 * header) are reused and moved into place; card nodes of gone tasks leave; project frames that are no longer in the
 * project go once empty. Lines: see syncEdges.
 */
export function layoutFrames(inp: FrameInput, origin: Point): BoardPatch {
  const w = new Work(inp.nodes, inp.edges);
  const pid = inp.project.id;
  const cardNode = dedupe(w, geometry(w, pid), pid);
  dropGone(w, inp, cardNode);
  const headers = framesByRef(w, 'text', projectRef(pid));
  const areas = framesByRef(w, 'container', `area:${pid}:`);
  const lists = framesByRef(w, 'container', 'deck:');
  relabel(w, inp, areas, lists, headers);
  const place = (have: string | undefined, make: () => BoardNode, pos: NodePos): string => {
    if (have) { const p = w.pos.get(have)!; w.shift(have, pos.x - p.x, pos.y - p.y); w.set(have, pos); return have; }
    const n = make(); n.pos = pos; w.add(n); return n.id;
  };
  const frame = (ref: string, label: string) => (): BoardNode => ({ id: newId(), type: 'container', value: { label, ref }, pos: { x: 0, y: 0, w: 0, h: 0, parent: null } });

  place(headers.get(projectRef(pid)), () => ({ id: newId(), type: 'text', value: { content: inp.project.name, ref: projectRef(pid) }, pos: { x: 0, y: 0, ...HEADER, parent: null } }),
    { x: origin.x, y: origin.y, ...HEADER, parent: null });
  const byDeck = new Map<string, Card[]>();
  for (const c of inp.cards) if (c.deckId) { const l = byDeck.get(c.deckId); if (l) l.push(c); else byDeck.set(c.deckId, [c]); }
  let x = origin.x;
  const top = origin.y + HEADER.h + GRID;
  for (const space of inp.spaces) {
    // Children first, then the frame around them: positions are absolute, so the frame's size comes from its lists.
    const ref = areaRef(pid, space.id);
    const areaId = place(areas.get(ref), frame(ref, inp.areaName(space.id)), { x, y: top, w: AREA_MIN.w, h: AREA_MIN.h, parent: null });
    let y = top + HEAD, wide = LIST_MIN.w;
    for (const d of inp.decks.filter((dk) => dk.spaceId === space.id)) {
      const tasks = orderInList(byDeck.get(d.id) ?? [], inp.deps);
      const size = listSize(tasks.length);
      const at = { x: x + PAD, y };
      const listId = place(lists.get(deckRef(d.id)), frame(deckRef(d.id), d.title), { ...at, ...size, parent: areaId });
      tasks.forEach((c, i) => {
        place(cardNode.get(c.id), () => {
          const n: BoardNode = { id: newId(), type: 'card', value: { id: c.id, mode: 'mini' }, pos: { x: 0, y: 0, ...CARD, parent: null } };
          cardNode.set(c.id, n.id);
          return n;
        }, { ...slotAt(at, i), ...CARD, parent: listId });
      });
      y += size.h + LIST_GAP;
      wide = Math.max(wide, size.w);
    }
    const h = y === top + HEAD ? AREA_MIN.h : y - LIST_GAP + PAD - top;
    w.set(areaId, { w: wide + 2 * PAD, h });
    x += wide + 2 * PAD + AREA_GAP;
  }
  // Project frames that are no longer in the project: gone once nothing is left in them (never on an empty input).
  if (inp.spaces.length) dropStaleFrames(w, inp, lists, areas);
  return w.patch(syncEdges(w, inp, cardNode));
}

/**
 * Only what changed in the project since the board was laid out: see the design's "reconcile". Never moves a card that
 * sits in its own list's frame or outside every list frame, nor a card whose task is not one of this project's open
 * tasks; removes only cards of `gone` tasks; frames only grow, and a grown frame pushes its later siblings (lists below,
 * areas to the right) along, contents included, when they would overlap.
 */
export function reconcile(inp: FrameInput): BoardPatch {
  const w = new Work(inp.nodes, inp.edges);
  const pid = inp.project.id;
  const g = geometry(w, pid);
  const { rect, isArea, isList, grow, bottomOfLists, endOfRow } = g;
  const cardNode = dedupe(w, g, pid);
  dropGone(w, inp, cardNode);
  const areas = framesByRef(w, 'container', `area:${pid}:`);
  const lists = framesByRef(w, 'container', 'deck:');
  const headers = framesByRef(w, 'text', projectRef(pid));
  relabel(w, inp, areas, lists, headers);
  const newFrame = (ref: string, label: string, pos: NodePos): string => {
    const n: BoardNode = { id: newId(), type: 'container', value: { label, ref }, pos };
    w.add(n);
    (ref.startsWith('deck:') ? lists : areas).set(ref, n.id);
    return n.id;
  };

  // Header and areas: a missing area goes to the right of the others.
  const anyArea = () => [...areas.values()].filter((a) => !w.removed.has(a));
  let headerId = headers.get(projectRef(pid));
  if (!headerId) {
    const as = anyArea();
    const at = as.length ? { x: Math.min(...as.map((a) => rect(a).x)), y: Math.min(...as.map((a) => rect(a).y)) - HEADER.h - GRID } : originBelow(w.live());
    headerId = newId();
    w.add({ id: headerId, type: 'text', value: { content: inp.project.name, ref: projectRef(pid) }, pos: { ...at, ...HEADER, parent: null } });
  }
  const header = rect(headerId);
  for (const space of inp.spaces) {
    const ref = areaRef(pid, space.id);
    if (areas.has(ref)) continue;
    const as = anyArea();
    const x = as.length ? Math.max(...as.map((a) => rect(a).x + rect(a).w)) + AREA_GAP : header.x;
    const y = as.length ? Math.min(...as.map((a) => rect(a).y)) : header.y + header.h + GRID;
    newFrame(ref, inp.areaName(space.id), { x, y, ...AREA_MIN, parent: null });
  }

  // Lists: missing ones at the bottom of their area; a list frame sitting in another area's frame moves to its own.
  const spaceIds = new Set(inp.spaces.map((s) => s.id));
  const decks = inp.decks.filter((d) => spaceIds.has(d.spaceId));
  for (const d of decks) {
    const areaId = areas.get(areaRef(pid, d.spaceId))!;
    const have = lists.get(deckRef(d.id));
    const at = { x: rect(areaId).x + PAD, y: bottomOfLists(areaId) };
    if (!have) newFrame(deckRef(d.id), d.title, { ...at, ...LIST_MIN, parent: areaId });
    else {
      const parent = rect(have).parent;
      if (parent === areaId || !isArea(parent)) continue;
      w.shift(have, at.x - rect(have).x, at.y - rect(have).y);
      w.set(have, { parent: areaId });
    }
    grow(areaId);
  }

  // Tasks of this project only: a missing one, or one sitting in another list's frame, goes to the end of its list's row.
  const deckIds = new Set(decks.map((d) => d.id));
  const byDeck = new Map<string, Card[]>();
  for (const c of inp.cards) if (c.deckId && deckIds.has(c.deckId)) { const l = byDeck.get(c.deckId); if (l) l.push(c); else byDeck.set(c.deckId, [c]); }
  for (const d of decks) {
    const listId = lists.get(deckRef(d.id))!;
    for (const c of orderInList(byDeck.get(d.id) ?? [], inp.deps)) {
      let id = cardNode.get(c.id);
      if (id) {
        const parent = rect(id).parent;
        if (parent === listId || !isList(parent)) continue;
        w.set(id, { ...endOfRow(listId), parent: listId });
      } else {
        id = newId();
        w.add({ id, type: 'card', value: { id: c.id, mode: 'mini' }, pos: { ...endOfRow(listId), ...CARD, parent: listId } });
        cardNode.set(c.id, id);
      }
      grow(listId);
    }
  }

  // Frames of lists and areas no longer in the project: gone once empty (lists first, so an area can empty out). An
  // empty input (project not loaded) removes nothing.
  if (inp.spaces.length) dropStaleFrames(w, inp, lists, areas);
  return w.patch(syncEdges(w, inp, cardNode));
}

/** A label of the old tree layout: a text node naming an area or a list (frames are containers, so never these). */
const isTreeLabel = (n: BoardNode) => n.type === 'text' && /^(area|deck):/.test(refOf(n) ?? '');

/**
 * The projects an old tree on the board names, through its area and list labels and its project label. Empty when the
 * board has no tree labels. `deckProject` says which project a list belongs to (undefined when unknown).
 */
export function treeProjects(nodes: BoardNode[], deckProject: (deckId: string) => string | undefined): Set<string> {
  const out = new Set<string>();
  if (!nodes.some(isTreeLabel)) return out;
  for (const n of nodes) {
    if (n.type !== 'text') continue;
    const r = refOf(n) ?? '';
    if (r.startsWith('project:')) out.add(r.slice(8));
    else if (r.startsWith('area:')) out.add(r.split(':')[1]);
    else if (r.startsWith('deck:')) { const p = deckProject(r.slice(5)); if (p) out.add(p); }
  }
  return out;
}

/**
 * "Arrange as frames" for a board made with the old tree layout: the project laid out as frames where the tree started.
 * The tree's area and list labels go, with the lines between labels and from labels to tasks; a line from a note (or
 * anything else that is not a task or a label) to a label is redrawn on the matching frame (on the header when the
 * frame is gone). The project label becomes the header. Cards keep their "waits for", "subtask" and plain lines. Free
 * nodes that would overlap the new frames move straight down below them, together. Null when the board's labels do
 * not name exactly this project (`deckProject`, when given, says which project another list label belongs to).
 */
export function convertTree(inp: FrameInput, deckProject?: (deckId: string) => string | undefined): (BoardPatch & { projectId: string }) | null {
  const pid = inp.project.id;
  const ours = new Set(inp.decks.map((d) => d.id));
  const named = treeProjects(inp.nodes, (d) => (ours.has(d) ? pid : deckProject?.(d)));
  if (named.size !== 1 || !named.has(pid)) return null;

  const labels = new Map(inp.nodes.filter(isTreeLabel).map((n) => [n.id, n]));
  const isHeader = (n: BoardNode | undefined) => n?.type === 'text' && refOf(n) === projectRef(pid);
  const tree = inp.nodes.filter((n) => labels.has(n.id) || isHeader(n));
  const origin = { x: Math.min(...tree.map((n) => n.pos.x)), y: Math.min(...tree.map((n) => n.pos.y)) };
  const onLabel = (e: BoardEdge) => labels.has(e.value.source.nodeId) || labels.has(e.value.target.nodeId);
  const rest = inp.nodes.filter((n) => !labels.has(n.id));
  const patch = layoutFrames({ ...inp, nodes: rest, edges: inp.edges.filter((e) => !onLabel(e)) }, origin);

  // The board after the layout.
  const removed = new Set(patch.remove), moved = new Map(patch.move.map((m) => [m.id, m.pos]));
  const after = [...rest.filter((n) => !removed.has(n.id)).map((n) => ({ ...n, pos: moved.get(n.id) ?? n.pos })), ...patch.add];
  const byRef = new Map<string, string>();
  for (const n of [...after].sort(byId)) {
    const r = refOf(n);
    if (r && (n.type === 'container' || isHeader(n)) && !byRef.has(r)) byRef.set(r, n.id);
  }
  const header = byRef.get(projectRef(pid))!;
  const alive = new Map(after.map((n) => [n.id, n]));

  // Lines on labels: the tree's own lines (label to label, a list label to a task of that list) go; any other line on a
  // label is redrawn on the matching frame. A line on a dropped duplicate card goes to the card that was kept.
  const dropped = inp.edges.filter(onLabel);
  const deckOf = inp.deckOf ?? ((id: string) => inp.cards.find((c) => c.id === id)?.deckId ?? undefined);
  const keptCard = new Map<string, string>();
  for (const n of [...after].sort(byId)) if (n.type === 'card' && !keptCard.has(String(n.value.id))) keptCard.set(String(n.value.id), n.id);
  const lines = [...inp.edges.filter((e) => !onLabel(e) && !patch.removeEdges.includes(e.id)), ...patch.addEdges];
  const reattached: BoardEdge[] = [];
  for (const e of dropped) {
    const ends = [e.value.source.nodeId, e.value.target.nodeId].map((id) => {
      const l = labels.get(id);
      return l ? { label: true, id: byRef.get(refOf(l)!) ?? header } : { label: false, id };
    });
    const free = ends.filter((x) => !x.label);
    if (free.length !== 1) continue; // label to label
    let other = alive.get(free[0].id) ?? inp.nodes.find((n) => n.id === free[0].id);
    if (other?.type === 'card') {
      const label = labels.get(e.value.source.nodeId) ?? labels.get(e.value.target.nodeId)!;
      const r = refOf(label)!;
      if (r.startsWith('deck:') && deckOf(String(other.value.id)) === r.slice(5)) continue; // the tree's list→task line
      const kept = keptCard.get(String(other.value.id));
      other = kept ? alive.get(kept) : undefined;
      if (other) free[0].id = other.id;
    }
    if (!other || removed.has(other.id) || isHeader(other)) continue;
    const [s, t] = ends.map((x) => x.id);
    if (s === t || [...lines, ...reattached].some((x) => x.value.source.nodeId === s && x.value.target.nodeId === t && x.label === e.label && x.color === e.color)) continue;
    reattached.push({ ...e, id: newId(), value: { source: { ...e.value.source, nodeId: s }, target: { ...e.value.target, nodeId: t } } });
  }

  // Free nodes (top level, not placed by the layout) that overlap the new frames move down below them, as a group.
  const placed = new Set<string>([header]);
  for (const n of after) {
    const r = refOf(n);
    if (n.type === 'container' && r && (r.startsWith(`area:${pid}:`) || (r.startsWith('deck:') && ours.has(r.slice(5))))) placed.add(n.id);
  }
  const cardIds = new Set(inp.cards.map((c) => c.id));
  for (const n of after) if (n.type === 'card' && cardIds.has(String(n.value.id))) placed.add(n.id);
  const blocks = after.filter((n) => placed.has(n.id) && n.pos.parent === null).map((n) => n.pos);
  const hit = after.filter((n) => !placed.has(n.id) && n.pos.parent === null && blocks.some((b) => overlaps(b, n.pos)));
  const move = new Map(patch.move.map((m) => [m.id, m.pos]));
  if (hit.length) {
    const dy = Math.max(...blocks.map((b) => b.y + b.h)) + 2 * GRID - Math.min(...hit.map((n) => n.pos.y));
    const shift = (n: BoardNode, seen: Set<string>) => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      move.set(n.id, { ...n.pos, y: n.pos.y + dy });
      for (const c of after) if (c.pos.parent === n.id) shift(c, seen);
    };
    const seen = new Set<string>();
    for (const n of hit) shift(n, seen);
  }
  const added = new Set(patch.add.map((n) => n.id));
  return {
    add: patch.add.map((n) => (move.has(n.id) ? { ...n, pos: move.get(n.id)! } : n)),
    addEdges: [...patch.addEdges, ...reattached],
    move: [...move].filter(([id]) => !added.has(id)).map(([id, pos]) => ({ id, pos })),
    remove: [...patch.remove, ...labels.keys()],
    removeEdges: [...patch.removeEdges, ...dropped.map((e) => e.id)],
    update: patch.update,
    ...(patch.updateEdges ? { updateEdges: patch.updateEdges } : {}),
    projectId: pid,
  };
}
