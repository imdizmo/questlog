import { z } from 'zod';
import { AppError } from '../errors';
import { assertCan, can } from '../permissions';
import { assertCardInTokenScope, canSeeCard, cardProjectId } from '../access';
import { cardRow, deckRow } from './rows';
import { addCardWatch } from './cards';
import type { Command, Ctx } from '../dispatch';

function visibleCard(ctx: Ctx, cardId: string) {
  const c = cardRow(ctx.db, cardId);
  if (!c || c.visibility === 'deleted' || !canSeeCard(ctx.db, ctx.actor, c as any, c.deckId ? cardProjectId(ctx.db, cardId) : null)) throw new AppError(404, 'not_found');
  return c;
}

/** Deck and target checks shared by addDeck / removeDeck. Acting for someone else needs project.manage. */
function deckTarget(ctx: Ctx, deckId: string, userId: string, mustView: boolean) {
  const { db, actor } = ctx;
  const d = deckRow(db, deckId);
  if (!d || !can(db, actor, 'project.view', d.projectId as string)) throw new AppError(404, 'not_found');
  if (userId !== actor.id) assertCan(db, actor, 'project.manage', d.projectId as string);
  if (mustView) {
    const u = db.prepare('SELECT disabled d FROM users WHERE id=?').get(userId) as { d: number } | undefined;
    if (!u || u.d || !can(db, { id: userId }, 'project.view', d.projectId as string)) throw new AppError(400, 'invalid_user', { userId });
  }
}

const cardInput = z.object({ cardId: z.string() });
const deckInput = z.object({ deckId: z.string(), userId: z.string() });

export const watchingCommands: Record<string, Command> = {
  'watchings/addCard': {
    schema: cardInput,
    run(ctx, { cardId }) {
      visibleCard(ctx, cardId);
      return { id: addCardWatch(ctx, ctx.actor.id, cardId) };
    },
  },
  'watchings/removeCard': {
    schema: cardInput,
    run(ctx, { cardId }) {
      // No card lookup for sessions: removing must work even after access to the card is gone. A confined token must see it.
      assertCardInTokenScope(ctx.db, ctx.actor, cardId);
      const r = ctx.db.prepare('DELETE FROM card_subscriptions WHERE user_id=? AND card_id=?').run(ctx.actor.id, cardId);
      if (r.changes) ctx.emit('cardSubscription', 'remove', { userId: ctx.actor.id, cardId });
    },
  },
  'watchings/addDeck': {
    schema: deckInput,
    run(ctx, { deckId, userId }) {
      deckTarget(ctx, deckId, userId, true);
      const r = ctx.db.prepare('INSERT OR IGNORE INTO deck_subscriptions (user_id, deck_id, created_at) VALUES (?,?,?)').run(userId, deckId, Date.now());
      if (r.changes) ctx.emit('deckSubscription', 'upsert', { userId, deckId, createdAt: Date.now() });
      return { id: `${userId}|${deckId}` };
    },
  },
  'watchings/removeDeck': {
    schema: deckInput,
    run(ctx, { deckId, userId }) {
      deckTarget(ctx, deckId, userId, false);
      const r = ctx.db.prepare('DELETE FROM deck_subscriptions WHERE user_id=? AND deck_id=?').run(userId, deckId);
      if (r.changes) ctx.emit('deckSubscription', 'remove', { userId, deckId });
    },
  },
};
