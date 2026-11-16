import { z } from 'zod';
import { toCamel } from '../db';
import { AppError } from '../errors';
import { assertCan, projectConfined } from '../permissions';
import { assertCardInTokenScope, canSeeCard, cardProjectId } from '../access';
import { DEFAULT_SETTINGS } from '../../shared/types';
import { accountRow, cardRow, handCardRow } from './rows';
import { stopCardTimers } from './timers';
import type { Command, Ctx } from '../dispatch';

const DAY_MS = 86_400_000;
export const DONE_PILE_DAYS = 14;

export const handIds = (ctx: Ctx, userId: string): string[] =>
  (ctx.db.prepare('SELECT card_id c FROM hand_cards WHERE user_id=? ORDER BY sort_index, rowid').all(userId) as { c: string }[]).map((r) => r.c);

/** Hand entries whose card is in the trash don't count and are never shown (they stay, so a restore brings the slot back). */
const isTrashed = (ctx: Ctx, cardId: string): boolean =>
  (ctx.db.prepare('SELECT visibility v FROM cards WHERE id=?').get(cardId) as { v: string } | undefined)?.v === 'deleted';
export const liveHandIds = (ctx: Ctx, userId: string): string[] => handIds(ctx, userId).filter((c) => !isTrashed(ctx, c));

export const maxHandSlots = (ctx: Ctx): number =>
  ({ ...DEFAULT_SETTINGS, ...(accountRow(ctx.db).settings as object) } as typeof DEFAULT_SETTINGS).maxHandSlots;

/** Replace the user's Hand with exactly `ids` in order (dense sortIndex 1..n), emitting only what changed. */
export function writeHand(ctx: Ctx, userId: string, ids: string[]): void {
  const { db } = ctx;
  const old = new Map((db.prepare('SELECT card_id c, sort_index s FROM hand_cards WHERE user_id=?').all(userId) as { c: string; s: number }[]).map((r) => [r.c, r.s]));
  const keep = new Set<string>(ids);
  for (const c of old.keys()) {
    if (keep.has(c)) continue;
    db.prepare('DELETE FROM hand_cards WHERE user_id=? AND card_id=?').run(userId, c);
    ctx.emit('handCard', 'remove', { userId, cardId: c });
  }
  ids.forEach((c, i) => {
    if (old.get(c) === i + 1) return;
    db.prepare('INSERT INTO hand_cards (user_id, card_id, sort_index) VALUES (?,?,?) ON CONFLICT(user_id, card_id) DO UPDATE SET sort_index=excluded.sort_index')
      .run(userId, c, i + 1);
    ctx.emit('handCard', 'upsert', handCardRow(db, userId, c)!);
  });
}

/** Put the card at the user's hand slot 1, shifting the user's other cards +1. */
export function insertHand(ctx: Ctx, userId: string, cardId: string): void {
  // A full Hand skips the card (same rule as Hand Sync); the caller's action still succeeds.
  if (!handIds(ctx, userId).includes(cardId) && liveHandIds(ctx, userId).length >= maxHandSlots(ctx)) return;
  writeHand(ctx, userId, [cardId, ...handIds(ctx, userId).filter((c) => c !== cardId)]);
}

/** A card in a Hand-Sync deck that this user owns cannot be taken out of their Hand by hand. */
const isSynced = (ctx: Ctx, userId: string, cardId: string): boolean =>
  !!ctx.db.prepare(
    `SELECT 1 FROM cards c JOIN decks d ON d.id=c.deck_id WHERE c.id=? AND c.assignee_id=? AND d.hand_sync_enabled=1`).get(cardId, userId);

