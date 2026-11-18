import type * as Y from 'yjs';
import { containerAt, newId, snap, type BoardNode, type NodePos, type Point, type Rect } from '../../../shared/board';
import type { State } from '../store';
import { hostProject } from './boards';
import type { Holds } from './follow';
import { refOf } from './projectTree';
import { boardMaps, LOCAL, readBoard, SYNC } from './useBoard';

/** How long a node another client just dropped into a frame is left where it was dropped, at most (see Holds). */
export const HOLD_MS = 5000;

/** What a drop on a project board asks of the project. */
export type DropIntent =
  | { kind: 'move-task'; cardId: string; deckId: string }
  | { kind: 'move-list'; deckId: string; spaceId: number }
  | null;

/** Where a node now sits by its refs alone: a card in a list frame, or a list frame in an area frame. */
export type DropTarget = { kind: 'task'; cardId: string; deckId: string } | { kind: 'list'; deckId: string; projectId: string; spaceId: number };

/** A board that shows its host task's project, with a store that is ready and live (as followOnce asks). */
const followsProject = (s: State, projectId: string | null, hostId: string): projectId is string =>
  !!projectId && s.status === 'ready' && s.live && hostProject(s, hostId) === projectId;

const isListFrame = (n: BoardNode | undefined) => n?.type === 'container' && (refOf(n) ?? '').startsWith('deck:');

/**
 * Where a list frame dragged on a project board goes. `at` is where it was dropped: the pointer for a drag, the
 * frame's new centre for a keyboard move; `rect` its new place.
 * - `move-list`: `at` is inside an area frame of this project (the smallest, not the list's own contents) other than
 *   the list's area. The list moves to that area in the project; the frame stays where it was until the store has it,
 *   then the board places it at the bottom of that area (an area is sized to its lists, so a list rarely fits inside
 *   another one whole).
 * - `stay`: the new place is inside another list frame: a list never goes into a list, so nothing is written.
 * - `place`: anything else, a position only (also on any board that does not follow its project).
 */
export type ListDrop = { kind: 'move-list'; deckId: string; spaceId: number; areaId: string } | { kind: 'stay' } | { kind: 'place' } | { kind: 'offline' };

/** What the store would be if it were live (the drop would be judged the same way as with a live store). */
const asLive = (s: State): State => ({ ...s, live: true });
/** A store that is ready but not live right now (the socket is down or a reload is in flight). */
const offline = (s: State) => s.status === 'ready' && !s.live;

export const OFFLINE_DROP = 'Not connected right now: the task stays where it is in the project.';
export const OFFLINE_LIST = 'Not connected right now: the list stays where it is in the project.';

export function listDrop(list: BoardNode, rect: Rect, at: Point, nodes: BoardNode[], s: State, projectId: string | null, hostId: string): ListDrop {
  if (!isListFrame(list)) return { kind: 'place' };
  // Not live: a move to another area can't be judged on current data, so the frame stays (`offline`), never 'place'.
  if (offline(s) && followsProject(asLive(s), projectId, hostId)) {
    const d = listDrop(list, rect, at, nodes, asLive(s), projectId, hostId);
    return d.kind === 'move-list' ? { kind: 'offline' } : d;
  }
  if (!followsProject(s, projectId, hostId)) return { kind: 'place' };
  const deck = s.decks.get((refOf(list) ?? '').slice(5));
  const spaces = new Set(s.projects.get(projectId)?.spaces.map((x) => x.id) ?? []);
  if (deck?.projectId === projectId) {
    const inside = new Set([list.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const n of nodes) if (n.pos.parent && inside.has(n.pos.parent) && !inside.has(n.id)) { inside.add(n.id); grew = true; }
    }
    let best: { node: BoardNode; spaceId: number } | null = null;
    for (const n of nodes) {
      const m = n.type === 'container' && !inside.has(n.id) ? /^area:(.+):(\d+)$/.exec(refOf(n) ?? '') : null;
      if (!m || m[1] !== projectId || !spaces.has(Number(m[2]))) continue;
      const p = n.pos;
      if (at.x < p.x || at.y < p.y || at.x > p.x + p.w || at.y > p.y + p.h) continue;
      if (!best || p.w * p.h < best.node.pos.w * best.node.pos.h) best = { node: n, spaceId: Number(m[2]) };
    }
    if (best && best.spaceId !== deck.spaceId) return { kind: 'move-list', deckId: deck.id, spaceId: best.spaceId, areaId: best.node.id };
  }
  const parent = containerAt(nodes, rect, list.id);
  return isListFrame(nodes.find((n) => n.id === parent)) ? { kind: 'stay' } : { kind: 'place' };
}

