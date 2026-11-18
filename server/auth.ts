import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { type Db, tx, newId, toCamel } from './db';
import { AppError } from './errors';
import { DEFAULT_SETTINGS, type OrgRole, type User } from '../shared/types';
import { assertFeature, assertSeatFor } from './billing';

// ---- clock (injectable for tests) ----
let clock: () => number = () => Date.now();
export function setClock(fn: () => number): void {
  clock = fn;
}
export const now = (): number => clock();

export const SESSION_MS = 30 * 24 * 3600 * 1000;
const DEVICE_MS = 365 * 24 * 3600 * 1000;
const MAX_DEVICES = 20;
export const INVITE_MS = 7 * 24 * 3600 * 1000;

// ---- passwords ----
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64, { N: 16384 });
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, s, h] = stored.split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'base64url');
  const got = scryptSync(pw, Buffer.from(s, 'base64url'), want.length, { N: 16384 });
  return got.length === want.length && timingSafeEqual(got, want);
}

const DUMMY_HASH = hashPassword('dummy-password-for-timing');

// ---- tokens ----
const newToken = () => randomBytes(32).toString('base64url');
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

// ---- login limiters: 10 failures / 5 min, per IP and per email, each capped at 1000 keys ----
const MAX_FAILS = 10;
const WINDOW_MS = 5 * 60 * 1000;
const LIMITER_CAP = 1000;

class FailLimiter {
  map = new Map<string, { count: number; start: number }>();
  /** Shared bucket for failures that could not be recorded because the map is saturated with live lockouts. Never evicted. */
  overflow: { count: number; start: number } | null = null;

  private expired(e: { start: number }) {
    return clock() - e.start >= WINDOW_MS;
  }
  private locked(e: { count: number; start: number } | null | undefined) {
    return !!e && !this.expired(e) && e.count >= MAX_FAILS;
  }
  private saturated() {
    if (this.map.size < LIMITER_CAP) return false;
    for (const v of this.map.values()) if (!this.locked(v)) return false;
    return true;
  }

  /** Read-only: throws 429 if the key is locked, or (unless skipOverflow) if the key is unknown while the map is saturated and the overflow bucket is locked. */
  check(key: string, skipOverflow = false): void {
    const e = this.map.get(key);
    if (this.locked(e)) throw new AppError(429, 'too_many_attempts');
    if (!skipOverflow && (!e || this.expired(e)) && this.locked(this.overflow) && this.saturated()) {
      throw new AppError(429, 'too_many_attempts');
    }
  }

  fail(key: string, skipOverflow = false): void {
    const e = this.map.get(key);
    if (e && !this.expired(e)) {
      e.count++;
      return;
    }
    this.map.delete(key);
    if (this.map.size >= LIMITER_CAP) {
      for (const [k, v] of this.map) if (this.expired(v)) this.map.delete(k);
    }
    if (this.map.size >= LIMITER_CAP) {
      // evict the lowest-count unlocked entry (oldest among ties)
      let victim: string | null = null;
      let best = MAX_FAILS;
      for (const [k, v] of this.map) {
        if (v.count < best) {
          best = v.count;
          victim = k;
        }
      }
      if (victim === null) {
        // saturated with live lockouts: count the failure in the shared overflow bucket
        if (!skipOverflow) {
          if (this.overflow && !this.expired(this.overflow)) this.overflow.count++;
          else this.overflow = { count: 1, start: clock() };
        }
        return;
      }
      this.map.delete(victim);
    }
    this.map.set(key, { count: 1, start: clock() });
  }
}

const ipLimiter = new FailLimiter();
const pairLimiter = new FailLimiter();
/** Per-account failures, keyed by user id. Bounded by the user count, so no cap, eviction or overflow bucket. */
const accountFails = new Map<string, { count: number; start: number }>();
function accountLocked(id: string): boolean {
  const e = accountFails.get(id);
  if (!e) return false;
  if (clock() - e.start >= WINDOW_MS) {
    accountFails.delete(id);
    return false;
  }
  return e.count >= MAX_FAILS;
}
function accountFail(id: string): void {
  const e = accountFails.get(id);
  if (e && clock() - e.start < WINDOW_MS) e.count++;
  else accountFails.set(id, { count: 1, start: clock() });
}

export const _limiterSize = () => ipLimiter.map.size;
export const _limiterHas = (ip: string) => ipLimiter.map.has(ip);
export const _resetLimiter = () => {
  ipLimiter.map.clear();
  pairLimiter.map.clear();
  accountFails.clear();
  for (const l of [ipLimiter, pairLimiter]) l.overflow = null;
};
export const _noteFailure = (ip: string) => ipLimiter.fail(ip);

