/**
 * The work on the shared Home board (tests/web-home-work.test.ts): every project, area, list and (when someone shows
 * them) open quest of Home's model (web/src/homeModel.ts) is a `work` node of the board, so it has one place for
 * everyone and moves on its own; the words, counts, pictures and the lines come from the data.
 *
 * The board is one doc for the whole workspace, and not everyone sees every project. So it holds no id of the work:
 * a work node is keyed by an opaque key (workHash: SHA-256 of the board id and the model id), which each person
 * computes for what they can see and matches against the doc; its value is `{ k: key, p: its project's key }`. What
 * someone can't see is only a key and a place to them, never an id or a name. `p` does tell them how many nodes a
 * project they can't see has (and so that it exists): the price of telling "gone" from "not mine" without an id.
 * Two people adding the same one at once write the same key, so they end up with one node.
 *
 * Upkeep runs in the editors' browsers, as the project boards follow their project (web/src/board/follow.ts): only
 * on a ready, live store, WORK_SYNC_DELAY after the last change, in SYNC transactions that undo never touches:
 * - on first use, every node where today's Web layout puts it; afterwards a new one near its parent, at the offset the
 *   Web layout gives it from that parent; never past MAX_WORK_NODES;
 * - one leaves when it belongs to a project this person sees and its thing is gone from the store (an archived
 *   project, a removed area, a deleted list, a task deleted, archived or done; a "+N more" pill whose list, area or
 *   project is gone), with the lines touching it. Never one another editor added in the last FRESH_MS (their store may
 *   be ahead of ours). Whether something is gone never depends on Home's caps, which differ per person;
 * - one that moved to another project this person sees gets that project's key, in place;
 * - past MAX_WORK_NODES, nodes of this person's projects that their own Home does not draw go first.
 * Nodes of projects this person can't see are left alone: neither drawn nor removed.
 *
 * Drawn per person: a kind shown as cards is a card centred on the node's place, and pills under a card step aside
 * (homeLayout's nudge), on screen only. Work nodes never sit in a frame (`parent` is always null), so moving a frame
 * never has to move work its mover can't see.
 */
import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { digest } from 'lib0/hash/sha256';
import type { BoardNode, Rect } from '../../../shared/board';
import { MAX_NODES, type HomeNode, type HomeState } from '../homeModel';
import { CARD_H, CARD_W, nudge, pillSize, webLayout } from '../homeLayout';
import { store, useStore } from '../store';
import { FOLLOW_DELAY } from './follow';
import { boardMaps, readNode, SYNC, type BoardApi } from './useBoard';

export const WORK_PREFIX = 'w:';
/** Most work nodes one Home board holds: room for two people's Homes at their caps, far below the room's size cap. */
export const MAX_WORK_NODES = 2 * MAX_NODES;
/** A work node another editor added this recently is never removed here: their store may know it before ours. */
export const FRESH_MS = 5000;
/** The upkeep runs this long after the last change: a burst of live events is one pass. */
export const WORK_SYNC_DELAY = FOLLOW_DELAY;

/** Keys computed so far, least recently used first; past HASH_CACHE_MAX the oldest goes. */
export const HASH_CACHE_MAX = 50_000;
const hashes = new Map<string, string>();
const utf8 = new TextEncoder();

/** The opaque key of model id `ref` on board `boardId`: the first 16 bytes of SHA-256(boardId, ref), in hex. */
export function workHash(boardId: string, ref: string): string {
  const input = `${boardId}\u0000${ref}`;
  let h = hashes.get(input);
  if (h !== undefined) {
    hashes.delete(input);
    hashes.set(input, h);
    return h;
  }
  const d = digest(utf8.encode(input));
  h = '';
  for (let i = 0; i < 16; i++) h += d[i].toString(16).padStart(2, '0');
  if (hashes.size >= HASH_CACHE_MAX) hashes.delete(hashes.keys().next().value!);
  hashes.set(input, h);
  return h;
}
/** How many keys are kept (tests). */
export const hashCacheSize = () => hashes.size;
/** The Y key of model id `ref`'s work node. */
export const workKey = (boardId: string, ref: string) => `${WORK_PREFIX}${workHash(boardId, ref)}`;
/** The opaque key a work node stands for, or null for any other node. */
export const workRef = (n: BoardNode): string | null => (n.type === 'work' && typeof n.value.k === 'string' ? n.value.k : null);

interface Point { x: number; y: number }
const centre = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
/** A done quest is not put on the board (it leaves when done); the "+N more" pill of its list still counts it. */
const placeable = (n: HomeNode) => !(n.kind === 'quest' && n.status === 'done');

