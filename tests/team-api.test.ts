import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { createSession, hashPassword, setClock, _resetLimiter, SESSION_MS } from '../server/auth';
import type { TailscalePerson } from '../server/tailscale';

const HOST = 'localhost:8780';
const ORIGIN = 'http://localhost:8780';
const TS_IP = '100.101.1.2';
const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);
const OWNER: TailscalePerson = { login: 'owner@example.com', displayName: 'Owner' };
const ADMIN: TailscalePerson = { login: 'admin@example.com', displayName: 'Admin' };
const MEMBER: TailscalePerson = { login: 'mem@example.com', displayName: 'Mem' };
const TOKEN = 'launcher-secret-token';

let db: Db;
let app: ReturnType<typeof buildApp>;
let teamDir = '';
let peer: TailscalePerson | null = OWNER;
let published: unknown[][] = [];

function mkUser(email: string, role: string, extra: { tailscale?: string | null; disabled?: boolean; password?: boolean; createdAt?: number } = {}): string {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at,tailscale_login,disabled) VALUES (?,?,?,?,?,?,?)')
    .run(id, email, email.split('@')[0], extra.password === false ? '!' : hashPassword('pw'), extra.createdAt ?? T0 - 1000, extra.tailscale ?? null, extra.disabled ? 1 : 0);
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return id;
}
const idOf = (email: string) => (db.prepare('SELECT id FROM users WHERE email=?').get(email) as { id: string }).id;
const roleOf = (id: string) => (db.prepare('SELECT role FROM account_roles WHERE user_id=?').get(id) as { role: string }).role;
const teamFile = () => JSON.parse(readFileSync(join(teamDir, 'team.json'), 'utf8')) as { members: { login: string; role: string }[] };

type Opts = { as?: TailscalePerson | null; ip?: string; headers?: Record<string, string>; body?: unknown; raw?: boolean };
const WRITE = { 'content-type': 'application/json', 'x-jatify': '1' };
function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, o: Opts = {}) {
  if (o.as !== undefined) peer = o.as;
  const headers: Record<string, string> = { host: HOST, ...(method === 'GET' || o.raw ? {} : WRITE), ...o.headers };
  return app.inject({
    method, url, headers, remoteAddress: o.ip ?? TS_IP,
    ...(o.body === undefined ? {} : { payload: JSON.stringify(o.body) }),
  });
}
const members = async (as: TailscalePerson = OWNER) => (await call('GET', '/team/members', { as })).json().members as any[];

let ownerId = '';
let adminId = '';
let memberId = '';

beforeEach(async () => {
  _resetLimiter();
  setClock(() => T0);
  peer = OWNER;
  published = [];
  db = openDb(':memory:');
  const base = join(homedir(), '.cache/gametracker/scratch');
  mkdirSync(base, { recursive: true });
  teamDir = mkdtempSync(join(base, 'team-api-'));
  vi.stubEnv('JT_TEAM_FILE', join(teamDir, 'team.json'));
  vi.stubEnv('JATIFY_ADMIN_TOKEN', '');
  app = buildApp({ db, hosts: [HOST], tailscale: { enabled: true, socketPath: 'unused' }, tailscaleWhois: async () => peer });
  const pub = app.hub.publish.bind(app.hub);
  app.hub.publish = ((id: string, events: unknown[]) => { published.push(events); return pub(id, events as any); }) as typeof app.hub.publish;
  await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Owner', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  db.prepare('DELETE FROM sessions').run();
  ownerId = idOf('o@x.io');
  db.prepare('UPDATE users SET tailscale_login=?, created_at=? WHERE id=?').run(OWNER.login, T0 - 5000, ownerId);
  adminId = mkUser('a@x.io', 'admin', { tailscale: ADMIN.login });
  memberId = mkUser('m@x.io', 'member', { tailscale: MEMBER.login });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await app.close();
  setClock(() => Date.now());
  rmSync(teamDir, { recursive: true, force: true });
});

