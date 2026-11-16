import type { Card, VisionBoard, BoardState } from '../../../shared/types';
import { canEditCard, canManageProject, isAdmin, store, type State } from '../store';
import { dispatch } from '../api';

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

export const boardPath = (seq: number) => `/vision/${seq}`;

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

/** Where the Vision link and Shift+4 go: the last opened board if it still exists, else /vision (which picks one). */
export function visionHref(s: State = store.get()): string {
  const seq = lastBoardSeq();
  return seq !== null && boardBySeq(s, seq) ? boardPath(seq) : '/vision';
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
 * A board for a whole project: a lore page in the project's first list hosts it (boards live on tasks), and the
 * board opens with `?tree=<project>` so the canvas lays the project out as a tree straight away.
 */
export async function createProjectBoard(projectId: string): Promise<string> {
  const s = store.get(), project = s.projects.get(projectId);
  const deck = [...s.decks.values()].filter((d) => d.projectId === projectId).sort((a, b) => a.sortIndex - b.sortIndex || a.seq - b.seq)[0];
  if (!project || !deck) throw new Error('no_list');
  const content = `${project.name} vision board`;
  const made = await dispatch<{ id: string }>('cards', 'create', { deckId: deck.id, content, isDoc: true })
    .catch(() => dispatch<{ id: string }>('cards', 'create', { deckId: deck.id, content })); // a list that takes no lore gets a plain task
  const seq = await createBoard({ id: made.id } as Card);
  return `${boardPath(seq)}?tree=${encodeURIComponent(projectId)}`;
}