/** The work node of `n`, its pill's box centred on (x, y). `p`: its project's key (none for "more projects"). */
export function workNode(boardId: string, n: HomeNode, x: number, y: number): BoardNode {
  const [w, h] = pillSize(n);
  const value = n.projectId ? { k: workHash(boardId, n.id), p: workHash(boardId, `p${n.projectId}`) } : { k: workHash(boardId, n.id) };
  return { id: `${WORK_PREFIX}${value.k}`, type: 'work', value, pos: { x: Math.round(x - w / 2), y: Math.round(y - h / 2), w, h, parent: null } };
}

/**
 * The work nodes to add for `nodes` (model order), given the centres of those already on the board (by key). An empty
 * board gets the Web layout as it is; on a board in use each new node keeps the offset the layout gives it from its
 * nearest placed ancestor (no placed ancestor: the offset between the layout and the board of the first placed node).
 * Parents come before their children.
 */
export function placeWork(boardId: string, nodes: HomeNode[], placed: Map<string, Point>): BoardNode[] {
  const key = (n: HomeNode) => workHash(boardId, n.id);
  const missing = nodes.filter((n) => !placed.has(key(n)));
  if (!missing.length) return [];
  const layout = webLayout(nodes, () => false).pos;
  let shift: Point = { x: 0, y: 0 };
  for (const n of nodes) {
    const p = placed.get(key(n)), l = layout.get(n.id);
    if (p && l) { shift = { x: p.x - l.x, y: p.y - l.y }; break; }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const at = new Map<string, Point>();
  for (const n of nodes) { const p = placed.get(key(n)); if (p) at.set(n.id, p); }
  const out: BoardNode[] = [];
  const place = (n: HomeNode, depth = 0): Point => {
    const known = at.get(n.id);
    if (known) return known;
    const l = layout.get(n.id) ?? { x: n.x, y: n.y };
    const parent = n.parent ? byId.get(n.parent) : undefined;
    let off = shift;
    if (parent && depth < 8) {
      const pp = place(parent, depth + 1), pl = layout.get(parent.id) ?? pp;
      off = { x: pp.x - pl.x, y: pp.y - pl.y };
    }
    const c = { x: l.x + off.x, y: l.y + off.y };
    at.set(n.id, c);
    out.push(workNode(boardId, n, c.x, c.y));
    return c;
  };
  for (const n of missing) place(n);
  return out;
}

export interface WorkKnown {
  /** Keys of everything that still exists in the projects this person sees (not archived). */
  alive: Set<string>;
  /** Keys of the projects this person sees, archived ones too. */
  seen: Set<string>;
  /** For a list or quest: the key of the project it is in now. */
  owner: Map<string, string>;
}

/**
 * What this person can tell about the board's work, from the store alone (never from Home's caps, which differ per
 * person): in each project they see that is not archived, the project, every area, list and open task, and every
 * "+N more" pill they could have (of the project, an area, a list).
 */
export function workAlive(boardId: string, s: HomeState): WorkKnown {
  const alive = new Set<string>(), seen = new Set<string>(), owner = new Map<string, string>(), open = new Map<string, string>();
  const add = (ref: string) => { const k = workHash(boardId, ref); alive.add(k); return k; };
  for (const p of s.projects.values()) {
    const pk = workHash(boardId, `p${p.id}`);
    seen.add(pk);
    if (p.isArchived) continue;
    open.set(p.id, pk);
    add(`p${p.id}`);
    add(`mp${p.id}`);
    for (const sp of p.spaces) { add(`a${p.id}:${sp.id}`); add(`ma${p.id}:${sp.id}`); }
  }
  for (const d of s.decks.values()) {
    const pk = open.get(d.projectId);
    if (!pk || d.deckType === 'doc') continue;
    owner.set(add(`l${d.id}`), pk);
    add(`m${d.id}`); // its "+N more" quests pill
  }
  for (const c of s.cards.values()) {
    const d = c.deckId ? s.decks.get(c.deckId) : undefined, pk = d ? open.get(d.projectId) : undefined;
    if (pk && c.visibility === 'default' && !c.isDoc && c.status !== 'done') owner.set(add(`q${c.id}`), pk);
  }
  return { alive, seen, owner };
}

/**
 * The work nodes that are gone: of a project this person sees, and not alive (and not in `fresh`, those another editor
 * added a moment ago). A node of a project they can't see never is.
 */
export function goneWork(onBoard: BoardNode[], known: Pick<WorkKnown, 'alive' | 'seen'>, fresh: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (const n of onBoard) {
    const k = workRef(n), p = n.value.p;
    if (k && typeof p === 'string' && known.seen.has(p) && !known.alive.has(k) && !fresh.has(n.id)) out.push(n.id);
  }
  return out;
}

/** The board's work nodes as they are in the document now. */
export function readWork(doc: Y.Doc): BoardNode[] {
  const out: BoardNode[] = [];
  boardMaps(doc).nodes.forEach((m, id) => {
    if (!id.startsWith(WORK_PREFIX)) return;
    const n = readNode(id, m);
    if (n && workRef(n)) out.push(n);
  });
  return out;
}

/**
 * One SYNC transaction: adds the missing work nodes of `nodes` (this person's model), removes the gone ones and the
 * lines touching them, gives a moved one its new project's key, keeps the board under MAX_WORK_NODES. `fresh`: ids of
 * work nodes another editor just added, never removed. Returns how many nodes changed.
 */
export function syncWork(doc: Y.Doc, boardId: string, nodes: HomeNode[], s: HomeState, fresh: ReadonlySet<string> = new Set()): number {
  const mine = nodes.filter(placeable);
  const onBoard = readWork(doc);
  const known = workAlive(boardId, s);
  const { nodes: map, edges } = boardMaps(doc);
  // A `w:` entry that is not a keyed work node (malformed) goes: it can't be matched to anything.
  const kept = new Set(onBoard.map((n) => n.id));
  const remove = new Set([...goneWork(onBoard, known, fresh), ...[...map.keys()].filter((id) => id.startsWith(WORK_PREFIX) && !kept.has(id))]);
  let count = onBoard.filter((n) => !remove.has(n.id)).length;
  // Past the cap (two people adding at once): first what this person's own Home does not draw, of their projects.
  if (count > MAX_WORK_NODES) {
    const drawn = new Set(mine.map((n) => workHash(boardId, n.id)));
    for (const n of onBoard) {
      if (count <= MAX_WORK_NODES) break;
      const p = n.value.p;
      if (remove.has(n.id) || fresh.has(n.id) || typeof p !== 'string' || !known.seen.has(p) || drawn.has(workRef(n)!)) continue;
      remove.add(n.id);
      count--;
    }
  }
  const placed = new Map<string, Point>();
  for (const n of onBoard) if (!remove.has(n.id)) placed.set(workRef(n)!, centre(n.pos));
  // Never past the cap: what does not fit is not drawn on the board (projects, areas and lists come before quests).
  const quests = new Set(mine.filter((n) => n.kind === 'quest').map((n) => workHash(boardId, n.id)));
  const add = placeWork(boardId, mine, placed)
    .sort((a, b) => Number(quests.has(workRef(a)!)) - Number(quests.has(workRef(b)!)))
    .slice(0, Math.max(0, MAX_WORK_NODES - count));
  const rekey: Array<[string, Record<string, unknown>]> = [];
  for (const n of onBoard) {
    const o = known.owner.get(workRef(n)!);
    if (o && n.value.p !== o && !remove.has(n.id)) rekey.push([n.id, { ...n.value, p: o }]);
  }
  if (!add.length && !remove.size && !rekey.length) return 0;
  doc.transact(() => {
    for (const id of remove) map.delete(id);
    // The lines that touched a removed node go with it.
    if (remove.size) {
      for (const [id, e] of [...edges.entries()]) {
        const v = e instanceof Y.Map ? (e.get('value') as { source?: { nodeId?: string }; target?: { nodeId?: string } } | undefined) : undefined;
        if (remove.has(v?.source?.nodeId ?? '') || remove.has(v?.target?.nodeId ?? '')) edges.delete(id);
      }
    }
    for (const [id, value] of rekey) map.get(id)?.set('value', value);
    for (const n of add) {
      if (map.has(n.id)) continue;
      const y = new Y.Map<unknown>();
      y.set('type', n.type); y.set('value', n.value); y.set('pos', n.pos);
      map.set(n.id, y);
    }
  }, SYNC);
  return add.length + remove.size + rekey.length;
}

/**
 * The work nodes other editors added lately (id → when), from the transactions that reached this doc from the room.
 * Entries older than FRESH_MS are dropped as new ones come, so it stays small.
 */
export function trackFresh(doc: Y.Doc, now: () => number = Date.now): { fresh: () => Set<string>; stop: () => void } {
  const at = new Map<string, number>();
  const { nodes } = boardMaps(doc);
  const onChange = (ev: Y.YMapEvent<Y.Map<unknown>>, tr: Y.Transaction) => {
    if (tr.local) return; // our own writes (LOCAL, SYNC) are not "another editor's"
    const t = now();
    for (const [id, c] of ev.changes.keys) if (c.action === 'add' && id.startsWith(WORK_PREFIX)) at.set(id, t);
    for (const [id, when] of at) if (t - when > FRESH_MS) at.delete(id);
  };
  nodes.observe(onChange);
  return {
    fresh: () => { const t = now(); return new Set([...at].filter(([, when]) => t - when <= FRESH_MS).map(([id]) => id)); },
    stop: () => nodes.unobserve(onChange),
  };
}

/** The Home board asked for, for whom (`who`: the person and their role): asked again when either changes. */
let asked: { who: string; home: Promise<{ id: string; canEdit: boolean }> } | null = null;
export function askHome(who: string, fetch: () => Promise<{ id: string; canEdit: boolean }>): Promise<{ id: string; canEdit: boolean }> {
  if (asked?.who !== who) {
    const home = fetch();
    asked = { who, home };
    home.catch(() => { if (asked?.home === home) asked = null; });
  }
  return asked.home;
}

/**
 * Keeps the board's work in step with the data while this person may edit it: once the board's content is here, only
 * on a ready and live store (a stale one would remove what it does not know yet), WORK_SYNC_DELAY after the last change.
 */
export function useHomeWork(doc: Y.Doc | null, boardId: string, canEdit: boolean, nodes: HomeNode[]): void {
  const current = useStore((x) => x.status === 'ready' && x.live);
  const latest = useRef(nodes);
  latest.current = nodes;
  const tracker = useRef<ReturnType<typeof trackFresh> | null>(null);
  const synced = useRef<Y.Doc | null>(null);
  useEffect(() => {
    if (!doc) return;
    const t = trackFresh(doc);
    tracker.current = t;
    let live = true;
    void doc.whenSynced.then(() => { if (live) synced.current = doc; });
    return () => { live = false; t.stop(); tracker.current = null; synced.current = null; };
  }, [doc]);
  useEffect(() => {
    if (!doc || !canEdit || !boardId || !current) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      timer = null;
      const s = store.get();
      if (synced.current !== doc) { timer = setTimeout(run, WORK_SYNC_DELAY); return; }
      if (s.status !== 'ready' || !s.live) return;
      syncWork(doc, boardId, latest.current, s, tracker.current?.fresh());
    };
    timer = setTimeout(run, WORK_SYNC_DELAY);
    return () => { if (timer) clearTimeout(timer); };
  }, [doc, boardId, canEdit, current, nodes]);
}

