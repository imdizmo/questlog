import { useEffect } from 'react';
import * as Y from 'yjs';
import { store, type State } from '../store';
import { frameInput, goneTasks, hostProject } from './boards';
import { reconcile, type BoardPatch } from './projectFrames';
import { refOf } from './projectTree';
import { boardMaps, LOCAL, readBoard, readNode, readProjectId, SYNC, unparentOrphans, writePatch } from './useBoard';
import { dropTarget, HOLD_MS, settled } from './drop';
import type { BoardNode, NodePos } from '../../../shared/board';

/** How long the board waits after the last change before following it: a burst of live events is one pass. */
export const FOLLOW_DELAY = 300;

export const emptyPatch = (p: BoardPatch) =>
  !p.add.length && !p.addEdges.length && !p.move.length && !p.remove.length && !p.removeEdges.length && !p.update.length && !p.updateEdges?.length;

/**
 * The patch without moves of the given nodes and of what they hold (a card or list frame whose drop is still being
 * saved: a held list frame's cards stay with it), and without removing held lines (a "waits for" or subtask line an
 * undo brought back while its dependency or parent is being saved again).
 */
export function withoutMoves(p: BoardPatch, held: ReadonlySet<string>, nodes: BoardNode[] = []): BoardPatch {
  if (!held.size) return p;
  const keep = new Set(held);
  for (let grew = true; grew;) {
    grew = false;
    for (const n of nodes) if (n.pos.parent && keep.has(n.pos.parent) && !keep.has(n.id)) { keep.add(n.id); grew = true; }
  }
  return { ...p, move: p.move.filter((m) => !keep.has(m.id)), removeEdges: p.removeEdges.filter((id) => !held.has(id)) };
}

/**
 * Nodes the board's upkeep must leave where they are for now: a drop whose project change is being saved (by this
 * client), or one another client just made (its change reaches this client's store after the board update). Each is
 * let go when the store has the change (`done`) or its time is up, whichever comes first. Entries never outlive
 * their time, so the set stays small.
 */
export class Holds {
  private m = new Map<string, { until: number; done: (s: State) => boolean }>();
  /** The latest save of each node whose save is still pending (only that one may end its hold or put it back). */
  private saves = new Map<string, number>();
  private seq = 0;
  set(id: string, done: (s: State) => boolean, until: number): void { this.m.set(id, { until, done }); }
  delete(id: string): void { this.m.delete(id); }
  /** A new save of the node's place starts: held until it ends; any earlier save of the node is superseded. */
  claim(id: string): number {
    const t = ++this.seq;
    this.saves.set(id, t);
    this.m.set(id, { until: Infinity, done: () => false });
    return t;
  }
  /** Whether `token` is still the node's latest save. */
  owns(id: string, token: number): boolean { return this.saves.get(id) === token; }
  /**
   * The save `token` ended: if it is still the latest, the node is let go, or (with `after`) held until the store has
   * the change or the time is up. Returns whether it was the latest (a superseded save must change nothing).
   */
  end(id: string, token: number, after?: { done: (s: State) => boolean; until: number }): boolean {
    if (!this.owns(id, token)) return false;
    this.saves.delete(id);
    if (after) this.m.set(id, after); else this.m.delete(id);
    return true;
  }
  get size(): number { return this.m.size; }
  /** The node ids held now; what is done or past its time is let go. */
  current(s: State, now = Date.now()): Set<string> {
    for (const [id, h] of this.m) if (h.until <= now || h.done(s)) this.m.delete(id);
    return new Set(this.m.keys());
  }
  /** When the earliest hold with a time runs out, or null. */
  next(): number | null {
    let t = Infinity;
    for (const h of this.m.values()) t = Math.min(t, h.until);
    return Number.isFinite(t) ? t : null;
  }
}

/**
 * Another client's drop arrives as a board update before this client's store learns the task's new list (or the
 * list's new area): until it does (or HOLD_MS pass), the node is held, so this client's pass does not pull it back.
 * Watches node moves that change `parent` in transactions that are not this client's (not LOCAL, SYNC or an undo).
 */
export function watchRemoteDrops(doc: Y.Doc, holds: Holds, now: () => number = Date.now): () => void {
  const nodes = boardMaps(doc).nodes;
  const onDeep = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>, tr: Y.Transaction) => {
    if (tr.origin === LOCAL || tr.origin === SYNC || tr.origin instanceof Y.UndoManager) return;
    for (const ev of events) {
      if (ev.target === nodes || !(ev instanceof Y.YMapEvent) || !ev.keysChanged.has('pos')) continue;
      const id = ev.path[0];
      const m = typeof id === 'string' ? nodes.get(id) : undefined;
      const n = m instanceof Y.Map ? readNode(id as string, m) : null;
      const old = ev.changes.keys.get('pos')?.oldValue as Partial<NodePos> | undefined;
      if (!n || (old?.parent ?? null) === n.pos.parent) continue;
      const pm = n.pos.parent ? nodes.get(n.pos.parent) : undefined;
      const t = dropTarget(n, pm instanceof Y.Map ? readNode(n.pos.parent!, pm) : null);
      if (t) holds.set(n.id, (s) => settled(t, s), now() + HOLD_MS);
    }
  };
  nodes.observeDeep(onDeep);
  return () => nodes.unobserveDeep(onDeep);
}