/** Nodes whose parent an undo or redo changed, with where they were: each goes through the drop path. */
export function parentChanges(before: BoardNode[], after: BoardNode[]): Array<{ node: BoardNode; parent: BoardNode | null; was: BoardNode }> {
  const was = new Map(before.map((n) => [n.id, n]));
  const now = new Map(after.map((n) => [n.id, n]));
  const out: Array<{ node: BoardNode; parent: BoardNode | null; was: BoardNode }> = [];
  for (const n of after) {
    const w = was.get(n.id);
    if (w && w.pos.parent !== n.pos.parent) out.push({ node: n, parent: n.pos.parent ? now.get(n.pos.parent) ?? null : null, was: w });
  }
  return out;
}

export function dropTarget(node: BoardNode, parent: BoardNode | null | undefined): DropTarget | null {
  if (parent?.type !== 'container') return null;
  const into = refOf(parent) ?? '';
  if (node.type === 'card' && into.startsWith('deck:')) return { kind: 'task', cardId: String(node.value.id), deckId: into.slice(5) };
  const self = node.type === 'container' ? refOf(node) ?? '' : '';
  const area = /^area:(.+):(\d+)$/.exec(into);
  if (self.startsWith('deck:') && area) return { kind: 'list', deckId: self.slice(5), projectId: area[1], spaceId: Number(area[2]) };
  return null;
}

/** Whether the store already has what the node's place on the board says. */
export function settled(t: DropTarget, s: State): boolean {
  return t.kind === 'task' ? s.cards.get(t.cardId)?.deckId === t.deckId : s.decks.get(t.deckId)?.spaceId === t.spaceId;
}

/**
 * What a node that has just landed in `newParent` asks of the project: a task card of this project in a list frame of
 * this project other than its task's list moves the task there; a list frame of this project in an area frame of
 * this project other than its list's area moves the list there. Anything else (a drop in its own frame, outside every
 * frame, into another project's frame) is only a position. Only on a board that shows its host task's project.
 */
export function dropIntent(node: BoardNode, newParent: BoardNode | null | undefined, s: State, projectId: string | null, hostId: string): DropIntent {
  if (!followsProject(s, projectId, hostId)) return null;
  const t = dropTarget(node, newParent);
  if (!t || settled(t, s)) return null;
  if (t.kind === 'task') {
    const card = s.cards.get(t.cardId), from = card?.deckId ? s.decks.get(card.deckId) : undefined, to = s.decks.get(t.deckId);
    if (!card || card.isDoc || from?.projectId !== projectId || to?.projectId !== projectId) return null;
    return { kind: 'move-task', cardId: card.id, deckId: to.id };
  }
  const deck = s.decks.get(t.deckId);
  const hasArea = s.projects.get(projectId)?.spaces.some((x) => x.id === t.spaceId);
  if (!deck || deck.projectId !== projectId || t.projectId !== projectId || !hasArea) return null;
  return { kind: 'move-list', deckId: deck.id, spaceId: t.spaceId };
}

export interface DropDeps {
  holds: Holds;
  dispatch: (ns: string, action: string, payload: object) => Promise<unknown>;
  /**
   * Puts the node back where the drag started, as the board's upkeep (a SYNC write, see moveBackSync: not an undo step);
   * called when the server refuses the move, or when the store is not live.
   */
  revert: () => void;
  /** The drop would move the task but the store is not live right now: called after `revert` (the caller toasts OFFLINE_DROP). */
  offline?: () => void;
  now?: () => number;
}

