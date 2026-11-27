import type { Card, VisionBoard, BoardState } from '../../../shared/types';
import type { BoardEdge, BoardNode } from '../../../shared/board';
import { derivedStatus } from '../../../shared/cards';
import { canEditCard, canManageProject, isAdmin, store, type State } from '../store';
import { dispatch } from '../api';
import { openByCard } from '../cards';
import { spaceLabel } from '../spaces';
import type { FrameInput } from './projectFrames';

/** Mirrors server/boards.ts boardAccess for the signed-in user (the store only holds cards they can see). */
export function boardLevel(s: State, board: VisionBoard): 'none' | 'view' | 'edit' {
  const card = s.cards.get(board.cardId);
  if (!card || card.visibility === 'deleted') return 'none';
  if (board.state === 'locked' || (board.state === 'read_only' && board.creatorId !== s.me?.id)) return 'view';
  return mayEditHost(s, card) ? 'edit' : 'view';
}

export function mayEditHost(s: State, card: Card): boolean {
  const deck = card.deckId ? s.decks.get(card.deckId) : undefined;
  return canEditCard(s, card, deck ? s.projects.get(deck.projectId) : undefined);
}

/** Changing the state or deleting: the creator while they can still edit the card, or a manager of its project. */
export function canManageBoard(s: State, board: VisionBoard): boolean {
  const card = s.cards.get(board.cardId);
  if (!card) return false;
  if (board.creatorId === s.me?.id && mayEditHost(s, card)) return true;
  const deck = card.deckId ? s.decks.get(card.deckId) : undefined;
  const project = deck ? s.projects.get(deck.projectId) : undefined;
  return project ? canManageProject(s, project) : isAdmin(s);
}

export const boardOfCard = (s: State, cardId: string): VisionBoard | undefined =>
  [...s.visionBoards.values()].find((b) => b.cardId === cardId);

export const boardBySeq = (s: State, seq: number): VisionBoard | undefined =>
  [...s.visionBoards.values()].find((b) => b.accountSeq === seq);

/** A card board opens on Home, picked in its Boards toolbar. */
export const boardPath = (seq: number) => `/home?board=${seq}`;

/**
 * Where an old link leads now that the Vision board page is gone: `/vision/<seq>` to Home with that board picked,
 * `/vision` to `fallback` (the last opened board, or Home). Its other query parameters (`tree`, `story`) are kept.
 */
export function oldBoardUrl(seq: number | null, query: URLSearchParams, fallback = '/home'): string {
  const head = seq ? boardPath(seq) : fallback;
  const q = new URLSearchParams(query);
  q.delete('board');
  const rest = q.toString();
  return rest ? `${head}${head.includes('?') ? '&' : '?'}${rest}` : head;
}

export const STATE_LABEL: Record<BoardState, string> = { default: 'Default', read_only: 'Read only', locked: 'Locked' };
export const STATE_HINT: Record<BoardState, string> = {
  default: 'Everyone who can edit the task can edit the map',
  read_only: 'Only the person who made the map can edit it',
  locked: 'Nobody can edit it until it is unlocked',
};

const LAST_KEY = 'last-vision-board';
const RECENT_KEY = 'vision-recent-boards';
const RECENT_MAX = 5;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* not remembered */ }
}

