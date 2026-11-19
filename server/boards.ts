import * as Y from 'yjs';
import { newId, type Db } from './db';
import { can, projectConfined, type Who } from './permissions';
import { canSeeCard } from './access';
import type { VisionBoard, VisionQuery, BoardState } from '../shared/types';

/**
 * Seam for the realtime room (Task 2 replaces the no-ops). Both run after the transaction commits.
 * onChange: state changed, so connected editors must be re-checked. onDelete: the board is gone, close its room.
 */
export const boardHooks = {
  onChange: (_boardId: string): void => {},
  onDelete: (_boardId: string): void => {},
  /** The board's loaded room doc (with edits not yet saved), if its room is loaded. */
  liveDoc: (_boardId: string): Y.Doc | undefined => undefined,
};

/** The queryIds that the board's filter nodes point at now: from the loaded room if any, else from the stored doc. */
export function referencedQueryIds(db: Db, boardId: string): Set<string> {
  const ids = new Set<string>();
  const collect = (doc: Y.Doc) => {
    for (const y of doc.getMap<unknown>('nodes').values()) {
      if (!(y instanceof Y.Map) || y.get('type') !== 'filter') continue;
      const v = y.get('value') as { queryId?: unknown } | undefined;
      if (v && typeof v.queryId === 'string') ids.add(v.queryId);
    }
  };
  const live = boardHooks.liveDoc(boardId);
  if (live) { collect(live); return ids; }
  const r = db.prepare('SELECT doc FROM vision_boards WHERE id=?').get(boardId) as { doc: Uint8Array | null } | undefined;
  if (r?.doc && r.doc.byteLength) {
    const doc = new Y.Doc();
    try { Y.applyUpdate(doc, r.doc); collect(doc); } finally { doc.destroy(); }
  }
  return ids;
}

export type BoardKind = 'card' | 'home';
/** What access is decided from. `kind` 'home' (the workspace's Home board) has no host card; absent means 'card'. */
type BoardRef = Pick<VisionBoard, 'creatorId' | 'state'> & { cardId: string | null; kind?: BoardKind };
type BoardRow = { id: string; account_seq: number; card_id: string; creator_id: string; state: BoardState; created_at: number; updated_at: number };

/** A card board's row. The Home board is not one: it has no host card and is never in the store's visionBoards. */
export function visionBoardRow(db: Db, id: string): VisionBoard | undefined {
  const r = db.prepare("SELECT id, account_seq, card_id, creator_id, state, created_at, updated_at FROM vision_boards WHERE id=? AND kind='card'").get(id) as BoardRow | undefined;
  return r && { id: r.id, accountSeq: r.account_seq, cardId: r.card_id, creatorId: r.creator_id, state: r.state, createdAt: r.created_at, updatedAt: r.updated_at };
}

/** Any board, Home included: what the realtime rooms need to admit a socket. */
export function anyBoardRow(db: Db, id: string): (BoardRef & { id: string; kind: BoardKind }) | undefined {
  const r = db.prepare('SELECT id, kind, card_id, creator_id, state FROM vision_boards WHERE id=?').get(id) as
    { id: string; kind: BoardKind; card_id: string | null; creator_id: string; state: BoardState } | undefined;
  return r && { id: r.id, kind: r.kind, cardId: r.card_id, creatorId: r.creator_id, state: r.state };
}

/**
 * The workspace's Home board, made on first use (idempotent: one home row, see migration 039). `account_seq` 0: card
 * boards count from 1, so Home never takes a board's number.
 */
export function homeBoardId(db: Db, creatorId: string): string {
  const found = db.prepare("SELECT id FROM vision_boards WHERE kind='home'").get() as { id: string } | undefined;
  if (found) return found.id;
  const t = Date.now();
  db.prepare("INSERT OR IGNORE INTO vision_boards (id, kind, account_seq, card_id, creator_id, state, created_at, updated_at) VALUES (?, 'home', 0, NULL, ?, 'default', ?, ?)")
    .run(newId(), creatorId, t, t);
  return (db.prepare("SELECT id FROM vision_boards WHERE kind='home'").get() as { id: string }).id;
}

/**
 * Home: owner, admins and members edit; observers see it; guests (Open Decks visitors) and project-confined tokens
 * never. Not switched off by the vision-board setting (Home is always there).
 */
export function homeAccess(db: Db, user: Who): 'none' | 'view' | 'edit' {
  if (projectConfined(user) || !can(db, user, 'workspace.personal')) return 'none';
  return can(db, user, 'workspace.edit') ? 'edit' : 'view';
}

export function visionQueryRow(db: Db, id: string): VisionQuery | undefined {
  const r = db.prepare('SELECT * FROM vision_queries WHERE id=?').get(id) as { id: string; card_id: string; creator_id: string; query: string; created_at: number } | undefined;
  return r && { id: r.id, cardId: r.card_id, creatorId: r.creator_id, query: JSON.parse(r.query), createdAt: r.created_at };
}

/**
 * What a user may do with a board. Home: homeAccess.
 * none: host card deleted or gone, or its project/deck not visible to the user. An archived host card still gives view.
 * edit: default = anyone who may edit the host card; read_only = only the board's creator (who also may edit the card); locked = nobody.
 */
export function boardAccess(db: Db, user: Who, board: BoardRef): 'none' | 'view' | 'edit' {
  if (board.kind === 'home') return homeAccess(db, user);
  const h = board.cardId ? hostCard(db, user, board.cardId) : null;
  if (!h) return 'none';
  if (board.state === 'locked' || (board.state === 'read_only' && board.creatorId !== user.id)) return 'view';
  return h.mayEdit ? 'edit' : 'view';
}

/** Whether the user may edit the host card (the card-edit rule, ignoring board state). False when the card is not visible to them. */
export function canEditHostCard(db: Db, user: Who, cardId: string): boolean {
  return !!hostCard(db, user, cardId)?.mayEdit;
}

function hostCard(db: Db, user: Who, cardId: string): { mayEdit: boolean } | null {
  const c = db.prepare('SELECT c.deck_id deckId, c.creator_id creatorId, c.visibility v, d.project_id p FROM cards c LEFT JOIN decks d ON d.id=c.deck_id WHERE c.id=?')
    .get(cardId) as { deckId: string | null; creatorId: string; v: string; p: string | null } | undefined;
  if (!c || c.v === 'deleted' || !canSeeCard(db, user, c, c.p)) return null;
  // Same rule as assertCardAccess: a deck's project decides; a deckless card is for its creator and admins.
  return { mayEdit: c.p ? can(db, user, 'content.edit', c.p) : can(db, user, 'account.manage') || (c.creatorId === user.id && isMember(db, user.id)) };
}

const isMember = (db: Db, id: string) =>
  (db.prepare('SELECT role FROM account_roles WHERE user_id=?').get(id) as { role: string } | undefined)?.role === 'member';