describe('identity', () => {
  it('any enabled member reads the list; disabled people, guests and strangers get 403 not_member', async () => {
    expect((await call('GET', '/team/members', { as: MEMBER })).statusCode).toBe(200);
    mkUser('d@x.io', 'member', { tailscale: 'd@example.com', disabled: true });
    mkUser('g@x.io', 'guest', { tailscale: 'g@example.com' });
    for (const login of ['d@example.com', 'g@example.com', 'stranger@example.com']) {
      const r = await call('GET', '/team/members', { as: { login, displayName: 'X' } });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: 'not_member', message: expect.any(String) });
    }
  });
  it('as /team/whoami: no Tailscale peer, a proxy header or the switch off is not_member', async () => {
    expect((await call('GET', '/team/members', { as: null })).statusCode).toBe(403);
    expect((await call('GET', '/team/members', { as: OWNER, ip: '127.0.0.1' })).json().error).toBe('not_member');
    expect((await call('GET', '/team/members', { as: OWNER, headers: { 'x-forwarded-for': '1.2.3.4' } })).statusCode).toBe(403);
    const off = buildApp({ db, hosts: [HOST], tailscale: { enabled: false, socketPath: 'unused' }, tailscaleWhois: async () => OWNER });
    expect((await off.inject({ method: 'GET', url: '/team/members', headers: { host: HOST }, remoteAddress: TS_IP })).statusCode).toBe(403);
    await off.close();
  });
  it('the Host allow-list still applies', async () => {
    expect((await call('GET', '/team/members', { headers: { host: 'evil.example:8780' } })).statusCode).toBe(421);
  });
  it('members can read but not write; requests are for managers', async () => {
    peer = MEMBER;
    expect((await call('GET', '/team/requests')).json()).toEqual({ error: 'forbidden', message: expect.any(String) });
    expect((await call('POST', '/team/members', { body: { login: 'n@example.com', role: 'member' } })).statusCode).toBe(403);
    expect((await call('PATCH', `/team/members/${MEMBER.login}`, { body: { role: 'observer' } })).json().error).toBe('forbidden');
    expect((await call('DELETE', `/team/members/${MEMBER.login}`)).statusCode).toBe(403);
    expect(roleOf(memberId)).toBe('member');
  });
});

