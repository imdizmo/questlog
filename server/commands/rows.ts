import type { Db } from '../db';
import { toCamel } from '../db';

const one = (db: Db, sql: string, ...a: any[]) => {
  const r = db.prepare(sql).get(...a) as Record<string, unknown> | undefined;
  return r ? toCamel(r) : undefined;
};
/** The account as clients see it: the Stripe ids become hasCustomer/hasSubscription (server/billing.ts reads the ids itself); the owner's exit detail stays on the server. */
export const accountRow = (db: Db) => {
  const r = one(db, 'SELECT * FROM account');
  if (!r) return r!;
  const { stripeCustomerId, stripeSubscriptionId, disabledReason: _reason, ...acc } = r;
  return { ...acc, hasCustomer: !!stripeCustomerId, hasSubscription: !!stripeSubscriptionId };
};
/** A project as clients see it: its stored glossary (keep_names_json) is the `glossary` field. */
export const projectOut = (r: Record<string, any>) => { const { keepNames, ...p } = r; return { ...p, glossary: keepNames ?? [] }; };
export const projectRow = (db: Db, id: string) => { const r = one(db, 'SELECT * FROM projects WHERE id=?', id); return r && projectOut(r); };
export const deckRow = (db: Db, id: string) => one(db, 'SELECT * FROM decks WHERE id=?', id);
/** Derived dependency flags: deleted locking/locked cards never count. Shared by cardRow, the snapshot and the card API. */
export const CARD_SELECT = `cards.*,
  EXISTS(SELECT 1 FROM card_deps d JOIN cards l ON l.id=d.locking_card_id
         WHERE d.locked_card_id=cards.id AND l.status!='done' AND l.visibility!='deleted') AS has_blocking_deps,
  EXISTS(SELECT 1 FROM card_deps d JOIN cards k ON k.id=d.locked_card_id
         WHERE d.locking_card_id=cards.id AND k.status!='done' AND k.visibility!='deleted') AS is_blocking_dep`;
export const cardRow = (db: Db, id: string) => one(db, `SELECT ${CARD_SELECT} FROM cards WHERE id=?`, id);
export const userRow = (db: Db, id: string) =>
  one(db, 'SELECT id,email,name,timezone,disabled,kind,created_at,tailscale_login FROM users WHERE id=?', id);
export const resolvableRow = (db: Db, id: string) => one(db, 'SELECT * FROM resolvables WHERE id=?', id);
export const entryRow = (db: Db, id: string) => one(db, 'SELECT * FROM resolvable_entries WHERE id=?', id);
export const handCardRow = (db: Db, userId: string, cardId: string) =>
  one(db, 'SELECT * FROM hand_cards WHERE user_id=? AND card_id=?', userId, cardId);
export const presetRow = (db: Db, id: string) => one(db, 'SELECT * FROM card_presets WHERE id=?', id);
export const reactionRow = (db: Db, id: string) => one(db, 'SELECT * FROM resolvable_reactions WHERE id=?', id);
/** A wiki link as clients see it (props parsed); the snapshot sends the same shape. */
export const entryLinkRow = (db: Db, id: string) => one(db, 'SELECT * FROM entry_links WHERE id=?', id);
const LIVE_OTHER_END = `FROM entry_links l JOIN cards a ON a.id=l.from_card_id JOIN cards b ON b.id=l.to_card_id
    WHERE (l.from_card_id=? OR l.to_card_id=?) AND (a.id=? OR a.visibility!='deleted') AND (b.id=? OR b.visibility!='deleted')`;
/** Links touching a card whose other end is not deleted: those clients see while this card is visible. */
export const cardLinkRows = (db: Db, cardId: string) =>
  (db.prepare(`SELECT l.* ${LIVE_OTHER_END} ORDER BY l.from_card_id, l.sort_index, l.created_at, l.id`)
    .all(cardId, cardId, cardId, cardId) as Record<string, unknown>[]).map((r) => toCamel(r));
/** The same links as cardLinkRows, ids and project only (what a remove event carries). */
export const cardLinkRefs = (db: Db, cardId: string) =>
  db.prepare(`SELECT l.id, l.project_id projectId ${LIVE_OTHER_END}`).all(cardId, cardId, cardId, cardId) as { id: string; projectId: string }[];