export function lastBoardSeq(): number | null {
  const n = Number(read(LAST_KEY));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Board seqs, newest first, at most five. */
export function recentBoardSeqs(): number[] {
  try {
    const v = JSON.parse(read(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)).slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

export function rememberBoard(seq: number) {
  write(LAST_KEY, String(seq));
  write(RECENT_KEY, JSON.stringify([seq, ...recentBoardSeqs().filter((n) => n !== seq)].slice(0, RECENT_MAX)));
}

export function forgetBoard(seq: number) {
  if (lastBoardSeq() === seq) write(LAST_KEY, null);
  write(RECENT_KEY, JSON.stringify(recentBoardSeqs().filter((n) => n !== seq)));
}

/** Where the Workspace menu's "Vision boards" goes: the last opened board on Home if it still exists, else Home. */
export function visionHref(s: State = store.get()): string {
  const seq = lastBoardSeq();
  return seq !== null && boardBySeq(s, seq) ? boardPath(seq) : '/home';
}

/** Creates the board of a card and returns its seq. The row is added locally so the page can open before the live push. */
export async function createBoard(card: Card): Promise<number> {
  const { id, accountSeq } = await dispatch<{ id: string; accountSeq: number }>('visionBoard', 'createBoard', { cardId: card.id });
  const now = Date.now();
  const me = store.get().me?.id ?? '';
  store.apply([{ model: 'visionBoard', op: 'upsert', row: { id, accountSeq, cardId: card.id, creatorId: me, state: 'default', createdAt: now, updatedAt: now } satisfies VisionBoard }]);
  return accountSeq;
}

/**
 * What the frame layout needs to know about a project: its areas, lists (in order), open tasks (not done, archived,
 * deleted or lore) and dependencies, with the board as it is. `gone` (see goneTasks) is empty for a one-off layout,
 * which removes no task. Null when the project is not loaded.
 */
export function frameInput(s: State, projectId: string, nodes: BoardNode[], edges: BoardEdge[], gone: Set<string> = new Set()): FrameInput | null {
  const project = s.projects.get(projectId);
  if (!project) return null;
  const open = openByCard(s.resolvables.values());
  const decks = [...s.decks.values()].filter((d) => d.projectId === projectId).sort((x, y) => x.sortIndex - y.sortIndex || x.seq - y.seq);
  const inDeck = new Set(decks.map((d) => d.id));
  const cards = [...s.cards.values()].filter((c) => c.deckId && inDeck.has(c.deckId) && c.visibility === 'default' && !c.isDoc
    && derivedStatus(c, open.get(c.id) ?? new Set()) !== 'done');
  return {
    project, spaces: project.spaces, decks, cards, gone, deps: [...s.cardDeps.values()], nodes, edges,
    deckOf: (id) => s.cards.get(id)?.deckId ?? undefined,
    areaName: (id) => { const sp = project.spaces.find((x) => x.id === id); return sp ? spaceLabel(sp) : ''; },
  };
}

/**
 * The project a board belongs to: the project of its host card's list. A board follows, lays out or arranges only this
 * project, so nothing of a project the board's other editors may not see is ever written into it.
 */
export function hostProject(s: State, hostId: string): string | null {
  const c = s.cards.get(hostId), deck = c?.deckId ? s.decks.get(c.deckId) : undefined;
  return deck?.projectId ?? null;
}

export const OTHER_PROJECT = 'A board can only show the project it belongs to.';

export const HOME_CARD_REFUSED = 'Home is shared with the whole workspace: only tasks of projects every member sees can go on it.';

/**
 * Whether a task may go on Home as a card node: Home's doc goes to everyone in the workspace, so only a task of a
 * project every member sees (visibility 'full', server/permissions.ts canView), never a deckless or limited one.
 */
export function homeCardAllowed(s: State, cardId: string): boolean {
  const c = s.cards.get(cardId), d = c?.deckId ? s.decks.get(c.deckId) : undefined, p = d ? s.projects.get(d.projectId) : undefined;
  return p?.visibility === 'full';
}

export const HOME_NO_PROJECT = 'Pictures and Smart Nodes on Home are kept with a project every member sees. There is none yet that is not archived.';

/** Projects Home's pictures and Smart Nodes may be kept for (server/boards.ts homeProjectAllowed): every member sees them, not archived. */
export function homeProjects(s: State) {
  return [...s.projects.values()].filter((p) => p.visibility === 'full' && !p.isArchived).sort((a, b) => a.seq - b.seq);
}

/** Why "Add project" / "Arrange as frames" may not show `projectId` on the board hosted by `hostId`, or null. */
export function refuseProject(s: State, hostId: string, projectId: string): string | null {
  return hostProject(s, hostId) === projectId ? null : OTHER_PROJECT;
}

/**
 * The tasks whose cards must leave this project's board, and the project's tasks as of now (pass them back as `known`
 * next time). Gone is only what the store says about tasks of this project, never "anything not open":
 * - a task of the project that is done or archived (the snapshot and live events keep those in the store);
 * - a task that was in the project at the last call (`known`) and no longer is: deleted (a deleted card leaves the
 *   store), moved to another project, or out of sight;
 * - with `nodes`, a card sitting in one of this project's list frames whose task the store does not have (deleted
 *   while the board was closed). Only pass `nodes` when the store is live (current): a stale store misses new tasks.
 * Loose cards (outside every frame) whose task the store never saw in this project are not gone. Lore pages never are.
 */
export function goneTasks(s: State, projectId: string, known: ReadonlySet<string>, nodes: BoardNode[] = []): { gone: Set<string>; now: Set<string> } {
  const open = openByCard(s.resolvables.values());
  const gone = new Set<string>(), now = new Set<string>();
  for (const c of s.cards.values()) {
    const deck = c.deckId ? s.decks.get(c.deckId) : undefined;
    if (deck?.projectId !== projectId || c.isDoc) continue;
    now.add(c.id);
    if (c.visibility !== 'default' || derivedStatus(c, open.get(c.id) ?? new Set()) === 'done') gone.add(c.id);
  }
  for (const id of known) if (!now.has(id) && !s.cards.get(id)?.isDoc) gone.add(id);
  // This project's list frames: a frame of one of its lists, or any list frame inside one of its area frames.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ref = (n: BoardNode | undefined) => (n?.type === 'container' && typeof n.value.ref === 'string' ? n.value.ref : '');
  const ownList = (id: string | null) => {
    const f = id ? byId.get(id) : undefined, r = ref(f);
    if (!r.startsWith('deck:')) return false;
    return s.decks.get(r.slice(5))?.projectId === projectId || ref(byId.get(f!.pos.parent ?? '')).startsWith(`area:${projectId}:`);
  };
  for (const n of nodes) {
    if (n.type !== 'card' || typeof n.value.id !== 'string' || s.cards.has(n.value.id)) continue;
    if (ownList(n.pos.parent)) gone.add(n.value.id);
  }
  return { gone, now };
}

/**
 * A board for a whole project: a lore page in the project's first list hosts it (boards live on tasks), and the
 * board opens with `?tree=<project>` so the canvas lays the project out as frames straight away and remembers it as
 * the board's project.
 */
export async function createProjectBoard(projectId: string): Promise<string> {
  const s = store.get(), project = s.projects.get(projectId);
  const deck = [...s.decks.values()].filter((d) => d.projectId === projectId).sort((a, b) => a.sortIndex - b.sortIndex || a.seq - b.seq)[0];
  if (!project || !deck) throw new Error('no_list');
  const content = `${project.name} vision board`;
  const made = await dispatch<{ id: string }>('cards', 'create', { deckId: deck.id, content, isDoc: true })
    .catch(() => dispatch<{ id: string }>('cards', 'create', { deckId: deck.id, content })); // a list that takes no lore gets a plain task
  const seq = await createBoard({ id: made.id } as Card);
  return `${boardPath(seq)}&tree=${encodeURIComponent(projectId)}`;
}
