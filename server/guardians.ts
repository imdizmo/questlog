import type { Db } from './db';
import { AppError } from './errors';
import { can } from './permissions';

/** Guardians of a deck who are enabled and can still view its project; empty when the rule is off. */
export function activeGuardians(db: Db, deckId: string | null): string[] {
  if (!deckId) return [];
  const d = db.prepare('SELECT project_id p, guardians_enabled g FROM decks WHERE id=?').get(deckId) as { p: string; g: number } | undefined;
  if (!d || !d.g) return [];
  const rows = db.prepare('SELECT g.user_id u FROM deck_guardians g JOIN users x ON x.id=g.user_id WHERE g.deck_id=? AND x.disabled=0').all(deckId) as { u: string }[];
  return rows.map((r) => r.u).filter((u) => can(db, { id: u }, 'project.view', d.p));
}

export type GuardedAction = 'done' | 'archive' | 'delete' | 'moveOut';

/** 403 guardian_only unless the deck has no active guardians or the actor is one of them. */
export function assertGuardianAllows(db: Db, actor: { id: string }, card: { id: string; deckId: string | null }, _action: GuardedAction): void {
  const g = activeGuardians(db, card.deckId);
  if (g.length && !g.includes(actor.id)) throw new AppError(403, 'guardian_only', { id: card.id });
}
