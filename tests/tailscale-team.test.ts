import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, setClock, _resetLimiter } from '../server/auth';
import type { TailscalePerson } from '../server/tailscale';
import pkg from '../package.json' with { type: 'json' };

const HOST = 'localhost:8780';
const ORIGIN = 'http://localhost:8780';
const TS_IP = '100.101.1.2';
const ADA: TailscalePerson = { login: 'ada@example.com', displayName: 'Ada' };
const json = { host: HOST, 'content-type': 'application/json' };
const page = { host: HOST, accept: 'text/html,application/xhtml+xml' };

let db: Db;
let app: ReturnType<typeof buildApp>;
let webRoot = '';
let teamDir = '';
let answer: TailscalePerson | null = ADA;
let ownerCookie = '';

const sessionCookie = (res: any) => res.cookies.find((c: any) => c.name === 'jt_session');
const cookieOf = (res: any) => `jt_session=${sessionCookie(res).value}`;
const teamFile = () => join(teamDir, 'team.json');
const readTeam = () => JSON.parse(readFileSync(teamFile(), 'utf8'));

function mkUser(email: string, password = 'pw-user', role = 'member', extra: { tailscale?: string; disabled?: boolean } = {}): string {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at,tailscale_login,disabled) VALUES (?,?,?,?,0,?,?)')
    .run(id, email, email.split('@')[0], hashPassword(password), extra.tailscale ?? null, extra.disabled ? 1 : 0);
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return id;
}
const signIn = async (email: string, password: string) =>
  cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { email, password }, headers: { ...json, origin: ORIGIN }, remoteAddress: '127.0.0.1' }));
const send = (cookie: string, name: string, payload: object) =>
  app.inject({ method: 'POST', url: `/dispatch/${name}`, payload, headers: { ...json, origin: ORIGIN, cookie }, remoteAddress: '127.0.0.1' });
const list = (cookie: string) =>
  app.inject({ method: 'GET', url: '/api/team-requests', headers: { host: HOST, cookie }, remoteAddress: '127.0.0.1' });
const whoami = (ip = TS_IP, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: '/team/whoami', headers: { host: HOST, ...headers }, remoteAddress: ip });
const ask = (p: TailscalePerson) => { answer = p; return app.inject({ method: 'GET', url: '/', headers: page, remoteAddress: TS_IP }); };
const idOf = (email: string) => (db.prepare('SELECT id FROM users WHERE email=?').get(email) as { id: string }).id;
const ownerId = () => idOf('o@x.io');

beforeEach(async () => {
  _resetLimiter();
  setClock(() => 1_000_000);
  answer = ADA;
  db = openDb(':memory:');
  const base = join(homedir(), '.cache/gametracker/scratch');
  mkdirSync(base, { recursive: true });
  webRoot = mkdtempSync(join(base, 'tailscale-team-'));
  teamDir = mkdtempSync(join(base, 'team-file-'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Questlog</title>');
  app = buildApp({
    db, hosts: [HOST], webRoot,
    tailscale: { enabled: true, socketPath: 'unused' },
    tailscaleWhois: async () => answer,
  });
  await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Owner', email: 'o@x.io', password: 'pw-owner' }, headers: json });
  db.prepare('DELETE FROM sessions').run();
  ownerCookie = await signIn('o@x.io', 'pw-owner');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await app.close();
  setClock(() => Date.now());
  for (const d of [webRoot, teamDir]) { try { chmodSync(d, 0o755); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); }
});

describe('GET /team/whoami', () => {
  it('a linked member: login, name, role, service and version', async () => {
    mkUser('ada@x.io', 'pw', 'member', { tailscale: 'ada@example.com' });
    const r = await whoami();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ login: 'ada@example.com', name: 'Ada', role: 'member', service: 'questlog', version: pkg.version });
  });
  it('needs no cookie and is not the ask-the-owner page', async () => {
    const r = await app.inject({ method: 'GET', url: '/team/whoami', headers: { ...page }, remoteAddress: TS_IP });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    expect(db.prepare('SELECT COUNT(*) c FROM access_requests').get()).toEqual({ c: 0 });
  });
  it('an unknown peer: role null', async () => {
    expect((await whoami()).json()).toEqual({ login: 'ada@example.com', name: 'Ada', role: null, service: 'questlog', version: pkg.version });
  });
  it('a disabled member is not on the team: role null', async () => {
    mkUser('ada@x.io', 'pw', 'member', { tailscale: 'ada@example.com', disabled: true });
    expect((await whoami()).json().role).toBeNull();
  });
  it('404 not_tailscale from 127.0.0.1, behind a proxy, and with the switch off', async () => {
    const a = await whoami('127.0.0.1');
    expect(a.statusCode).toBe(404);
    expect(a.json()).toEqual({ error: 'not_tailscale' });
    expect((await whoami(TS_IP, { 'x-forwarded-for': '1.2.3.4' })).statusCode).toBe(404);
    const off = buildApp({ db, hosts: [HOST], tailscale: { enabled: false, socketPath: 'unused' }, tailscaleWhois: async () => ADA });
    expect((await off.inject({ method: 'GET', url: '/team/whoami', headers: { host: HOST }, remoteAddress: TS_IP })).statusCode).toBe(404);
    await off.close();
  });
});

