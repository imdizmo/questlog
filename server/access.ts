import type { Db } from './db';
import { AppError } from './errors';
import { can, projectConfined, type Who } from './permissions';
import { mentionHandle } from '../shared/content';

/** Project of a card via its deck, or null when the card has no deck (or the deck is gone). */
export function cardProjectId(db: Db, cardId: string): string | null {
  const r = db.prepare('SELECT d.project_id p FROM cards c JOIN decks d ON d.id=c.deck_id WHERE c.id=?').get(cardId) as
    | { p: string } | undefined;
  return r?.p ?? null;
}

/** A card with a deck follows its project; a deckless card is for its creator and admins only (never a project-confined token). */
export function canSeeCard(db: Db, user: Who, card: { deckId: string | null; creatorId: string }, projectId: string | null): boolean {
  if (card.deckId && projectId) return can(db, user, 'project.view', projectId);
  if (card.deckId) return false;
  if (projectConfined(user)) return false;
  return card.creatorId === user.id ? roleKnown(db, user.id) : can(db, user, 'account.manage');
}

/**
 * For writes that touch only the actor's own rows by card id without loading the card (removing a watch, a bookmark,
 * a Hand slot, stopping a timer): a project-confined token must still be able to see the card. Sessions pass.
 */
export function assertCardInTokenScope(db: Db, actor: Who, cardId: string): void {
  if (!projectConfined(actor)) return;
  const c = db.prepare('SELECT deck_id deckId, creator_id creatorId FROM cards WHERE id=?').get(cardId) as { deckId: string | null; creatorId: string } | undefined;
  if (!c || !canSeeCard(db, actor, c, c.deckId ? cardProjectId(db, cardId) : null)) throw new AppError(404, 'not_found');
}

const roleKnown = (db: Db, id: string) =>
  !!db.prepare("SELECT 1 FROM users u JOIN account_roles r ON r.user_id=u.id WHERE u.id=? AND u.disabled=0 AND r.role != 'guest'").get(id);

/** @handle -> user id for every active user; the single rule behind card-content and thread mentions. */
export function handleMap(db: Db): Map<string, string> {
  const m = new Map<string, string>();
  // Guests (Open Decks visitors) can't be mentioned.
  for (const u of db.prepare("SELECT id, name FROM users WHERE disabled=0 AND id NOT IN (SELECT user_id FROM account_roles WHERE role='guest')").all() as { id: string; name: string }[]) {
    m.set(mentionHandle(u.name), u.id);
  }
  return m;
}
