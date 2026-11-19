import type { Db } from './db';
import { visibleProjectIds } from './permissions';
import type { User } from '../shared/types';

/** Rows of a person's own history and comments looked at, newest first (migration 038's indexes keep both cheap). */
const HISTORY_ROWS = 500;
const COMMENT_ROWS = 200;
export const RECENT_MAX = 30;

/**
 * Home's "Recently worked on": the cards this person changed or commented on lately, newest first, one per card, only
 * cards that are not deleted and sit in projects the person can see now.
 */
export function recentOf(db: Db, user: User, max = RECENT_MAX): { cardId: string; at: number }[] {
  const visible = visibleProjectIds(db, user);
  if (!visible.size) return [];
  const rows = [
    ...(db.prepare('SELECT card_id id, at FROM card_history WHERE changer_id=? ORDER BY at DESC LIMIT ?').all(user.id, HISTORY_ROWS) as { id: string; at: number }[]),
    ...(db.prepare(`SELECT r.card_id id, e.created_at at FROM resolvable_entries e JOIN resolvables r ON r.id=e.resolvable_id
      WHERE e.author_id=? ORDER BY e.created_at DESC LIMIT ?`).all(user.id, COMMENT_ROWS) as { id: string; at: number }[]),
  ].sort((a, b) => b.at - a.at);
  const where = db.prepare(`SELECT d.project_id p FROM cards c JOIN decks d ON d.id=c.deck_id WHERE c.id=? AND c.visibility!='deleted'`);
  const out: { cardId: string; at: number }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (out.length >= max) break;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const p = where.get(r.id) as { p: string } | undefined;
    if (p && visible.has(p.p)) out.push({ cardId: r.id, at: r.at });
  }
  return out;
}