export interface Known { projectId: string; tasks: Set<string> }

/**
 * One pass of the board's upkeep, as SYNC writes (never undone): nodes whose parent frame is gone become loose; on a
 * project board, the board follows the project (reconcile). `known` is the project's tasks at the last pass (see
 * goneTasks); the returned value is the one to pass next time.
 *
 * Plans nothing (and returns `known` as it was) unless the board's project is its host card's project (anything else
 * could write a project the board's other editors may not see), and the store is ready and live (current data: a
 * stale store after a reconnect would take reopened tasks for gone).
 */
export function followOnce(doc: Y.Doc, s: State, hostId: string, known: Known | null, held: ReadonlySet<string> = new Set()): Known | null {
  const maps = boardMaps(doc);
  unparentOrphans(doc, maps);
  const pid = readProjectId(maps.meta);
  if (!pid) return null;
  if (s.status !== 'ready' || !s.live || !s.projects.has(pid) || hostProject(s, hostId) !== pid) return known;
  const { nodes, edges } = readBoard(doc);
  const { gone, now } = goneTasks(s, pid, known?.projectId === pid ? known.tasks : new Set(), nodes);
  const inp = frameInput(s, pid, nodes, edges, gone);
  if (!inp) return known;
  const patch = withoutMoves(reconcile(inp), held, nodes);
  if (!emptyPatch(patch)) writePatch(doc, maps, patch, SYNC);
  return { projectId: pid, tasks: now };
}

/**
 * Whether a board transaction can matter to a pass: not the pass's own (SYNC), and not only a new value of nodes that
 * stand for nothing in the project (typing in a note or a user's own frame label).
 */
export function mayAffect(doc: Y.Doc, tr: Y.Transaction): boolean {
  if (tr.origin === SYNC || !tr.changed.size) return false;
  const nodes = boardMaps(doc).nodes;
  for (const [type, keys] of tr.changed) {
    if (!(type instanceof Y.Map) || type.parent !== nodes || [...keys].some((k) => k !== 'value')) return true;
    const id = type._item?.parentSub; // the node's key in the nodes map
    const n = id ? readNode(id, type) : null;
    if (!n || refOf(n) !== null) return true;
  }
  return false;
}

/**
 * While the board is open and this client may edit it, it follows the project by itself: after the document has
 * synced, once, then FOLLOW_DELAY after the last change to the store or to the board that may matter (mayAffect: other
 * clients' changes, an undo). Reads the board from the document right before planning.
 *
 * `busy` says a gesture (a node drag or resize) is in progress: the pass waits until it ends, so it never moves what
 * the user holds. `holds` names nodes reconcile must not move even then: this client's drops whose project change is
 * being saved (the board adds them), and other clients' drops this client's store has not caught up with
 * (watchRemoteDrops, here). When a hold runs out, a pass follows.
 */
export function useFollowProject(doc: Y.Doc | null, hostId: string, canEdit: boolean, busy: () => boolean, holds: Holds): void {
  useEffect(() => {
    if (!doc || !canEdit) return;
    let timer: ReturnType<typeof setTimeout> | null = null, expiry: ReturnType<typeof setTimeout> | null = null, stopped = false, synced = false;
    let known: Known | null = null;
    const run = () => {
      timer = null;
      if (stopped) return;
      if (busy()) { schedule(); return; }
      const s = store.get();
      known = followOnce(doc, s, hostId, known, holds.current(s));
      // A hold that runs out without the store catching up: one more pass then (it goes where the store says).
      if (expiry !== null) clearTimeout(expiry);
      const next = holds.next();
      expiry = next === null ? null : setTimeout(() => { expiry = null; schedule(); }, Math.max(0, next - Date.now()) + 10);
    };
    const schedule = () => {
      if (!synced || stopped) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(run, FOLLOW_DELAY);
    };
    // Only what the plan reads: cards, lists, the project (areas, names), dependencies, threads (done-ness), load state.
    const watched = (x: State) => [x.status, x.live, x.cards, x.decks, x.projects, x.cardDeps, x.resolvables] as const;
    let last = watched(store.get());
    const onStore = () => {
      const next = watched(store.get());
      if (next.some((v, i) => v !== last[i])) schedule();
      last = next;
    };
    const onTx = (tr: Y.Transaction) => { if (mayAffect(doc, tr)) schedule(); };
    const offStore = store.subscribe(onStore);
    const offDrops = watchRemoteDrops(doc, holds);
    doc.on('afterTransaction', onTx);
    void doc.whenSynced.then(() => { synced = true; schedule(); });
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      if (expiry !== null) clearTimeout(expiry);
      offStore();
      offDrops();
      doc.off('afterTransaction', onTx);
    };
  }, [doc, hostId, canEdit, holds]); // eslint-disable-line react-hooks/exhaustive-deps -- busy is read live
}