// ---- helpers ----
export function publicUser(row: Record<string, unknown>): User {
  const { passwordHash: _p, ...u } = toCamel<User & { passwordHash: string }>(row);
  return u;
}

const roleOf = (db: Db, userId: string): OrgRole | null =>
  ((db.prepare('SELECT role FROM account_roles WHERE user_id=?').get(userId) as { role: OrgRole } | undefined)?.role) ?? null;

function insertUser(db: Db, role: OrgRole, f: { name: string; email: string; password: string }): User {
  if (!f.email || !f.password || !f.name) throw new AppError(400, 'invalid_input');
  const id = newId();
  try {
    db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,?)')
      .run(id, f.email.trim(), f.name.trim(), hashPassword(f.password), clock());
  } catch (e) {
    if (/UNIQUE/.test(String(e))) throw new AppError(409, 'email_taken');
    throw e;
  }
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id) as Record<string, unknown>);
}

// ---- workspace / sessions ----
export function setupWorkspace(
  db: Db,
  f: { workspaceName: string; name: string; email: string; password: string },
  /** A proven Tailscale login for the owner (server/app.ts decides when a login counts as proven), or null. */
  tailscaleLogin: string | null = null,
): User {
  return tx(db, () => {
    const n = (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
    if (n > 0) throw new AppError(409, 'already_setup');
    db.prepare('INSERT INTO account (id,name,settings_json,created_at) VALUES (?,?,?,?)')
      // A new workspace starts simple: sprints are a switch under Workspace settings. Dependencies are on, the vision board draws them.
      .run(newId(), f.workspaceName, JSON.stringify({ ...DEFAULT_SETTINGS, sprintsEnabled: false, dependenciesEnabled: true }), clock());
    const owner = insertUser(db, 'owner', f);
    if (!tailscaleLogin) return owner;
    db.prepare('UPDATE users SET tailscale_login=? WHERE id=?').run(tailscaleLogin, owner.id);
    // The owner is on the team now, so a join request they left before setup goes.
    db.prepare('DELETE FROM access_requests WHERE login=?').run(tailscaleLogin);
    return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(owner.id) as Record<string, unknown>);
  });
}

/**
 * The password check of a login, with its limiters (per IP, per email+IP, per account; a known device skips them):
 * 429 while locked out, 401 bad_credentials on a wrong password, an unknown, disabled or service user. Returns whether
 * the device is known.
 */
function checkPassword(db: Db, row: Record<string, unknown> | undefined, email: string, pw: string, ip: string, deviceToken?: string): boolean {
  const emailKey = email.trim().toLowerCase();
  const pairKey = `${emailKey}|${ip}`;
  const known =
    !!row &&
    !!deviceToken &&
    !!db.prepare('SELECT 1 FROM known_devices WHERE token_hash=? AND user_id=? AND created_at > ?').get(sha(deviceToken), row.id as string, clock() - DEVICE_MS);
  ipLimiter.check(ip, known);
  pairLimiter.check(pairKey, known);
  if (row && !known && accountLocked(row.id as string)) throw new AppError(429, 'too_many_attempts');
  const ok = verifyPassword(pw, row ? (row.password_hash as string) : DUMMY_HASH);
  // Service users (org API tokens) never log in; their password hash can't verify anyway.
  if (!row || !ok || row.disabled || row.kind === 'service') {
    ipLimiter.fail(ip, known);
    pairLimiter.fail(pairKey, known);
    if (row && !known) accountFail(row.id as string);
    throw new AppError(401, 'bad_credentials');
  }
  return known;
}

/**
 * Asks a signed-in user for their password again (before a lasting change), under the limits of a login. A known
 * device does not skip them here: the session is already on that device, so the device proves nothing more.
 */
export function confirmPassword(db: Db, userId: string, pw: string, ip: string): void {
  const row = db.prepare('SELECT * FROM users WHERE id=?').get(userId) as Record<string, unknown> | undefined;
  checkPassword(db, row, String(row?.email ?? ''), pw, ip);
}

