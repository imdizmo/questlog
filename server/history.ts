import type { Db } from './db';
import type { HistoryChange } from '../shared/types';

/** Changer id of scheduled jobs (stale snooze, auto-archive). Shown as "System". */
export const SYSTEM_ID = 'system';

/**
 * One card_history row per command; bumps cards.version and last_updated_at.
 * Central place for "any user write clears the stale snooze": every non-system write that reaches here
 * clears snoozed_at (adding an 'unsnoozed' row unless the write was itself a status change). `keepSnooze`: a write that
 * is no sign of activity on the card (a link turned off in its text) leaves the snooze alone.
 */
export function recordHistory(db: Db, cardId: string, changerId: string, changes: HistoryChange[], opts: { keepSnooze?: boolean } = {}): number {
  if (changes.length > 0 && changerId !== SYSTEM_ID && !opts.keepSnooze) {
    const r = db.prepare('UPDATE cards SET snoozed_at=NULL WHERE id=? AND snoozed_at IS NOT NULL').run(cardId);
    if (r.changes && !changes.some((c) => c.kind === 'status')) changes = [...changes, { kind: 'unsnoozed' }];
  }
  if (changes.length === 0) return (db.prepare('SELECT version v FROM cards WHERE id=?').get(cardId) as { v: number }).v;
  const now = Date.now();
  db.prepare('UPDATE cards SET version = version + 1, last_updated_at = ? WHERE id = ?').run(now, cardId);
  const { v } = db.prepare('SELECT version v FROM cards WHERE id=?').get(cardId) as { v: number };
  // Stamp the card's deck/project/milestone/run as of now (after a move: the new values), so the activity feed can scope by them.
  const where = db.prepare('SELECT c.deck_id d, d.project_id p, c.milestone_id m, c.sprint_id s FROM cards c LEFT JOIN decks d ON d.id=c.deck_id WHERE c.id=?').get(cardId) as
    { d: string | null; p: string | null; m: string | null; s: string | null };
  db.prepare('INSERT INTO card_history (card_id, version, changer_id, at, changes_json, deck_id, project_id, milestone_id, sprint_id) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(cardId, v, changerId, now, JSON.stringify(changes), where.d, where.p, where.m, where.s);
  return v;
}

type Move = { from: string | null; to: string | null };
/** The one 'entry' change of a wiki write: the changed field keys, plus the type, key and wiki parent moves that happened. */
export function entryChange(fields: string[], moves: { type?: Move; key?: Move; parent?: Move } = {}): HistoryChange[] {
  const c: HistoryChange = { kind: 'entry', fields };
  for (const m of ['type', 'key', 'parent'] as const) {
    const v = moves[m];
    if (v && v.from !== v.to) c[m] = v;
  }
  return fields.length || c.type || c.key || c.parent ? [c] : [];
}