describe('Review Focus 1: origin refused', () => {
  it('a web page (Origin, cookie) cannot change members, even same-origin with a valid session', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json', origin: ORIGIN }, remoteAddress: '127.0.0.1' });
    const cookie = `jt_session=${login.cookies.find((c: any) => c.name === 'jt_session')!.value}`;
    for (const origin of [ORIGIN, 'http://evil.example']) {
      for (const [method, url, body] of [
        ['POST', '/team/members', { login: 'n@example.com', role: 'admin' }],
        ['PATCH', `/team/members/${MEMBER.login}`, { role: 'admin' }],
        ['DELETE', `/team/members/${MEMBER.login}`, undefined],
        ['POST', '/team/requests/x@example.com/approve', { role: 'member' }],
      ] as const) {
        const r = await call(method, url, { as: OWNER, body, headers: { origin, cookie } });
        expect(r.statusCode, `${origin} ${method} ${url}`).toBe(403);
        expect(r.json()).toEqual({ error: 'cross_origin', message: expect.any(String) });
      }
    }
    expect(roleOf(memberId)).toBe('member');
    expect(db.prepare('SELECT disabled FROM users WHERE id=?').get(memberId)).toEqual({ disabled: 0 });
    expect(db.prepare('SELECT 1 FROM users WHERE tailscale_login=?').get('n@example.com')).toBeUndefined();
  });
  it('writes need X-Jatify: 1 and Content-Type: application/json; Sec-Fetch-Site cross-site is refused', async () => {
    const body = { role: 'observer' };
    const url = `/team/members/${MEMBER.login}`;
    expect((await call('PATCH', url, { body, raw: true, headers: { 'content-type': 'application/json' } })).json().error).toBe('cross_origin');
    expect((await call('PATCH', url, { body, raw: true, headers: { 'x-jatify': '1', 'content-type': 'text/plain' } })).json().error).toBe('cross_origin');
    expect((await call('PATCH', url, { body, raw: true, headers: { 'x-jatify': '1' } })).statusCode).toBe(403);
    expect((await call('PATCH', url, { body, headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
    expect(roleOf(memberId)).toBe('member');
  });
});

describe('GET /team/members', () => {
  it('enabled people: login (null for password-only), name, role, since, lastSeen from sessions', async () => {
    mkUser('pw@x.io', 'observer', { createdAt: T0 - 2000 });
    mkUser('gone@x.io', 'member', { tailscale: 'gone@example.com', disabled: true });
    mkUser('g@x.io', 'guest');
    setClock(() => T0 - 60_000);
    createSession(db, memberId, 'tailscale');
    setClock(() => T0 - 30_000);
    createSession(db, memberId, 'tailscale');
    setClock(() => T0);
    expect(await members(MEMBER)).toEqual([
      { login: OWNER.login, name: 'Owner', role: 'owner', since: new Date(T0 - 5000).toISOString(), lastSeen: null },
      { login: ADMIN.login, name: 'a', role: 'admin', since: new Date(T0 - 1000).toISOString(), lastSeen: null },
      { login: MEMBER.login, name: 'm', role: 'member', since: new Date(T0 - 1000).toISOString(), lastSeen: new Date(T0 - 30_000).toISOString() },
      { login: null, name: 'pw', role: 'observer', since: new Date(T0 - 2000).toISOString(), lastSeen: null },
    ]);
    expect(SESSION_MS).toBeGreaterThan(0);
  });
});

describe('GET /team/requests', () => {
  it('newest first, login, name, at', async () => {
    db.prepare('INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,?,?)').run('old@example.com', 'Old', 1000, 1000);
    db.prepare('INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,?,?)').run('new@example.com', 'New', 1000, 9000);
    for (const as of [OWNER, ADMIN]) {
      const r = await call('GET', '/team/requests', { as });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ requests: [
        { login: 'new@example.com', name: 'New', at: new Date(9000).toISOString() },
        { login: 'old@example.com', name: 'Old', at: new Date(1000).toISOString() },
      ] });
    }
  });
});

describe('POST /team/members', () => {
  it('adds a login who never asked: 201 with the entry, name defaults to the login, team.json and live events', async () => {
    const r = await call('POST', '/team/members', { body: { login: 'new@example.com', role: 'member' } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ login: 'new@example.com', name: 'new@example.com', role: 'member', since: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/), lastSeen: null });
    const named = await call('POST', '/team/members', { body: { login: 'b@example.com', name: 'Bea', role: 'observer' } });
    expect(named.json()).toMatchObject({ name: 'Bea', role: 'observer' });
    expect(teamFile().members.map((m) => m.login)).toContain('new@example.com');
    expect(db.prepare('SELECT COUNT(*) c FROM access_requests').get()).toEqual({ c: 0 });
    expect(published.flat()).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'accountRole', op: 'upsert' })]));
  });
  it('409 already_member for an enabled member', async () => {
    const r = await call('POST', '/team/members', { body: { login: MEMBER.login, role: 'member' } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'already_member', message: expect.any(String) });
  });
  it('re-adding a disabled login re-enables them with the role: 200', async () => {
    const id = mkUser('d@x.io', 'member', { tailscale: 'd@example.com', disabled: true });
    const r = await call('POST', '/team/members', { body: { login: 'd@example.com', role: 'observer' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ login: 'd@example.com', role: 'observer' });
    expect(db.prepare('SELECT disabled FROM users WHERE id=?').get(id)).toEqual({ disabled: 0 });
    expect(teamFile().members).toContainEqual({ login: 'd@example.com', name: 'd', role: 'observer' });
  });
  it('a pending request is approved by adding', async () => {
    db.prepare('INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,?,?)').run('p@example.com', 'P', 1, 1);
    expect((await call('POST', '/team/members', { body: { login: 'p@example.com', role: 'member' } })).statusCode).toBe(201);
    expect(db.prepare('SELECT COUNT(*) c FROM access_requests').get()).toEqual({ c: 0 });
  });
  it('400 invalid_payload for a missing login or bad role; a refused add leaves no request behind', async () => {
    expect((await call('POST', '/team/members', { body: { role: 'member' } })).json()).toEqual({ error: 'invalid_payload', message: expect.any(String) });
    expect((await call('POST', '/team/members', { body: { login: 'x@example.com', role: 'boss' } })).statusCode).toBe(400);
    mkUser('pw@x.io', 'member');
    // A password person whose email is the login: the approve command refuses (they link themselves).
    const r = await call('POST', '/team/members', { body: { login: 'pw@x.io', role: 'member' } });
    expect(r.json().error).toBe('already_member');
    expect(db.prepare('SELECT COUNT(*) c FROM access_requests').get()).toEqual({ c: 0 });
  });
});