/** Whether a drop asks nothing of the project only because the store is not live right now. */
export function blockedOffline(node: BoardNode, newParent: BoardNode | null | undefined, s: State, projectId: string | null, hostId: string): boolean {
  return offline(s) && dropIntent(node, newParent, asLive(s), projectId, hostId) !== null;
}

/**
 * After a node's parent changed on the board (a drop, an undo): when that asks something of the project
 * (dropIntent), saves it. While the write is pending the node is held (the board's upkeep does not pull it back to
 * where the store still has it), and after it, until the store has the change or HOLD_MS pass. Refused: the node goes
 * back (the dispatch toasts why). Each call supersedes the node's earlier save: a pending one that ends later neither
 * puts the node back nor touches its hold. Resolves to the intent saved, or null when there was nothing to save, it
 * was refused, or it was superseded.
 */
export async function saveDrop(node: BoardNode, newParent: BoardNode | null | undefined, s: State, projectId: string | null, hostId: string, deps: DropDeps): Promise<DropIntent> {
  const { holds, dispatch, revert, now = Date.now } = deps;
  const token = holds.claim(node.id);
  const intent = dropIntent(node, newParent, s, projectId, hostId);
  const target = dropTarget(node, newParent);
  if (!intent || !target) {
    holds.end(node.id, token);
    // Not connected: the task can't move now, so neither does its card (a later pass would otherwise judge it on stale data).
    if (blockedOffline(node, newParent, s, projectId, hostId)) { revert(); deps.offline?.(); }
    return null;
  }
  try {
    if (intent.kind === 'move-task') await dispatch('cards', 'update', { id: intent.cardId, deckId: intent.deckId, parentCardId: null });
    else await dispatch('decks', 'update', { id: intent.deckId, spaceId: intent.spaceId });
  } catch {
    if (holds.end(node.id, token)) revert();
    return null;
  }
  return holds.end(node.id, token, { done: (x) => settled(target, x), until: now() + HOLD_MS }) ? intent : null;
}

const subtree = (nodes: BoardNode[], roots: Iterable<string>): Set<string> => {
  const out = new Set(roots);
  for (let grew = true; grew;) {
    grew = false;
    for (const n of nodes) if (n.pos.parent && out.has(n.pos.parent) && !out.has(n.id)) { out.add(n.id); grew = true; }
  }
  return out;
};

/** One move of the board: the position writes (one undo step), and what each moved node asks of the project. */
export interface MovePlan {
  changes: Array<{ id: string; pos: NodePos }>;
  /** Task cards whose frame changed: each goes through saveDrop (`start`: where to put it back if refused). */
  drops: Array<{ node: BoardNode; parent: BoardNode | null; start: NodePos }>;
  /** Lists dropped onto another area (listDrop): sent to the project; their frames are not written. */
  lists: Array<{ deckId: string; spaceId: number; areaId: string }>;
  /** A list frame was let go over another area while the store is not live: it stays, and the caller says why. */
  offline: boolean;
}

/**
 * A node, or a picked group, moved by (dx, dy): snapped by `lead`, each picked node (not one inside another picked
 * node) gets the container it now sits in and its contents follow. A list frame follows listDrop (`at`: the pointer,
 * or null for a keyboard move, which uses the frame's centre): onto another area it is not written and its list moves;
 * into another list, it stays. A task card whose frame changed is a drop.
 */