/**
 * Where this person draws each work node they see (board units, top-left): pills centred on their place at the size
 * their words need now; cards (`cards`: model ids) at card size, everything nudged so no card covers anything. `view`:
 * the nodes they see, by key; work nodes not in it are not drawn.
 */
export function workRects(onBoard: BoardNode[], view: Map<string, HomeNode>, cards: Set<string>): Map<string, Rect> {
  const items: Array<{ id: string; card: boolean; x: number; y: number; w: number; h: number }> = [];
  for (const n of onBoard) {
    const k = workRef(n), h = k ? view.get(k) : undefined;
    if (!h) continue;
    const c = centre(n.pos), card = cards.has(h.id) && h.kind !== 'more';
    const [w, ht] = card ? [CARD_W, CARD_H] : pillSize(h);
    items.push({ id: n.id, card, x: c.x, y: c.y, w, h: ht });
  }
  const placed = items.some((t) => t.card) ? nudge(items) : new Map(items.map((t) => [t.id, t]));
  const out = new Map<string, Rect>();
  for (const [id, b] of placed) out.set(id, { x: b.x - b.w / 2, y: b.y - b.h / 2, w: b.w, h: b.h });
  return out;
}

/** The drawn node made last time for a stored node, kept while neither changes (so its view does not re-render). */
const drawnOf = new WeakMap<BoardNode, BoardNode>();
const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * The board as this person draws it: work nodes at their drawn rect (`rects`; one not in it, or every one when `rects`
 * is null, is left out), outside any frame; everything else as stored. A move of a drawn work node is written back as
 * the same shift of its stored place, never into a frame, so a card or a nudged pill never writes its on-screen spot or
 * size into the shared board.
 */
export function drawnBoard(api: BoardApi, rects: Map<string, Rect> | null): BoardApi {
  const stored = new Map<string, BoardNode>(), drawn = new Map<string, Rect>();
  const nodes: BoardNode[] = [];
  for (const n of api.nodes) {
    if (n.type !== 'work') { nodes.push(n); continue; }
    const r = rects?.get(n.id);
    if (!r) continue;
    stored.set(n.id, n);
    drawn.set(n.id, r);
    const last = drawnOf.get(n);
    if (last && sameRect(last.pos, r)) { nodes.push(last); continue; }
    const d = { ...n, pos: { ...r, parent: null } };
    drawnOf.set(n, d);
    nodes.push(d);
  }
  if (nodes.length === api.nodes.length && !stored.size) return api;
  return {
    ...api,
    nodes,
    setPos: (changes) => api.setPos(changes.map((c) => {
      const s = stored.get(c.id), d = drawn.get(c.id);
      if (!s || !d) return c;
      return { id: c.id, pos: { ...s.pos, x: Math.round(s.pos.x + c.pos.x - d.x), y: Math.round(s.pos.y + c.pos.y - d.y), parent: null } };
    })),
  };
}