describe('PATCH and DELETE /team/members/:login', () => {
  it('owner changes a role: 200 with the entry, team.json follows', async () => {
    const r = await call('PATCH', `/team/members/${encodeURIComponent(MEMBER.login)}`, { body: { role: 'admin' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ login: MEMBER.login, role: 'admin' });
    expect(teamFile().members).toContainEqual({ login: MEMBER.login, name: 'm', role: 'admin' });
  });
  it('404 not_found for an unknown or disabled login', async () => {
    mkUser('d@x.io', 'member', { tailscale: 'd@example.com', disabled: true });
    expect((await call('PATCH', '/team/members/nobody@example.com', { body: { role: 'member' } })).json()).toEqual({ error: 'not_found', message: expect.any(String) });
    expect((await call('DELETE', '/team/members/d@example.com')).statusCode).toBe(404);
  });
  it('a bodiless DELETE with Content-Type: application/json works', async () => {
    expect((await call('DELETE', `/team/members/${MEMBER.login}`)).statusCode).toBe(204);
  });
});

describe('Review Focus 2: an admin manages members and observers only', () => {
  beforeEach(() => { peer = ADMIN; });
  it('admin may add, change and remove members and observers', async () => {
    expect((await call('POST', '/team/members', { body: { login: 'n@example.com', role: 'observer' } })).statusCode).toBe(201);
    expect((await call('PATCH', '/team/members/n@example.com', { body: { role: 'member' } })).statusCode).toBe(200);
    expect((await call('DELETE', '/team/members/n@example.com')).statusCode).toBe(204);
  });
  it('admin cannot make anyone admin, through any route', async () => {
    db.prepare('INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,?,?)').run('q@example.com', 'Q', 1, 1);
    mkUser('d@x.io', 'member', { tailscale: 'd@example.com', disabled: true });
    const tries = [
      await call('POST', '/team/members', { body: { login: 'n@example.com', role: 'admin' } }),
      await call('POST', '/team/members', { body: { login: 'd@example.com', role: 'admin' } }),
      await call('PATCH', `/team/members/${MEMBER.login}`, { body: { role: 'admin' } }),
      await call('POST', '/team/requests/q@example.com/approve', { body: { role: 'admin' } }),
    ];
    for (const r of tries) expect(r.json()).toEqual({ error: 'forbidden', message: 'Only the owner can make or unmake an admin.' });
    expect(roleOf(memberId)).toBe('member');
    expect(db.prepare("SELECT COUNT(*) c FROM account_roles WHERE role='admin'").get()).toEqual({ c: 1 });
  });
  it('admin cannot unmake or remove an admin, themselves included', async () => {
    const other = mkUser('a2@x.io', 'admin', { tailscale: 'a2@example.com' });
    for (const login of [ADMIN.login, 'a2@example.com']) {
      expect((await call('PATCH', `/team/members/${login}`, { body: { role: 'member' } })).statusCode).toBe(403);
      expect((await call('DELETE', `/team/members/${login}`)).statusCode).toBe(403);
    }
    const gone = mkUser('a3@x.io', 'admin', { tailscale: 'a3@example.com', disabled: true });
    expect((await call('POST', '/team/members', { body: { login: 'a3@example.com', role: 'member' } })).statusCode).toBe(403);
    const unlinked = mkUser('a4@example.com', 'admin', { password: false });
    expect((await call('POST', '/team/members', { body: { login: 'a4@example.com', role: 'member' } })).statusCode).toBe(403);
    expect([roleOf(adminId), roleOf(other), roleOf(gone), roleOf(unlinked)]).toEqual(['admin', 'admin', 'admin', 'admin']);
  });
  it('admin cannot touch the owner', async () => {
    expect((await call('PATCH', `/team/members/${OWNER.login}`, { body: { role: 'member' } })).json().error).toBe('last_owner');
    expect((await call('DELETE', `/team/members/${OWNER.login}`)).json().error).toBe('last_owner');
    expect(roleOf(ownerId)).toBe('owner');
  });
  it('the owner may make and unmake admins', async () => {
    peer = OWNER;
    expect((await call('PATCH', `/team/members/${MEMBER.login}`, { body: { role: 'admin' } })).statusCode).toBe(200);
    expect((await call('PATCH', `/team/members/${ADMIN.login}`, { body: { role: 'member' } })).statusCode).toBe(200);
    expect((await call('DELETE', `/team/members/${MEMBER.login}`)).statusCode).toBe(204);
  });
});

describe('Review Focus 3: the admin token', () => {
  const asToken = (ip: string, headers: Record<string, string> = {}) =>
    call('GET', '/team/members', { as: null, ip, headers: { 'x-jatify-token': TOKEN, ...headers } });
  it('off without the env var (unset or empty)', async () => {
    expect((await asToken('127.0.0.1')).json().error).toBe('not_member');
    vi.stubEnv('JATIFY_ADMIN_TOKEN', undefined as unknown as string);
    delete process.env.JATIFY_ADMIN_TOKEN;
    expect((await asToken('127.0.0.1')).statusCode).toBe(403);
    expect((await call('GET', '/team/members', { as: null, ip: '127.0.0.1', headers: { 'x-jatify-token': '' } })).statusCode).toBe(403);
  });
  it('loopback with the right token acts as the owner, reads and writes', async () => {
    vi.stubEnv('JATIFY_ADMIN_TOKEN', TOKEN);
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect((await asToken(ip)).statusCode, ip).toBe(200);
    const r = await call('PATCH', `/team/members/${MEMBER.login}`, { as: null, ip: '127.0.0.1', headers: { 'x-jatify-token': TOKEN }, body: { role: 'admin' } });
    expect(r.statusCode).toBe(200);
    expect(roleOf(memberId)).toBe('admin');
    expect((await call('GET', '/team/requests', { as: null, ip: '127.0.0.1', headers: { 'x-jatify-token': TOKEN } })).statusCode).toBe(200);
  });
  it('never from a non-loopback peer, through a proxy, or with a wrong token', async () => {
    vi.stubEnv('JATIFY_ADMIN_TOKEN', TOKEN);
    for (const ip of [TS_IP, '198.51.100.5', '10.0.0.1']) expect((await asToken(ip)).statusCode, ip).toBe(403);
    expect((await asToken('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' })).statusCode).toBe(403);
    expect((await asToken('127.0.0.1', { 'x-jatify-token': `${TOKEN}x` })).statusCode).toBe(403);
    expect((await asToken('127.0.0.1', { 'x-jatify-token': TOKEN.slice(0, -1) })).statusCode).toBe(403);
    // A tailnet member sending the token is just themselves.
    const r = await call('PATCH', `/team/members/${MEMBER.login}`, { as: MEMBER, headers: { 'x-jatify-token': TOKEN }, body: { role: 'observer' } });
    expect(r.json().error).toBe('forbidden');
  });
});