export function planMove(nodes: BoardNode[], ids: string[], lead: string, dx: number, dy: number, at: Point | null, s: State, projectId: string | null, hostId: string): MovePlan {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const picked = new Set(ids.filter((id) => byId.has(id)));
  const top = [...picked].filter((id) => { for (let p = byId.get(id)!.pos.parent, seen = 0; p && seen < 1000; p = byId.get(p)?.pos.parent ?? null, seen++) if (picked.has(p)) return false; return true; });
  const leader = byId.get(lead) ?? byId.get(top[0]);
  const plan: MovePlan = { changes: [], drops: [], lists: [], offline: false };
  if (!leader) return plan;
  const ddx = snap(leader.pos.x + dx) - leader.pos.x, ddy = snap(leader.pos.y + dy) - leader.pos.y;
  const shifted = (moved: Set<string>) => nodes.map((n) => (moved.has(n.id) ? { ...n, pos: { ...n.pos, x: n.pos.x + ddx, y: n.pos.y + ddy } } : n));
  const rectOf = (n: BoardNode) => ({ x: n.pos.x + ddx, y: n.pos.y + ddy, w: n.pos.w, h: n.pos.h });
  // Lists first: those that stay or move in the project are not written, nor what they hold.
  const firstAfter = shifted(subtree(nodes, top));
  const kept = top.filter((id) => {
    const n = byId.get(id)!, r = rectOf(n);
    const d = listDrop(n, r, at ?? { x: r.x + r.w / 2, y: r.y + r.h / 2 }, firstAfter, s, projectId, hostId);
    if (d.kind === 'move-list') plan.lists.push({ deckId: d.deckId, spaceId: d.spaceId, areaId: d.areaId });
    if (d.kind === 'offline') plan.offline = true;
    return d.kind === 'place';
  });
  const moved = subtree(nodes, kept);
  const after = shifted(moved);
  for (const id of kept) {
    const n = byId.get(id)!;
    const parent = containerAt(after, rectOf(n), id);
    const pos = { ...rectOf(n), parent };
    plan.changes.push({ id, pos });
    if (n.type === 'card' && parent !== n.pos.parent) plan.drops.push({ node: { ...n, pos }, parent: parent ? byId.get(parent) ?? null : null, start: n.pos });
  }
  for (const id of moved) if (!kept.includes(id)) { const n = byId.get(id)!; plan.changes.push({ id, pos: { ...n.pos, x: n.pos.x + ddx, y: n.pos.y + ddy } }); }
  return plan;
}

/**
 * A refused drop's node goes back to `start`, what it holds with it, as the board's own upkeep (SYNC): not an undo
 * step, so the refused drop leaves only its own step, and undoing that changes no frame and sends nothing.
 */
export function moveBackSync(doc: Y.Doc, id: string, start: NodePos): void {
  const now = readBoard(doc).nodes;
  const self = now.find((n) => n.id === id);
  if (!self) return;
  const dx = start.x - self.pos.x, dy = start.y - self.pos.y;
  const inside = subtree(now, [id]);
  const nodes = boardMaps(doc).nodes;
  doc.transact(() => {
    for (const n of now) {
      if (!inside.has(n.id)) continue;
      nodes.get(n.id)?.set('pos', n.id === id ? { ...self.pos, x: start.x, y: start.y, parent: start.parent } : { ...n.pos, x: n.pos.x + dx, y: n.pos.y + dy });
    }
  }, SYNC);
}

/**
 * A list moved to another area by a drop is recorded as one undo step: `meta.listMove` (a list move writes nothing
 * else on the board). Undo sends the list back to `from`, redo to `to` (listMoveToSend).
 */
export interface ListMove { deckId: string; from: number; to: number; n: string }
export const LIST_MOVE = 'listMove';

export function markListMove(doc: Y.Doc, m: Omit<ListMove, 'n'>): void {
  doc.transact(() => boardMaps(doc).meta.set(LIST_MOVE, { ...m, n: newId() }), LOCAL);
}

export function readListMove(doc: Y.Doc): ListMove | null {
  const v = boardMaps(doc).meta.get(LIST_MOVE) as Partial<ListMove> | undefined;
  return v && typeof v.deckId === 'string' && Number.isInteger(v.from) && Number.isInteger(v.to) && typeof v.n === 'string' ? (v as ListMove) : null;
}

/** What an undo (or redo) of a list move asks of the project, from the marker before and after the step. */
export function listMoveToSend(before: ListMove | null, after: ListMove | null, redo: boolean): { deckId: string; spaceId: number } | null {
  if (before?.n === after?.n) return null;
  if (redo) return after ? { deckId: after.deckId, spaceId: after.to } : null;
  return before ? { deckId: before.deckId, spaceId: before.from } : null;
}