/** Hand Sync: a card that just got an owner in a synced deck goes to the end of the owner's Hand. A full Hand skips it. */
export function handSyncOwner(ctx: Ctx, cardId: string): void {
  const row = ctx.db.prepare(
    `SELECT c.assignee_id a, c.status s, c.visibility v FROM cards c JOIN decks d ON d.id=c.deck_id WHERE c.id=? AND d.hand_sync_enabled=1`)
    .get(cardId) as { a: string | null; s: string; v: string } | undefined;
  if (!row?.a || row.s === 'done' || row.v !== 'default') return;
  const ids = handIds(ctx, row.a);
  if (ids.includes(cardId) || liveHandIds(ctx, row.a).length >= maxHandSlots(ctx)) return;
  writeHand(ctx, row.a, [...ids, cardId]);
}

/** The card became done: it leaves every Hand it was in and lands in those users' done pile. */
export function cardDone(ctx: Ctx, cardId: string): void {
  const { db } = ctx;
  db.prepare('UPDATE cards SET done_at=? WHERE id=?').run(Date.now(), cardId);
  stopCardTimers(ctx, cardId);
  const users = (db.prepare('SELECT user_id u FROM hand_cards WHERE card_id=?').all(cardId) as { u: string }[]).map((r) => r.u);
  for (const u of users) {
    db.prepare('INSERT OR REPLACE INTO done_pile (user_id, card_id, done_at) VALUES (?,?,?)').run(u, cardId, Date.now());
    ctx.emit('donePile', 'upsert', toCamel(db.prepare('SELECT * FROM done_pile WHERE user_id=? AND card_id=?').get(u, cardId) as any));
    writeHand(ctx, u, handIds(ctx, u).filter((c) => c !== cardId));
  }
}

/** The card left done: its done-pile rows go away. */
export function cardReopened(ctx: Ctx, cardId: string): void {
  ctx.db.prepare('UPDATE cards SET done_at=NULL WHERE id=?').run(cardId);
  const rows = ctx.db.prepare('SELECT user_id u FROM done_pile WHERE card_id=?').all(cardId) as { u: string }[];
  ctx.db.prepare('DELETE FROM done_pile WHERE card_id=?').run(cardId);
  for (const r of rows) ctx.emit('donePile', 'remove', { userId: r.u, cardId });
}

/** Done-pile rows still shown: finished within the last 14 days. */
export const donePileCutoff = (): number => Date.now() - DONE_PILE_DAYS * DAY_MS;

/** The actor may act for `userId` on these cards: themself, or (Team Hands) with edit rights on each card's project. */
function assertHandAccess(ctx: Ctx, userId: string, cardIds: string[]): void {
  const { db, actor } = ctx;
  if (userId === actor.id) {
    for (const id of cardIds) assertCardInTokenScope(db, actor, id);
    return;
  }
  const u = db.prepare('SELECT disabled d FROM users WHERE id=?').get(userId) as { d: number } | undefined;
  if (!u || u.d) throw new AppError(400, 'invalid_user', { userId });
  // Every card is checked on its own: a project card needs content.edit there, a deckless card its creator or an admin.
  for (const id of cardIds) {
    const c = cardRow(db, id);
    if (!c) throw new AppError(404, 'not_found');
    const p = c.deckId ? cardProjectId(db, id) : null;
    if (p) assertCan(db, actor, 'content.edit', p);
    else if (projectConfined(actor)) throw new AppError(403, 'forbidden');
    else if (c.creatorId !== actor.id) assertCan(db, actor, 'account.manage');
  }
}

const ids = z.array(z.string()).min(1).max(200);