describe('Review Focus 4: removing a member', () => {
  it('ends their sessions, drops them from team.json and from the list, keeps their history', async () => {
    createSession(db, memberId, 'tailscale');
    db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run('h', memberId, T0 + 1000);
    expect((await call('PATCH', `/team/members/${MEMBER.login}`, { body: { role: 'observer' } })).statusCode).toBe(200);
    expect(teamFile().members.map((m) => m.login)).toContain(MEMBER.login);
    expect((await call('DELETE', `/team/members/${MEMBER.login}`)).statusCode).toBe(204);
    expect(db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id=?').get(memberId)).toEqual({ c: 0 });
    expect(teamFile().members.map((m) => m.login)).not.toContain(MEMBER.login);
    expect((await members()).map((m) => m.login)).not.toContain(MEMBER.login);
    expect(db.prepare('SELECT disabled, tailscale_login FROM users WHERE id=?').get(memberId)).toEqual({ disabled: 1, tailscale_login: MEMBER.login });
    // They are no longer on the team for the API either.
    expect((await call('GET', '/team/members', { as: MEMBER })).statusCode).toBe(403);
    expect(published.flat()).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'user', op: 'upsert' })]));
  });
});

describe('Review Focus 5: owner_transfer and last_owner on every route', () => {
  it('role owner: 409 owner_transfer on POST, PATCH and approve, for the owner too', async () => {
    db.prepare('INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,?,?)').run('q@example.com', 'Q', 1, 1);
    mkUser('d@x.io', 'member', { tailscale: 'd@example.com', disabled: true });
    for (const as of [OWNER, ADMIN]) {
      peer = as;
      const tries = [
        await call('POST', '/team/members', { body: { login: 'n@example.com', role: 'owner' } }),
        await call('POST', '/team/members', { body: { login: 'd@example.com', role: 'owner' } }),
        await call('PATCH', `/team/members/${MEMBER.login}`, { body: { role: 'owner' } }),
        await call('PATCH', `/team/members/${OWNER.login}`, { body: { role: 'owner' } }),
        await call('POST', '/team/requests/q@example.com/approve', { body: { role: 'owner' } }),
      ];
      for (const r of tries) {
        expect(r.statusCode).toBe(409);
        expect(r.json()).toEqual({ error: 'owner_transfer', message: "Ownership moves in Questlog's settings (Danger zone)." });
      }
    }
    expect(db.prepare("SELECT user_id FROM account_roles WHERE role='owner'").all()).toEqual([{ user_id: ownerId }]);
  });
  it('changing or removing the owner: 409 last_owner, for the owner themselves too', async () => {
    for (const as of [OWNER, ADMIN]) {
      peer = as;
      for (const role of ['admin', 'member', 'observer']) {
        const r = await call('PATCH', `/team/members/${OWNER.login}`, { body: { role } });
        expect(r.statusCode).toBe(409);
        expect(r.json()).toEqual({ error: 'last_owner', message: expect.any(String) });
      }
      expect((await call('DELETE', `/team/members/${OWNER.login}`)).json().error).toBe('last_owner');
    }
    expect(roleOf(ownerId)).toBe('owner');
    expect(db.prepare('SELECT disabled FROM users WHERE id=?').get(ownerId)).toEqual({ disabled: 0 });
  });
});

