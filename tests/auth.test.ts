import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
import { createHash } from 'node:crypto';
import { openDb, newId, type Db } from '../server/db';
import {
  hashPassword, verifyPassword, setupWorkspace, login, sessionUser, logout,
  createInvite, acceptInvite, _limiterSize, _resetLimiter, _noteFailure, _limiterHas, setClock,
} from '../server/auth';
import { AppError } from '../server/errors';
import { DEFAULT_SETTINGS } from '../shared/types';

let db: Db;
let t: number;
const setup = () => setupWorkspace(db, { workspaceName: 'W', name: 'Own', email: 'o@x.io', password: 'pw-owner' });
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof AppError ? `${e.status}:${e.code}` : String(e); }
  return 'no throw';
};

beforeEach(() => {
  db = openDb(':memory:');
  t = 1_000_000;
  setClock(() => t);
  _resetLimiter();
});

describe('auth', () => {
  it('hash round trip', () => {
    const h = hashPassword('secret');
    expect(h).toMatch(/^scrypt\$[^$]+\$[^$]+$/);
    expect(verifyPassword('secret', h)).toBe(true);
    expect(verifyPassword('nope', h)).toBe(false);
  });

  it('setup only once', () => {
    const u = setup();
    expect(u).not.toHaveProperty('passwordHash');
    expect(code(setup)).toBe('409:already_setup');
    expect((db.prepare('SELECT COUNT(*) c FROM projects').get() as { c: number }).c).toBe(0);
    const a = db.prepare('SELECT settings_json FROM account').get() as { settings_json: string };
    expect(JSON.parse(a.settings_json)).toEqual({ ...DEFAULT_SETTINGS, sprintsEnabled: false, dependenciesEnabled: true });
    const r = db.prepare('SELECT role FROM account_roles WHERE user_id=?').get(u.id) as { role: string };
    expect(r.role).toBe('owner');
  });

  it('login and session', () => {
    const u = setup();
    expect(code(() => login(db, 'o@x.io', 'bad', '1.1.1.1'))).toBe('401:bad_credentials');
    const { token, user } = login(db, 'O@X.io', 'pw-owner', '1.1.1.1');
    expect(user.id).toBe(u.id);
    expect(sessionUser(db, token)?.id).toBe(u.id);
    expect(db.prepare('SELECT token_hash FROM sessions').get()).not.toEqual({ token_hash: token });
    logout(db, token);
    expect(sessionUser(db, token)).toBeNull();
    const s2 = login(db, 'o@x.io', 'pw-owner', '1.1.1.1');
    t += 1000 * 60 * 60 * 24 * 365;
    expect(sessionUser(db, s2.token)).toBeNull();
    expect(sessionUser(db, 'garbage')).toBeNull();
  });

  it('disabled user', () => {
    const u = setup();
    const { token } = login(db, 'o@x.io', 'pw-owner', '1.1.1.1');
    db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(u.id);
    expect(sessionUser(db, token)).toBeNull();
    expect(code(() => login(db, 'o@x.io', 'pw-owner', '1.1.1.1'))).toBe('401:bad_credentials');
  });

  it('lockout', () => {
    setup();
    for (let i = 0; i < 10; i++) expect(code(() => login(db, `u${i}@x.io`, 'bad', '1.2.3.4'))).toBe('401:bad_credentials');
    expect(code(() => login(db, 'o@x.io', 'pw-owner', '1.2.3.4'))).toBe('429:too_many_attempts');
    expect(login(db, 'o@x.io', 'pw-owner', '5.6.7.8').token).toBeTruthy();
    t += 5 * 60 * 1000 + 1;
    expect(login(db, 'o@x.io', 'pw-owner', '1.2.3.4').token).toBeTruthy();
  });

  it('limiter bounded', () => {
    setup();
    // scrypt makes 1500 real logins take ~1 min, so most IPs go through the limiter hook
    for (let i = 0; i < 20; i++) code(() => login(db, 'o@x.io', 'bad', `9.9.9.${i}`));
    for (let i = 0; i < 1500; i++) _noteFailure(`10.0.${i >> 8}.${i & 255}`);
    expect(_limiterSize()).toBeLessThanOrEqual(1000);
  });

  it('invite', () => {
    const owner = setup();
    const pid = newId();
    db.prepare("INSERT INTO projects (id,seq,name,spaces_json,created_at) VALUES (?,1,'P','[]',0)").run(pid);
    // member cannot invite
    const tokM = createInvite(db, owner, { role: 'member', projectIds: [] });
    const member = acceptInvite(db, tokM, { name: 'M', email: 'm@x.io', password: 'pw' });
    expect(code(() => createInvite(db, member, { role: 'member', projectIds: [] }))).toBe('403:forbidden');
    // admin can
    const tokA = createInvite(db, owner, { role: 'admin', projectIds: [] });
    const admin = acceptInvite(db, tokA, { name: 'A', email: 'a@x.io', password: 'pw' });
    const tok = createInvite(db, admin, { role: 'observer', projectIds: [pid] });
    expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((db.prepare('SELECT token_hash h FROM invites').all() as { h: string }[]).some((r) => r.h === tok)).toBe(false);
    const obs = acceptInvite(db, tok, { name: 'Ob', email: 'ob@x.io', password: 'pw' });
    const role = db.prepare('SELECT role FROM account_roles WHERE user_id=?').get(obs.id) as { role: string };
    expect(role.role).toBe('observer');
    const pa = db.prepare('SELECT * FROM project_access WHERE user_id=?').all(obs.id);
    expect(pa).toHaveLength(1);
    expect((pa[0] as { project_id: string }).project_id).toBe(pid);
    // reusable until expiry
    expect(acceptInvite(db, tok, { name: 'Ob2', email: 'ob2@x.io', password: 'pw' }).id).toBeTruthy();
    // duplicate email
    expect(code(() => acceptInvite(db, tok, { name: 'X', email: 'OB@x.io', password: 'pw' }))).toBe('409:email_taken');
    // expired
    t += 7 * 24 * 3600 * 1000 + 1;
    expect(code(() => acceptInvite(db, tok, { name: 'Z', email: 'z@x.io', password: 'pw' }))).toBe('410:invite_expired');
    expect(code(() => acceptInvite(db, 'unknown', { name: 'Z', email: 'z@x.io', password: 'pw' }))).toBe('404:invite_invalid');
  });

  const member = () => {
    const owner = db.prepare("SELECT * FROM users WHERE email='o@x.io'").get() as any;
    const tok = createInvite(db, { id: owner.id } as any, { role: 'member', projectIds: [] });
    return acceptInvite(db, tok, { name: 'M', email: 'm@x.io', password: 'pw' });
  };

  it('success does not reset the IP counter', () => {
    setup();
    member();
    for (let i = 0; i < 9; i++) code(() => login(db, 'o@x.io', 'bad', '4.4.4.4'));
    expect(login(db, 'm@x.io', 'pw', '4.4.4.4').token).toBeTruthy();
    expect(code(() => login(db, 'o@x.io', 'bad', '4.4.4.4'))).toBe('401:bad_credentials');
    expect(code(() => login(db, 'm@x.io', 'pw', '4.4.4.4'))).toBe('429:too_many_attempts');
  });

  it('locked IP survives cap pressure', () => {
    setup();
    for (let i = 0; i < 10; i++) code(() => login(db, `u${i}@x.io`, 'bad', '1.2.3.4'));
    for (let i = 0; i < 1500; i++) _noteFailure(`10.1.${i >> 8}.${i & 255}`);
    expect(_limiterSize()).toBeLessThanOrEqual(1000);
    expect(code(() => login(db, 'o@x.io', 'pw-owner', '1.2.3.4'))).toBe('429:too_many_attempts');
  });

  it('all slots locked: new IP still logs in, failure not recorded', () => {
    setup();
    for (let i = 0; i < 1000; i++) for (let j = 0; j < 10; j++) _noteFailure(`l${i}`);
    expect(_limiterSize()).toBe(1000);
    expect(login(db, 'o@x.io', 'pw-owner', 'fresh').token).toBeTruthy();
    expect(code(() => login(db, 'o@x.io', 'bad', 'fresh2'))).toBe('401:bad_credentials');
    expect(_limiterSize()).toBe(1000);
    expect(_limiterHas('fresh2')).toBe(false);
    expect(_limiterHas('l0')).toBe(true);
  });

  it('success at a full map neither inserts nor evicts', () => {
    setup();
    for (let i = 0; i < 1000; i++) _noteFailure(`f${i}`);
    expect(login(db, 'o@x.io', 'pw-owner', 'fresh').token).toBeTruthy();
    expect(_limiterSize()).toBe(1000);
    expect(_limiterHas('fresh')).toBe(false);
    expect(_limiterHas('f0')).toBe(true);
  });

  it('eviction removes the lowest-count unlocked entry', () => {
    for (let i = 0; i < 1000; i++) _noteFailure(`e${i}`);
    for (let j = 0; j < 4; j++) _noteFailure('e0'); // e0 count 5, oldest
    _noteFailure('new');
    expect(_limiterHas('new')).toBe(true);
    expect(_limiterHas('e0')).toBe(true);
    expect(_limiterHas('e1')).toBe(false); // oldest among count-1 ties
    expect(_limiterSize()).toBe(1000);
  });

  it('invite projectIds validated', () => {
    const owner = setup();
    for (const bad of ['abc', null, {}, [1], ['no-such-project']]) {
      expect(code(() => createInvite(db, owner, { role: 'member', projectIds: bad as any }))).toBe('400:invalid_payload');
    }
  });

  it('invite creator re-checked and admin invites single-use', () => {
    const owner = setup();
    const admin = acceptInvite(db, createInvite(db, owner, { role: 'admin', projectIds: [] }), { name: 'A', email: 'a@x.io', password: 'pw' });
    const t1 = createInvite(db, admin, { role: 'member', projectIds: [] });
    db.prepare("UPDATE account_roles SET role='member' WHERE user_id=?").run(admin.id);
    expect(code(() => acceptInvite(db, t1, { name: 'X', email: 'x@x.io', password: 'pw' }))).toBe('404:invite_invalid');
    db.prepare("UPDATE account_roles SET role='admin' WHERE user_id=?").run(admin.id);
    db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(admin.id);
    expect(code(() => acceptInvite(db, t1, { name: 'X', email: 'x@x.io', password: 'pw' }))).toBe('404:invite_invalid');
    const ta = createInvite(db, owner, { role: 'admin', projectIds: [] });
    acceptInvite(db, ta, { name: 'B', email: 'b@x.io', password: 'pw' });
    expect(code(() => acceptInvite(db, ta, { name: 'C', email: 'c@x.io', password: 'pw' }))).toBe('404:invite_invalid');
  });

  it('per-email limit across IPs, device token bypass', () => {
    const owner = setup();
    const dev = login(db, 'o@x.io', 'pw-owner', '2.2.2.2').deviceToken;
    const m = member();
    const otherDev = login(db, 'm@x.io', 'pw', '3.3.3.3').deviceToken;
    for (let i = 0; i < 10; i++) expect(code(() => login(db, 'o@x.io', 'bad', `7.7.7.${i}`))).toBe('401:bad_credentials');
    expect(code(() => login(db, 'o@x.io', 'pw-owner', '8.8.8.8'))).toBe('429:too_many_attempts');
    expect(code(() => login(db, 'o@x.io', 'pw-owner', '8.8.8.8', otherDev))).toBe('429:too_many_attempts');
    const r = login(db, 'o@x.io', 'pw-owner', '8.8.8.8', dev);
    expect(r.user.id).toBe(owner.id);
    expect(r.deviceToken).toBe(dev);
    expect(m.id).not.toBe(owner.id);
    // device token stored only as a hash
    expect((db.prepare('SELECT token_hash h FROM known_devices').all() as { h: string }[]).some((x) => x.h === dev)).toBe(false);
  });

  it('saturation bucket with known-device bypass', () => {
    setup();
    const dev = login(db, 'o@x.io', 'pw-owner', '2.2.2.2').deviceToken;
    for (let i = 0; i < 1000; i++) for (let j = 0; j < 10; j++) _noteFailure(`l${i}`);
    for (let i = 0; i < 10; i++) expect(code(() => login(db, `x${i}@x.io`, 'bad', `n${i}`))).toBe('401:bad_credentials');
    expect(_limiterHas('n0')).toBe(false);
    expect(code(() => login(db, 'o@x.io', 'pw-owner', 'n11'))).toBe('429:too_many_attempts');
    expect(login(db, 'o@x.io', 'pw-owner', 'n11', dev).token).toBeTruthy();
  });

  it('unknown-email spray never locks a real user out', () => {
    setup();
    for (let i = 0; i < 1500; i++) {
      _noteFailure(`spray${i}`);
    }
    for (let i = 0; i < 25; i++) code(() => login(db, 'ghost@x.io', 'bad', `g${i}`));
    for (let i = 0; i < 12; i++) code(() => login(db, `ghost${i}@x.io`, 'bad', `h${i}`));
    expect(login(db, 'o@x.io', 'pw-owner', 'fresh').token).toBeTruthy();
  });

  it('expired device token does not bypass and is replaced', () => {
    setup();
    const dev = login(db, 'o@x.io', 'pw-owner', '2.2.2.2').deviceToken;
    t += 366 * 24 * 3600 * 1000;
    for (let i = 0; i < 10; i++) code(() => login(db, 'o@x.io', 'bad', `7.7.7.${i}`));
    expect(code(() => login(db, 'o@x.io', 'pw-owner', '8.8.8.8', dev))).toBe('429:too_many_attempts');
    t += 5 * 60 * 1000 + 1;
    const r = login(db, 'o@x.io', 'pw-owner', '8.8.8.8', dev);
    expect(r.deviceToken).not.toBe(dev);
  });

  it('keeps at most 20 devices per user, pruning the oldest', () => {
    setup();
    const first = login(db, 'o@x.io', 'pw-owner', '2.2.2.2').deviceToken;
    for (let i = 0; i < 20; i++) {
      t += 1000;
      login(db, 'o@x.io', 'pw-owner', '2.2.2.2');
    }
    expect((db.prepare('SELECT COUNT(*) c FROM known_devices').get() as { c: number }).c).toBe(20);
    t += 1000;
    const h = createHash('sha256').update(first).digest('hex');
    expect(db.prepare('SELECT 1 FROM known_devices WHERE token_hash=?').get(h)).toBeUndefined();
  });
});
