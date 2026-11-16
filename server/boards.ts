import * as Y from 'yjs';
import type { Db } from './db';
import { can, type Who } from './permissions';
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

type BoardRef = Pick<VisionBoard, 'cardId' | 'creatorId' | 'state'>;
type BoardRow = { id: string; account_seq: number; card_id: string; creator_id: string; state: BoardState; created_at: number; updated_at: number };

export function visionBoardRow(db: Db, id: string): VisionBoard | undefined {
  const r = db.prepare('SELECT id, account_seq, card_id, creator_id, state, created_at, updated_at FROM vision_boards WHERE id=?').get(id) as BoardRow | undefined;
  return r && { id: r.id, accountSeq: r.account_seq, cardId: r.card_id, creatorId: r.creator_id, state: r.state, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function visionQueryRow(db: Db, id: string): VisionQuery | undefined {
  const r = db.prepare('SELECT * FROM vision_queries WHERE id=?').get(id) as { id: string; card_id: string; creator_id: string; query: string; created_at: number } | undefined;
  return r && { id: r.id, cardId: r.card_id, creatorId: r.creator_id, query: JSON.parse(r.query), createdAt: r.created_at };
}

/**
 * What a user may do with a board.
 * none: host card deleted or gone, or its project/deck not visible to the user. An archived host card still gives view.
 * edit: default = anyone who may edit the host card; read_only = only the board's creator (who also may edit the card); locked = nobody.
 */
export function boardAccess(db: Db, user: Who, board: BoardRef): 'none' | 'view' | 'edit' {
  const h = hostCard(db, user, board.cardId);
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
