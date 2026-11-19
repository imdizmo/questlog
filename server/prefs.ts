import type { Db } from './db';
import { AppError } from './errors';
import { MAX_PREF_BYTES, MAX_PREF_KEYS, PREF_KEY_RE } from '../shared/prefs';

/** Every preference of one person, by key, and when each was last written (ms). */
export function prefsOf(db: Db, userId: string): { prefs: Record<string, unknown>; updatedAt: Record<string, number> } {
  const prefs: Record<string, unknown> = {};
  const updatedAt: Record<string, number> = {};
  for (const r of db.prepare('SELECT key, value_json v, updated_at t FROM user_prefs WHERE user_id=?').all(userId) as { key: string; v: string; t: number }[]) {
    prefs[r.key] = JSON.parse(r.v);
    updatedAt[r.key] = r.t;
  }
  return { prefs, updatedAt };
}

/** Stores one preference (null forgets it). Refuses a bad key, a value over the cap, and a key past the per-person limit. */
export function putPref(db: Db, userId: string, key: string, value: unknown): void {
  if (!PREF_KEY_RE.test(key)) throw new AppError(400, 'invalid_input', { field: 'key' });
  if (value === null || value === undefined) {
    db.prepare('DELETE FROM user_prefs WHERE user_id=? AND key=?').run(userId, key);
    return;
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_PREF_BYTES) throw new AppError(413, 'too_large');
  const exists = db.prepare('SELECT 1 FROM user_prefs WHERE user_id=? AND key=?').get(userId, key);
  if (!exists) {
    const n = (db.prepare('SELECT COUNT(*) c FROM user_prefs WHERE user_id=?').get(userId) as { c: number }).c;
    if (n >= MAX_PREF_KEYS) throw new AppError(409, 'too_many');
  }
  db.prepare(`INSERT INTO user_prefs (user_id, key, value_json, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id, key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`).run(userId, key, json, Date.now());
}