export const handCommands: Record<string, Command> = {
  'handQueue/addCards': {
    schema: z.object({ cardIds: ids, userId: z.string(), slot: z.number().int().min(1).optional() }),
    run(ctx, input) {
      const { db, actor } = ctx;
      const add = [...new Set<string>(input.cardIds)];
      for (const id of add) {
        const c = cardRow(db, id);
        const pid = c?.deckId ? cardProjectId(db, id) : null;
        if (!c || c.visibility === 'deleted' || !canSeeCard(db, actor, c as any, pid) || !canSeeCard(db, { id: input.userId }, c as any, pid)) throw new AppError(404, 'not_found');
      }
      assertHandAccess(ctx, input.userId, add);
      const rest = handIds(ctx, input.userId).filter((c) => !add.includes(c));
      if (rest.filter((c) => !isTrashed(ctx, c)).length + add.length > maxHandSlots(ctx)) throw new AppError(409, 'hand_full');
      const at = Math.min(Math.max((input.slot ?? rest.length + 1) - 1, 0), rest.length);
      writeHand(ctx, input.userId, [...rest.slice(0, at), ...add, ...rest.slice(at)]);
    },
  },
  'handQueue/removeCards': {
    schema: z.object({ cardIds: ids, userId: z.string() }),
    run(ctx, input) {
      const gone = [...new Set<string>(input.cardIds)];
      assertHandAccess(ctx, input.userId, gone);
      for (const id of gone) if (isSynced(ctx, input.userId, id)) throw new AppError(409, 'hand_synced', { id });
      writeHand(ctx, input.userId, handIds(ctx, input.userId).filter((c) => !gone.includes(c)));
    },
  },
  'handQueue/reorder': {
    schema: z.object({ userId: z.string(), cardIds: z.array(z.string()).max(200) }),
    run(ctx, input) {
      const { db, actor } = ctx;
      const cur = handIds(ctx, input.userId);
      // The client only knows the cards the actor can see, so only those are compared and reordered.
      const seen = (c: string) => {
        const r = cardRow(db, c);
        return !!r && r.visibility !== 'deleted' && canSeeCard(db, actor, r as any, r.deckId ? cardProjectId(db, c) : null);
      };
      const visible = cur.filter(seen);
      const want = input.cardIds;
      if (want.length !== visible.length || new Set(want).size !== want.length || !want.every((c: string) => visible.includes(c))) throw new AppError(409, 'stale_hand');
      assertHandAccess(ctx, input.userId, want);
      // Hidden cards keep their slots; the visible slots are refilled in the new order.
      const queue = [...want];
      const next = cur.map((c) => (visible.includes(c) ? queue.shift()! : c));
      writeHand(ctx, input.userId, next);
    },
  },
};

const cardIdList = z.array(z.string()).min(1).max(200);
const own = (ctx: Ctx, userId: string) => { if (userId !== ctx.actor.id) throw new AppError(403, 'forbidden'); };

export const bookmarkCommands: Record<string, Command> = {
  'bookmarks/addCards': {
    schema: z.object({ userId: z.string(), ids: cardIdList }),
    run(ctx, { userId, ids }) {
      own(ctx, userId);
      const { db } = ctx;
      const list = [...new Set<string>(ids)];
      for (const id of list) {
        const c = cardRow(db, id);
        if (!c || c.visibility === 'deleted' || !canSeeCard(db, ctx.actor, c as any, c.deckId ? cardProjectId(db, id) : null)) throw new AppError(404, 'not_found');
      }
      for (const id of list) {
        const r = db.prepare('INSERT OR IGNORE INTO bookmarks (user_id, card_id, created_at) VALUES (?,?,?)').run(userId, id, Date.now());
        if (r.changes) ctx.emit('bookmark', 'upsert', toCamel(db.prepare('SELECT * FROM bookmarks WHERE user_id=? AND card_id=?').get(userId, id) as any));
      }
    },
  },
  'bookmarks/removeCards': {
    schema: z.object({ userId: z.string(), ids: cardIdList }),
    run(ctx, { userId, ids }) {
      own(ctx, userId);
      for (const id of new Set<string>(ids)) assertCardInTokenScope(ctx.db, ctx.actor, id);
      for (const id of new Set<string>(ids)) {
        const r = ctx.db.prepare('DELETE FROM bookmarks WHERE user_id=? AND card_id=?').run(userId, id);
        if (r.changes) ctx.emit('bookmark', 'remove', { userId, cardId: id });
      }
    },
  },
};