describe('POST /team/requests/:login/approve and /deny', () => {
  beforeEach(() => {
    db.prepare('INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,?,?)').run('q@example.com', 'Quinn', 1, 1);
  });
  it('approve: 201 with the entry, the request is gone, team.json has them', async () => {
    const r = await call('POST', '/team/requests/q@example.com/approve', { as: ADMIN, body: { role: 'observer' } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ login: 'q@example.com', name: 'Quinn', role: 'observer', since: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/), lastSeen: null });
    expect(db.prepare('SELECT COUNT(*) c FROM access_requests').get()).toEqual({ c: 0 });
    expect(teamFile().members).toContainEqual({ login: 'q@example.com', name: 'Quinn', role: 'observer' });
  });
  it('approve without a request: 404', async () => {
    expect((await call('POST', '/team/requests/none@example.com/approve', { body: { role: 'member' } })).json().error).toBe('not_found');
  });
  it('deny: 204, the request is gone, nobody added', async () => {
    const r = await call('POST', '/team/requests/q@example.com/deny', { as: ADMIN });
    expect(r.statusCode).toBe(204);
    expect(db.prepare('SELECT COUNT(*) c FROM access_requests').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT 1 FROM users WHERE tailscale_login=?').get('q@example.com')).toBeUndefined();
  });
});

describe('seats and features as on the Members page', () => {
  const setFree = () => db.prepare("UPDATE account SET billing_mode='stripe', plan_type='free', plan_status='active', trial_ends_at=NULL").run();
  it('a full Free plan: 409 plan_limit for a member, 409 plan_feature for an observer, nothing left behind', async () => {
    setFree();
    mkUser('m2@x.io', 'member');
    mkUser('m3@x.io', 'member');
    const r = await call('POST', '/team/members', { body: { login: 'n@example.com', role: 'member' } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'plan_limit', message: expect.any(String) });
    expect((await call('POST', '/team/members', { body: { login: 'o@example.com', role: 'observer' } })).json().error).toBe('plan_feature');
    expect((await call('PATCH', `/team/members/${MEMBER.login}`, { body: { role: 'observer' } })).json().error).toBe('plan_feature');
    expect(db.prepare('SELECT COUNT(*) c FROM access_requests').get()).toEqual({ c: 0 });
    // Re-enabling takes a seat too.
    db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(memberId);
    mkUser('m4@x.io', 'member');
    expect((await call('POST', '/team/members', { body: { login: MEMBER.login, role: 'member' } })).json().error).toBe('plan_limit');
    expect(db.prepare('SELECT disabled FROM users WHERE id=?').get(memberId)).toEqual({ disabled: 1 });
  });
});