describe('approving requests', () => {
  it('the list: newest last_seen first, owner only', async () => {
    let t = 1000;
    setClock(() => t);
    await ask({ login: 'old@example.com', displayName: 'Old' });
    t = 5000;
    await ask({ login: 'new@example.com', displayName: 'New' });
    const r = await list(ownerCookie);
    expect(r.statusCode).toBe(200);
    expect(r.json().requests.map((x: any) => x.login)).toEqual(['new@example.com', 'old@example.com']);
    expect(r.json().requests[0]).toEqual({ login: 'new@example.com', displayName: 'New', firstSeen: 5000, lastSeen: 5000 });
    mkUser('m@x.io', 'pw-m');
    expect((await list(await signIn('m@x.io', 'pw-m'))).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/team-requests', headers: { host: HOST }, remoteAddress: '127.0.0.1' })).statusCode).toBe(401);
  });

  it('owner approves: a member who gets a Tailscale session and cannot use a password', async () => {
    await ask(ADA);
    const r = await send(ownerCookie, 'teamRequests/approve', { login: ADA.login, role: 'member' });
    expect(r.statusCode).toBe(200);
    const u = db.prepare('SELECT * FROM users WHERE tailscale_login=?').get(ADA.login) as any;
    expect(u).toMatchObject({ email: ADA.login, name: 'Ada', tailscale_login: ADA.login, kind: 'person', disabled: 0 });
    expect(db.prepare('SELECT role FROM account_roles WHERE user_id=?').get(u.id)).toEqual({ role: 'member' });
    expect(db.prepare('SELECT COUNT(*) c FROM access_requests').get()).toEqual({ c: 0 });
    const home = await app.inject({ method: 'GET', url: '/', headers: page, remoteAddress: TS_IP });
    expect(home.statusCode).toBe(200);
    expect(sessionCookie(home)).toBeTruthy();
    for (const pw of ['', 'x', '!', ADA.login, 'pw-owner', 'unusable']) {
      _resetLimiter();
      const l = await app.inject({ method: 'POST', url: '/api/login', payload: { email: ADA.login, password: pw }, headers: { ...json, origin: ORIGIN }, remoteAddress: '127.0.0.1' });
      expect(l.statusCode).toBe(401);
    }
  });

  it('an admin may approve; a plain member gets 403 and nothing changes', async () => {
    await ask(ADA);
    mkUser('m@x.io', 'pw-m');
    const r = await send(await signIn('m@x.io', 'pw-m'), 'teamRequests/approve', { login: ADA.login, role: 'member' });
    expect(r.statusCode).toBe(403);
    expect(db.prepare('SELECT COUNT(*) c FROM access_requests').get()).toEqual({ c: 1 });
    mkUser('a@x.io', 'pw-a', 'admin');
    expect((await send(await signIn('a@x.io', 'pw-a'), 'teamRequests/approve', { login: ADA.login, role: 'member' })).statusCode).toBe(200);
  });

  it('dismiss by a plain member is 403', async () => {
    await ask(ADA);
    mkUser('m@x.io', 'pw-m');
    expect((await send(await signIn('m@x.io', 'pw-m'), 'teamRequests/dismiss', { login: ADA.login })).statusCode).toBe(403);
    expect(db.prepare('SELECT COUNT(*) c FROM access_requests').get()).toEqual({ c: 1 });
  });

  it('observer without the observerRole feature: the same error as invites/create', async () => {
    await ask(ADA);
    db.prepare("UPDATE account SET billing_mode='stripe', plan_type='free', plan_status='active', trial_ends_at=NULL").run();
    const inv = await send(ownerCookie, 'invites/create', { role: 'observer', projectIds: [] });
    const r = await send(ownerCookie, 'teamRequests/approve', { login: ADA.login, role: 'observer' });
    expect(r.statusCode).toBe(inv.statusCode);
    expect(r.json()).toEqual(inv.json());
    expect(r.json()).toEqual({ error: 'plan_feature', data: { feature: 'observerRole' } });
  });

  it('the seat limit is respected', async () => {
    await ask(ADA);
    db.prepare("UPDATE account SET billing_mode='stripe', plan_type='free', plan_status='active', trial_ends_at=NULL").run();
    for (let i = 0; i < 4; i++) mkUser(`m${i}@x.io`);
    const r = await send(ownerCookie, 'teamRequests/approve', { login: ADA.login, role: 'member' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'plan_limit', data: { limit: 'users' } });
    expect(db.prepare('SELECT COUNT(*) c FROM access_requests').get()).toEqual({ c: 1 });
  });

  it('approving twice: 409 already_member; an existing email or link too', async () => {
    await ask(ADA);
    expect((await send(ownerCookie, 'teamRequests/approve', { login: ADA.login, role: 'member' })).statusCode).toBe(200);
    db.prepare('INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,1,1)').run(ADA.login, 'Ada');
    const again = await send(ownerCookie, 'teamRequests/approve', { login: ADA.login, role: 'member' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already_member');
    mkUser('bob@example.com');
    db.prepare('INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,1,1)').run('Bob@Example.com', 'Bob');
    expect((await send(ownerCookie, 'teamRequests/approve', { login: 'Bob@Example.com', role: 'member' })).json().error).toBe('already_member');
    expect((await send(ownerCookie, 'teamRequests/approve', { login: 'nobody@example.com', role: 'member' })).statusCode).toBe(404);
  });

  it('unlink then a new request: approving reconnects the same account', async () => {
    await ask(ADA);
    expect((await send(ownerCookie, 'teamRequests/approve', { login: ADA.login, role: 'member' })).statusCode).toBe(200);
    const id = idOf(ADA.login);
    const first = await app.inject({ method: 'GET', url: '/', headers: page, remoteAddress: TS_IP });
    expect(sessionCookie(first)).toBeTruthy();
    expect((await send(ownerCookie, 'users/unlinkTailscale', { userId: id })).statusCode).toBe(200);
    // Signed out and unknown again: the next page load asks to join.
    const asked = await ask(ADA);
    expect(sessionCookie(asked)).toBeFalsy();
    expect(db.prepare('SELECT login FROM access_requests').all()).toEqual([{ login: ADA.login }]);
    const r = await send(ownerCookie, 'teamRequests/approve', { login: ADA.login, role: 'admin' });
    expect(r.statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) c FROM users WHERE email=?').get(ADA.login)).toEqual({ c: 1 });
    expect(db.prepare('SELECT id, tailscale_login t FROM users WHERE email=?').get(ADA.login)).toEqual({ id, t: ADA.login });
    expect(db.prepare('SELECT role FROM account_roles WHERE user_id=?').get(id)).toEqual({ role: 'admin' });
    expect(db.prepare('SELECT COUNT(*) c FROM access_requests').get()).toEqual({ c: 0 });
    const again = await app.inject({ method: 'GET', url: '/', headers: page, remoteAddress: TS_IP });
    expect(sessionCookie(again)).toBeTruthy();
    const me = await app.inject({ method: 'GET', url: '/api/tailscale', headers: { host: HOST, cookie: cookieOf(again) }, remoteAddress: TS_IP });
    expect(me.json()).toMatchObject({ linkedUserId: id, sessionVia: 'tailscale' });
  });

  it('reconnecting a disabled account: 409 disabled_member, nothing changes', async () => {
    await ask(ADA);
    await send(ownerCookie, 'teamRequests/approve', { login: ADA.login, role: 'member' });
    const id = idOf(ADA.login);
    await send(ownerCookie, 'users/unlinkTailscale', { userId: id });
    await send(ownerCookie, 'users/disable', { userId: id, disabled: true });
    db.prepare('INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,1,1)').run(ADA.login, 'Ada');
    const r = await send(ownerCookie, 'teamRequests/approve', { login: ADA.login, role: 'member' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('disabled_member');
    expect(db.prepare('SELECT tailscale_login t, disabled d FROM users WHERE id=?').get(id)).toEqual({ t: null, d: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM access_requests').get()).toEqual({ c: 1 });
  });

  it('a guest or service user with that email is never linked: 409 already_member', async () => {
    for (const [email, role, kind] of [['gus@example.com', 'guest', 'person'], ['bot@example.com', 'member', 'service']]) {
      const id = newId();
      db.prepare("INSERT INTO users (id,email,name,password_hash,created_at,kind) VALUES (?,?,?,'!',0,?)").run(id, email, 'x', kind);
      db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
      db.prepare('INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,1,1)').run(email, 'x');
      const r = await send(ownerCookie, 'teamRequests/approve', { login: email, role: 'member' });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('already_member');
      expect(db.prepare('SELECT tailscale_login t FROM users WHERE id=?').get(id)).toEqual({ t: null });
    }
  });

  it('dismiss removes the request', async () => {
    await ask(ADA);
    expect((await send(ownerCookie, 'teamRequests/dismiss', { login: ADA.login })).statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) c FROM access_requests').get()).toEqual({ c: 0 });
    expect((await list(ownerCookie)).json().requests).toEqual([]);
  });

  it('API tokens cannot approve', async () => {
    const { TOKEN_DENIED_NAMESPACES } = await import('../server/tokens');
    expect(TOKEN_DENIED_NAMESPACES.has('teamRequests')).toBe(true);
  });
});

describe('users/unlinkTailscale', () => {
  const linkedOf = (id: string) => (db.prepare('SELECT tailscale_login t FROM users WHERE id=?').get(id) as { t: string | null }).t;

  it('there is no command that sets a login', async () => {
    const m = mkUser('m@x.io');
    const r = await send(ownerCookie, 'users/setTailscaleLogin', { userId: m, login: 'm@example.com' });
    expect(r.statusCode).toBe(404);
    expect(linkedOf(m)).toBeNull();
  });

  it('an admin unlinks a member; unlinking someone not linked is a no-op', async () => {
    mkUser('a@x.io', 'pw-a', 'admin');
    const m = mkUser('m@x.io', 'pw-m', 'member', { tailscale: 'm@example.com' });
    const cookie = await signIn('a@x.io', 'pw-a');
    expect((await send(cookie, 'users/unlinkTailscale', { userId: m })).statusCode).toBe(200);
    expect(linkedOf(m)).toBeNull();
    expect((await send(cookie, 'users/unlinkTailscale', { userId: m })).statusCode).toBe(200);
    expect((await send(cookie, 'users/unlinkTailscale', { userId: 'nope' })).statusCode).toBe(404);
  });

  it('a member cannot unlink someone else, but unlinks themselves', async () => {
    const m = mkUser('m@x.io', 'pw-m', 'member', { tailscale: 'm@example.com' });
    const other = mkUser('n@x.io', 'pw-n', 'member', { tailscale: 'n@example.com' });
    const cookie = await signIn('m@x.io', 'pw-m');
    expect((await send(cookie, 'users/unlinkTailscale', { userId: other })).statusCode).toBe(403);
    expect(linkedOf(other)).toBe('n@example.com');
    expect((await send(cookie, 'users/unlinkTailscale', { userId: m })).statusCode).toBe(200);
    expect(linkedOf(m)).toBeNull();
  });

  it('the owner row is unlinked by the owner only', async () => {
    db.prepare('UPDATE users SET tailscale_login=? WHERE id=?').run('o@example.com', ownerId());
    mkUser('a@x.io', 'pw-a', 'admin');
    const cookie = await signIn('a@x.io', 'pw-a');
    expect((await send(cookie, 'users/unlinkTailscale', { userId: ownerId() })).statusCode).toBe(403);
    expect(linkedOf(ownerId())).toBe('o@example.com');
    expect((await send(ownerCookie, 'users/unlinkTailscale', { userId: ownerId() })).statusCode).toBe(200);
    expect(linkedOf(ownerId())).toBeNull();
  });

  it('ends the Tailscale session (401 on the snapshot); a password session of the same user stays', async () => {
    const m = mkUser('ada@x.io', 'pw-ada', 'member', { tailscale: 'ada@example.com' });
    const viaTs = cookieOf(await app.inject({ method: 'GET', url: '/', headers: page, remoteAddress: TS_IP }));
    const viaPw = await signIn('ada@x.io', 'pw-ada');
    const snap = (cookie: string) => app.inject({ method: 'GET', url: '/api/snapshot', headers: { host: HOST, cookie }, remoteAddress: '127.0.0.1' });
    expect((await snap(viaTs)).statusCode).toBe(200);
    expect((await send(ownerCookie, 'users/unlinkTailscale', { userId: m })).statusCode).toBe(200);
    expect((await snap(viaTs)).statusCode).toBe(401);
    expect((await snap(viaPw)).statusCode).toBe(200);
  });

  it('syncs the team file', async () => {
    vi.stubEnv('JT_TEAM_FILE', teamFile());
    const m = mkUser('m@x.io', 'pw-m', 'member', { tailscale: 'm@example.com' });
    await send(ownerCookie, 'users/unlinkTailscale', { userId: m });
    expect(readTeam().members).toEqual([]);
  });
});

describe('the team file', () => {
  beforeEach(() => { vi.stubEnv('JT_TEAM_FILE', teamFile()); });

  it('after approve: that person, sorted by login, with the file shape', async () => {
    await ask({ login: 'zed@example.com', displayName: 'Zed' });
    await ask(ADA);
    await send(ownerCookie, 'teamRequests/approve', { login: 'zed@example.com', role: 'admin' });
    await send(ownerCookie, 'teamRequests/approve', { login: ADA.login, role: 'member' });
    const f = readTeam();
    expect(f).toMatchObject({ version: 1, writer: 'questlog' });
    expect(Number.isNaN(Date.parse(f.updated))).toBe(false);
    expect(f.members).toEqual([
      { login: 'ada@example.com', name: 'Ada', role: 'member' },
      { login: 'zed@example.com', name: 'Zed', role: 'admin' },
    ]);
    expect(readdirSync(teamDir)).toEqual(['team.json']);
  });

  it('only people with a login: the owner without one is not listed', async () => {
    await ask(ADA);
    await send(ownerCookie, 'teamRequests/approve', { login: ADA.login, role: 'member' });
    expect(readTeam().members.map((m: any) => m.login)).toEqual(['ada@example.com']);
  });

  it('after disable the person is gone, after enable back', async () => {
    await ask(ADA);
    await send(ownerCookie, 'teamRequests/approve', { login: ADA.login, role: 'member' });
    const id = idOf(ADA.login);
    await send(ownerCookie, 'users/disable', { userId: id, disabled: true });
    expect(readTeam().members).toEqual([]);
    await send(ownerCookie, 'users/disable', { userId: id, disabled: false });
    expect(readTeam().members).toHaveLength(1);
  });

  it('after setRole the new role', async () => {
    await ask(ADA);
    await send(ownerCookie, 'teamRequests/approve', { login: ADA.login, role: 'member' });
    await send(ownerCookie, 'users/setRole', { userId: idOf(ADA.login), role: 'admin' });
    expect(readTeam().members[0].role).toBe('admin');
  });

  it('sorted by plain string order of the login', async () => {
    mkUser('b@x.io', 'pw', 'member', { tailscale: 'Zed@example.com' });
    mkUser('c@x.io', 'pw', 'member', { tailscale: 'ada@example.com' });
    mkUser('d@x.io', 'pw', 'member', { tailscale: 'Bob@example.com' });
    await send(ownerCookie, 'users/setRole', { userId: idOf('d@x.io'), role: 'admin' });
    expect(readTeam().members.map((m: any) => m.login)).toEqual(['Bob@example.com', 'Zed@example.com', 'ada@example.com']);
  });

  it('linking yourself through /api/tailscale/link adds you to the file', async () => {
    mkUser('ada@x.io', 'pw-ada');
    const c = await signIn('ada@x.io', 'pw-ada');
    const r = await app.inject({ method: 'POST', url: '/api/tailscale/link', payload: { password: 'pw-ada' }, headers: { ...json, origin: ORIGIN, cookie: c }, remoteAddress: TS_IP });
    expect(r.statusCode).toBe(200);
    expect(readTeam().members).toEqual([{ login: 'ada@example.com', name: 'ada', role: 'member' }]);
  });

  it('unset: no file is written', async () => {
    vi.unstubAllEnvs();
    await ask(ADA);
    await send(ownerCookie, 'teamRequests/approve', { login: ADA.login, role: 'member' });
    expect(existsSync(teamFile())).toBe(false);
    expect(readdirSync(teamDir)).toEqual([]);
  });

  it('a read-only folder: error logged, no partial file, the command still succeeds', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await ask(ADA);
    chmodSync(teamDir, 0o555);
    const r = await send(ownerCookie, 'teamRequests/approve', { login: ADA.login, role: 'member' });
    expect(r.statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) c FROM users WHERE tailscale_login=?').get(ADA.login)).toEqual({ c: 1 });
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toContain('team file');
    chmodSync(teamDir, 0o755);
    expect(readdirSync(teamDir)).toEqual([]);
  });

  it('writeTeamFile replaces an existing file atomically', async () => {
    const { writeTeamFile } = await import('../server/teamFile');
    writeFileSync(teamFile(), 'old');
    writeTeamFile(db, teamFile());
    expect(readTeam().members).toEqual([]);
    expect(readdirSync(teamDir)).toEqual(['team.json']);
  });
});
