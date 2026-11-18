import type { BoardEdge, BoardNode } from '../../../shared/board';
import { isAdmin, settingsOf, type State } from '../store';
import { lockersOf } from '../relations';
import { standsFor } from './projectFrames';
import { refOf, SUBTASK, WAITS_FOR } from './projectTree';

// What lines between tasks mean on a board, and what a board may not delete: pure helpers the canvas calls.

type Dispatch = (ns: string, action: string, payload: object) => Promise<unknown>;

/**
 * What "What does this line mean?" offers for "waits for":
 * - 'on': dependencies are on, "It waits for it";
 * - 'turn-on': they are off on a project board and this user may change the workspace's settings (an admin):
 *   "It waits for it (turns on dependencies)";
 * - 'ask-admin': off on a project board, anyone else: the line "An admin can turn on dependencies in Settings.";
 * - 'hidden': off on any other board.
 */
export type DepChoice = 'on' | 'turn-on' | 'ask-admin' | 'hidden';
export function depChoice(s: State, projectBoard: boolean): DepChoice {
  if (settingsOf(s).dependenciesEnabled) return 'on';
  if (!projectBoard) return 'hidden';
  return isAdmin(s) ? 'turn-on' : 'ask-admin';
}
export const ASK_ADMIN = 'An admin can turn on dependencies in Settings.';

/**
 * Saves what a line from task `a` to task `b` means: `a` waits for `b` ('dep') or `b` is `a`'s subtask ('sub').
 * With `turnOn`, dependencies are switched on for the workspace first (the same command as the settings page).
 * Rejects when the server refuses either (the dispatch toasts why).
 */
export async function saveLink(kind: 'dep' | 'sub', a: string, b: string, s: State, dispatch: Dispatch, turnOn = false): Promise<void> {
  if (kind === 'dep' && turnOn) await dispatch('accounts', 'update', { settings: { dependenciesEnabled: true } });
  const patch = kind === 'dep' ? { inDeps: [...new Set([...lockersOf(s.cardDeps.values(), a), b])] } : { parentCardId: b };
  await dispatch('cards', 'update', { id: a, ...patch });
}

/** The task a card node stands for (its `card:` ref), else undefined. */
const taskOf = (nodes: Map<string, BoardNode>) => (id: string): string | undefined => {
  const n = nodes.get(id);
  return n?.type === 'card' && typeof n.value.id === 'string' ? n.value.id : undefined;
};

/** What the line stands for in the project as the store has it now (see standsFor), with its two tasks. */
export function meaningOf(e: BoardEdge, nodes: BoardNode[] | Map<string, BoardNode>, s: State): { kind: 'dep' | 'sub'; a: string; b: string } | null {
  const byId = nodes instanceof Map ? nodes : new Map(nodes.map((n) => [n.id, n]));
  const task = taskOf(byId);
  const deps = new Set([...s.cardDeps.values()].map((d) => `${d.lockedCardId}>${d.lockingCardId}`));
  const kind = standsFor(e, task, (x, y) => deps.has(`${x}>${y}`), (id) => s.cards.get(id)?.parentCardId);
  const a = task(e.value.source.nodeId), b = task(e.value.target.nodeId);
  return kind && a && b ? { kind, a, b } : null;
}

/** What taking the meaning of a line away sends: the dependency, or the parent, when the store still has it. */
export function unlinkCall(m: { kind: 'dep' | 'sub'; a: string; b: string }, s: State): { ns: string; action: string; payload: object } | null {
  if (m.kind === 'dep') {
    const lockers = lockersOf(s.cardDeps.values(), m.a);
    return lockers.includes(m.b) ? { ns: 'cards', action: 'update', payload: { id: m.a, inDeps: lockers.filter((x) => x !== m.b) } } : null;
  }
  return s.cards.get(m.b)?.parentCardId === m.a ? { ns: 'cards', action: 'update', payload: { id: m.b, parentCardId: null } } : null;
}

/** What giving a line its meaning back sends: the dependency, or the parent, when the store does not have it. */
export function linkCall(m: { kind: 'dep' | 'sub'; a: string; b: string }, s: State): { ns: string; action: string; payload: object } | null {
  if (m.kind === 'dep') {
    const lockers = lockersOf(s.cardDeps.values(), m.a);
    return lockers.includes(m.b) ? null : { ns: 'cards', action: 'update', payload: { id: m.a, inDeps: [...lockers, m.b] } };
  }
  return s.cards.get(m.b)?.parentCardId === m.a ? null : { ns: 'cards', action: 'update', payload: { id: m.b, parentCardId: m.a } };
}

/**
 * What an undo or redo step that brought back or took away "waits for" and subtask lines asks of the project: a line
 * that came back (an undone delete) sends its dependency or parent again, a line that went (a redone delete) takes it
 * away again. Only lines marked with a `kind` (see standsFor), and only when both end cards were on the board before
 * and after the step: a step that added or removed the cards themselves (a layout, a deleted card) sends nothing.
 */
export function edgeStepCalls(before: { nodes: BoardNode[]; edges: BoardEdge[] }, after: { nodes: BoardNode[]; edges: BoardEdge[] }, s: State):
  Array<{ edgeId: string; restored: boolean; kind: 'dep' | 'sub'; a: string; b: string; call: { ns: string; action: string; payload: object } }> {
  const was = new Map(before.nodes.map((n) => [n.id, n])), now = new Map(after.nodes.map((n) => [n.id, n]));
  const oldEdges = new Set(before.edges.map((e) => e.id)), newEdges = new Set(after.edges.map((e) => e.id));
  const out: ReturnType<typeof edgeStepCalls> = [];
  const look = (e: BoardEdge, restored: boolean) => {
    const kind = e.value.kind;
    if (!kind || e.label !== (kind === 'dep' ? WAITS_FOR : SUBTASK)) return;
    const ta = taskOf(was), tb = taskOf(now);
    const a = ta(e.value.source.nodeId), b = ta(e.value.target.nodeId);
    if (!a || !b || tb(e.value.source.nodeId) !== a || tb(e.value.target.nodeId) !== b) return;
    const m = { kind, a, b };
    const call = restored ? linkCall(m, s) : unlinkCall(m, s);
    if (call) out.push({ edgeId: e.id, restored, ...m, call });
  };
  for (const e of after.edges) if (!oldEdges.has(e.id)) look(e, true);
  for (const e of before.edges) if (!newEdges.has(e.id)) look(e, false);
  return out;
}

/** The project's own frames on its board: area and list frames and the header. They follow the project. */
export const isProjectFrame = (n: BoardNode | undefined): boolean => {
  const r = n ? refOf(n) ?? '' : '';
  return (n?.type === 'container' && /^(area|deck):/.test(r)) || (n?.type === 'text' && r.startsWith('project:'));
};
export const FRAME_DELETE = 'Project frames follow the project; delete the list or area from the project instead.';

/** Of the nodes a delete names, those it may remove; on a project board the project's frames are kept (`refused`). */
export function deletable(nodes: BoardNode[], ids: Iterable<string>, projectBoard: boolean): { ok: string[]; refused: boolean } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ok: string[] = [];
  let refused = false;
  for (const id of ids) {
    if (projectBoard && isProjectFrame(byId.get(id))) refused = true; else ok.push(id);
  }
  return { ok, refused };
}