export function login(
  db: Db,
  email: string,
  pw: string,
  ip: string,
  deviceToken?: string,
  /** Runs once the password checked out, before any session exists; throws to refuse (a disabled workspace: 423). */
  mayLogIn?: (userId: string) => void,
): { token: string; user: User; deviceToken: string } {
  const row = db.prepare('SELECT * FROM users WHERE email=?').get(email.trim()) as Record<string, unknown> | undefined;
  const known = checkPassword(db, row, email, pw, ip, deviceToken);
  if (!row) throw new AppError(401, 'bad_credentials'); // checkPassword already refused it
  mayLogIn?.(row.id as string);
  const token = newToken();
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)')
    .run(sha(token), row.id as string, clock() + SESSION_MS);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(clock());
  let device = deviceToken as string;
  if (!known) {
    device = newToken();
    db.prepare('INSERT INTO known_devices (token_hash,user_id,created_at) VALUES (?,?,?)')
      .run(sha(device), row.id as string, clock());
    db.prepare(
      `DELETE FROM known_devices WHERE user_id=? AND token_hash NOT IN
       (SELECT token_hash FROM known_devices WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    ).run(row.id as string, row.id as string, MAX_DEVICES);
  }
  return { token, user: publicUser(row), deviceToken: device };
}

/** A session made without a password (`via` says how). Returns its token; the caller has checked the user may sign in. */
export function createSession(db: Db, userId: string, via: 'tailscale'): string {
  const token = newToken();
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,via) VALUES (?,?,?,?)').run(sha(token), userId, clock() + SESSION_MS, via);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(clock());
  return token;
}

/** How the session of `token` was made: 'tailscale', or null for a password session (or none). */
export function sessionVia(db: Db, token: string): 'tailscale' | null {
  if (!token) return null;
  const r = db.prepare('SELECT via FROM sessions WHERE token_hash=?').get(sha(token)) as { via: string | null } | undefined;
  return r?.via === 'tailscale' ? 'tailscale' : null;
}

export function revokeDevices(db: Db, userId: string): void {
  db.prepare('DELETE FROM known_devices WHERE user_id=?').run(userId);
}

export function sessionUser(db: Db, token: string): User | null {
  if (!token) return null;
  const row = db
    .prepare('SELECT u.*, s.expires_at AS s_exp FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?')
    .get(sha(token)) as Record<string, unknown> | undefined;
  if (!row || row.disabled || (row.s_exp as number) <= clock()) return null;
  delete row.s_exp;
  return publicUser(row);
}

export function logout(db: Db, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
}

// ---- invites ----
export function createInvite(
  db: Db,
  actor: User,
  f: { role: 'admin' | 'member' | 'observer'; projectIds: string[] },
): string {
  const r = roleOf(db, actor.id);
  if (r !== 'owner' && r !== 'admin') throw new AppError(403, 'forbidden');
  if (!['admin', 'member', 'observer'].includes(f.role)) throw new AppError(400, 'invalid_role');
  if (!Array.isArray(f.projectIds) || f.projectIds.some((id) => typeof id !== 'string')) {
    throw new AppError(400, 'invalid_payload');
  }
  for (const id of f.projectIds) {
    if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(id)) throw new AppError(400, 'invalid_payload');
  }
  const token = newToken();
  db.prepare('INSERT INTO invites (token_hash,role,project_ids_json,created_by,expires_at) VALUES (?,?,?,?,?)')
    .run(sha(token), f.role, JSON.stringify(f.projectIds), actor.id, clock() + INVITE_MS);
  return token;
}

export function acceptInvite(db: Db, token: string, f: { name: string; email: string; password: string }): User {
  return tx(db, () => {
    const inv = db.prepare('SELECT * FROM invites WHERE token_hash=?').get(sha(token)) as
      | { role: OrgRole; project_ids_json: string; created_by: string; expires_at: number; disabled: number }
      | undefined;
    if (!inv || inv.disabled) throw new AppError(404, 'invite_invalid');
    if (inv.expires_at <= clock()) throw new AppError(410, 'invite_expired');
    const creator = db.prepare('SELECT disabled FROM users WHERE id=?').get(inv.created_by) as { disabled: number } | undefined;
    const cr = roleOf(db, inv.created_by);
    if (!creator || creator.disabled || (cr !== 'owner' && cr !== 'admin')) throw new AppError(404, 'invite_invalid');
    // The plan may have changed since the link was made: seats filled, or the Observer role no longer included.
    if (inv.role === 'observer') assertFeature(db, 'observerRole');
    assertSeatFor(db, inv.role);
    const user = insertUser(db, inv.role, f);
    if (inv.role === 'admin') db.prepare('UPDATE invites SET disabled=1 WHERE token_hash=?').run(sha(token));
    const grant = db.prepare('INSERT OR IGNORE INTO project_access (project_id,user_id,project_role) VALUES (?,?,NULL)');
    for (const pid of JSON.parse(inv.project_ids_json) as string[]) {
      if (db.prepare('SELECT 1 FROM projects WHERE id=?').get(pid)) grant.run(pid, user.id);
    }
    return user;
  });
}
