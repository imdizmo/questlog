import { readFileSync, closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { newId, tx, type Db } from './db';
import { assertFeature, assertSeatFor } from './billing';

/**
 * The shared team file (Jatify rule, TEAM-SERVER.md): who is on this Questlog team, so other Jatify tools can ask.
 * Enabled people with a Tailscale login only, sorted by login. Written to a temp file in the same folder and renamed,
 * so a reader never sees half a file.
 */
export function writeTeamFile(db: Db, path: string): void {
  const members = (db.prepare(
    `SELECT u.tailscale_login AS login, u.name AS name, r.role AS role FROM users u JOIN account_roles r ON r.user_id=u.id
     WHERE u.disabled=0 AND u.tailscale_login IS NOT NULL AND u.kind='person'`,
  ).all() as { login: string; name: string; role: string }[])
    // Plain string order of the login, so every reader sees the same well-defined order.
    .sort((a, b) => (a.login < b.login ? -1 : a.login > b.login ? 1 : 0));
  const text = JSON.stringify({ version: 1, writer: 'questlog', updated: new Date().toISOString(), members }, null, 2) + '\n';
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    const fd = openSync(tmp, 'w', 0o644);
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
}

/** Writes the file named by JT_TEAM_FILE, when set. A failure is logged and never reaches the caller. */
export function syncTeamFile(db: Db): void {
  const path = process.env.JT_TEAM_FILE;
  if (!path) return;
  try { writeTeamFile(db, path); } catch (e) { console.error('[jt] team file not written', String((e as Error)?.message ?? e)); }
}

/**
 * Creates a person who signs in by Tailscale only: email = login, a hash no password verifies, `tailscale_login`, role.
 * Checks the observer feature and the seat limit first (AppError 409 when refused). Returns the new user id.
 */
export function createTailscalePerson(db: Db, login: string, name: string, role: 'admin' | 'member' | 'observer'): string {
  if (role === 'observer') assertFeature(db, 'observerRole');
  assertSeatFor(db, role);
  const id = newId();
  // Not a scrypt hash, so no password ever verifies: this person signs in by Tailscale only.
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at,tailscale_login) VALUES (?,?,?,?,?,?)')
    .run(id, login, name || login, '!', Date.now(), login);
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return id;
}

/**
 * Takes in a team file that already exists (hand-written or from another tool), so the first write keeps its people.
 * Missing file: nothing. Invalid file (bad JSON, version not 1, members not an array): logged once, nothing changes.
 * Per member, in file order: already linked (any state) -> skip; role owner and the workspace owner is unlinked ->
 * link the owner; an unlinked person whose email equals the login -> link them; else create a person (owner becomes
 * admin; a refused seat or feature is logged and skipped). One transaction; a second run changes nothing.
 */
export function importTeamFile(db: Db, path: string): boolean {
  const refuse = (why: string): false => {
    console.error(`[jt] team file ${path} is not usable (${why}); Questlog will not touch it until it is valid or removed`);
    return false;
  };
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return true;
    return refuse(String((e as Error)?.message ?? e));
  }
  let data: any;
  try { data = JSON.parse(text); } catch { return refuse('not valid JSON'); }
  if (!data || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.members)) return refuse('expected version 1 and a members list');
  // A person now on the team no longer waits in the join requests.
  const dropRequest = (login: string) => db.prepare('DELETE FROM access_requests WHERE login=?').run(login);
  tx(db, () => {
    for (const m of data.members) {
      const login = m?.login;
      if (typeof login !== 'string' || !login) continue;
      const name = typeof m.name === 'string' ? m.name : '';
      if (db.prepare('SELECT 1 FROM users WHERE tailscale_login=?').get(login)) continue;
      if (m.role === 'owner') {
        const owner = db.prepare(`SELECT u.id FROM users u JOIN account_roles r ON r.user_id=u.id
          WHERE r.role='owner' AND u.tailscale_login IS NULL`).get() as { id: string } | undefined;
        if (owner) { db.prepare('UPDATE users SET tailscale_login=? WHERE id=?').run(login, owner.id); dropRequest(login); continue; }
      }
      const same = db.prepare(`SELECT u.id, u.kind, u.tailscale_login, r.role FROM users u LEFT JOIN account_roles r ON r.user_id=u.id
        WHERE u.email=? COLLATE NOCASE`).get(login) as { id: string; kind: string; tailscale_login: string | null; role: string | null } | undefined;
      if (same) {
        // Open Decks guests and service users are never linked: they are not people of the workspace.
        if (same.kind === 'person' && same.role !== 'guest' && same.tailscale_login === null) {
          db.prepare('UPDATE users SET tailscale_login=? WHERE id=?').run(login, same.id);
          dropRequest(login);
        } else console.error(`[jt] team file: ${login} not added (email already in use)`);
        continue;
      }
      const role: 'admin' | 'member' | 'observer' =
        m.role === 'admin' || m.role === 'observer' ? m.role : m.role === 'owner' ? 'admin' : 'member';
      try { createTailscalePerson(db, login, name, role); dropRequest(login); } catch (e) {
        console.error(`[jt] team file: ${login} not added`, String((e as Error)?.message ?? e));
      }
    }
  });
  return true;
}

/**
 * At start: takes in an existing JT_TEAM_FILE, then writes it. An existing file that is unusable is left exactly as it
 * is (logged once); later writes, after a team change, go ahead. Never throws.
 */
export function startTeamFile(db: Db): void {
  const path = process.env.JT_TEAM_FILE;
  if (path) {
    try { if (!importTeamFile(db, path)) return; } catch (e) {
      console.error('[jt] team file not imported', String((e as Error)?.message ?? e));
      return;
    }
  }
  syncTeamFile(db);
}