describe('every /team/ error carries a message', () => {
  it('423 workspace_disabled locks the members API, not whoami', async () => {
    db.prepare('UPDATE account SET is_disabled=1').run();
    for (const r of [
      await call('GET', '/team/members'),
      await call('POST', '/team/members', { body: { login: 'n@example.com', role: 'member' } }),
    ]) {
      expect(r.statusCode).toBe(423);
      expect(r.json()).toEqual({ error: 'workspace_disabled', message: expect.any(String) });
    }
    expect((await call('GET', '/team/whoami')).statusCode).toBe(200);
  });
  it('404 for an unknown /team/ path, with or without the web app served', async () => {
    for (const [method, url] of [['GET', '/team/nope'], ['POST', '/team/members/x/promote'], ['GET', '/team/members/x']] as const) {
      const r = await call(method, url, { body: method === 'POST' ? {} : undefined });
      expect(r.statusCode, url).toBe(404);
      expect(r.json()).toEqual({ error: 'no_route', message: expect.any(String) });
    }
    const webRoot = mkdtempSync(join(homedir(), '.cache/gametracker/scratch/team-api-web-'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Questlog</title>');
    const web = buildApp({ db, hosts: [HOST], webRoot, tailscale: { enabled: true, socketPath: 'unused' }, tailscaleWhois: async () => OWNER });
    try {
      const r = await web.inject({ method: 'GET', url: '/team/nope', headers: { host: HOST }, remoteAddress: TS_IP });
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ error: 'no_route', message: expect.any(String) });
      // Other paths still get the app.
      expect((await web.inject({ method: 'GET', url: '/teams', headers: { host: HOST }, remoteAddress: TS_IP })).body).toContain('<title>Questlog</title>');
    } finally {
      await web.close();
      rmSync(webRoot, { recursive: true, force: true });
    }
  });
  it('421 bad_host and 403 cross_origin from the shared hooks', async () => {
    expect((await call('GET', '/team/members', { headers: { host: 'evil.example:8780' } })).json()).toEqual({ error: 'bad_host', message: expect.any(String) });
    expect((await call('PATCH', `/team/members/${MEMBER.login}`, { body: { role: 'observer' }, headers: { origin: 'http://evil.example' } })).json())
      .toEqual({ error: 'cross_origin', message: expect.any(String) });
    // Outside /team/ the errors keep their old shape.
    expect((await call('GET', '/api/status', { headers: { host: 'evil.example:8780' } })).json()).toEqual({ error: 'bad_host' });
  });
});

describe('the owner is never relinked', () => {
  beforeEach(() => {
    // The owner, unlinked and passwordless, with an email that is a Tailscale login.
    db.prepare("UPDATE users SET tailscale_login=NULL, password_hash='!', email='boss@example.com' WHERE id=?").run(ownerId);
    db.prepare('INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,?,?)').run('boss@example.com', 'Boss', 1, 1);
  });
  it('POST /team/members and approve: 409 last_owner, nothing changes', async () => {
    vi.stubEnv('JATIFY_ADMIN_TOKEN', TOKEN);
    const asOwner = { as: null, ip: '127.0.0.1', headers: { 'x-jatify-token': TOKEN } };
    for (const o of [{ as: ADMIN }, asOwner]) {
      for (const r of [
        await call('POST', '/team/members', { ...o, body: { login: 'boss@example.com', role: 'member' } }),
        await call('POST', '/team/requests/boss@example.com/approve', { ...o, body: { role: 'member' } }),
      ]) {
        expect(r.statusCode).toBe(409);
        expect(r.json()).toEqual({ error: 'last_owner', message: expect.any(String) });
      }
    }
    expect(db.prepare('SELECT tailscale_login FROM users WHERE id=?').get(ownerId)).toEqual({ tailscale_login: null });
    expect(roleOf(ownerId)).toBe('owner');
  });
});

describe('POST /team/members name', () => {
  it("without a name: a pending request's display name, else the login; a given name wins", async () => {
    db.prepare('INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,?,?)').run('p@example.com', 'Pat', 1, 1);
    db.prepare('INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,?,?)').run('r@example.com', 'Robin', 1, 1);
    expect((await call('POST', '/team/members', { body: { login: 'p@example.com', role: 'member' } })).json().name).toBe('Pat');
    expect((await call('POST', '/team/members', { body: { login: 'r@example.com', name: 'Rob', role: 'member' } })).json().name).toBe('Rob');
    expect((await call('POST', '/team/members', { body: { login: 'z@example.com', role: 'member' } })).json().name).toBe('z@example.com');
  });
});
